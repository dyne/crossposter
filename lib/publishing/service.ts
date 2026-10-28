import "server-only";
import { postLimitIssuesForTargets, titleLimitIssues } from "@/lib/platform-limits";
import { defaultTargets, targetLimitInput, type ConfigValueLookup } from "./contracts";
import type { ProviderRegistry } from "./provider";
import type {
  Platform,
  ProviderContext,
  PublishedMedia,
  PublishedPost,
  PublishPayload,
  PublishResult
} from "@/lib/types";

export type PublishRunInput = PublishPayload & {
  now?: Date;
  requestUrl?: string;
};

export type PublishRunResult = {
  results: PublishResult[];
  publishedPost?: PublishedPost;
  media?: PublishedMedia;
};

export type PublishDependencies = {
  providers: ProviderRegistry;
  getConfigValue: ConfigValueLookup;
  getProfileConfigIssues: (platform: Platform, profileId?: string) => { message: string }[];
  getUploadedMedia: (id: string, requestUrl?: string) => Promise<ProviderContext["media"]>;
  appendPublishedPost: (post: PublishedPost) => PublishedPost | undefined;
  now: () => Date;
  createId: () => string;
};

function publishedMediaFromContext(media: ProviderContext["media"]): PublishedMedia | undefined {
  if (!media) {
    return undefined;
  }

  return {
    id: media.id,
    filename: media.filename,
    contentType: media.contentType,
    size: media.size,
    kind: media.kind,
    url: media.url
  };
}

export function createPublishService(dependencies: PublishDependencies) {
  return async function runPublish(input: PublishRunInput): Promise<PublishRunResult> {
    const targets = defaultTargets(input);
    const platforms = Array.from(new Set(targets.map((target) => target.platform)));
    const limitIssues = [
      ...titleLimitIssues(platforms, input.title || ""),
      ...postLimitIssuesForTargets(
        targets.map((target) => targetLimitInput(target, dependencies.getConfigValue)), input.text
      )
    ];
    const now = input.now || dependencies.now();
    let media: ProviderContext["media"] | undefined;

    if (limitIssues.length > 0) {
      throw new Error(limitIssues[0].message);
    }

    if (input.mediaId) {
      media = await dependencies.getUploadedMedia(input.mediaId, input.requestUrl);
    }

    const ctx: ProviderContext = {
      title: input.title?.trim() || undefined,
      text: input.text.trim(),
      linkUrl: input.linkUrl?.trim() || undefined,
      mediaId: input.mediaId || undefined,
      mediaUrl: input.mediaUrl || undefined,
      media,
      platforms,
      targets,
      now
    };

    const results = await Promise.all(
      targets.map(async (target): Promise<PublishResult> => {
        const targetCtx: ProviderContext = {
          ...ctx,
          platforms: [target.platform],
          target
        };
        const configError = dependencies.getProfileConfigIssues(target.platform, target.profileId)
          .map((issue) => issue.message).slice(0, 2).join("; ");

        if (configError) {
          return {
            platform: target.platform,
            targetId: target.id,
            profileId: target.profileId,
            profileLabel: target.profileLabel,
            ok: false,
            message: configError
          };
        }

        try {
          const result = await dependencies.providers[target.platform](targetCtx);

          return {
            ...result,
            platform: target.platform,
            targetId: result.targetId || target.id,
            profileId: result.profileId || target.profileId,
            profileLabel: result.profileLabel || target.profileLabel
          };
        } catch (error) {
          const uncertain =
            error instanceof Error &&
            "uncertain" in error &&
            (error as Error & { uncertain?: boolean }).uncertain === true;

          return {
            platform: target.platform,
            targetId: target.id,
            profileId: target.profileId,
            profileLabel: target.profileLabel,
            ok: false,
            ...(uncertain ? { uncertain: true } : {}),
            message: error instanceof Error ? error.message : "Unknown error"
          };
        }
      })
    );
    const publishedMedia = publishedMediaFromContext(media);
    const publishedPost = dependencies.appendPublishedPost({
      id: dependencies.createId(),
      createdAt: now.toISOString(),
      ...(ctx.title ? { title: ctx.title } : {}),
      text: ctx.text,
      ...(ctx.linkUrl ? { linkUrl: ctx.linkUrl } : {}),
      platforms,
      targets,
      results,
      ...(publishedMedia ? { media: publishedMedia } : {})
    } satisfies PublishedPost);

    return {
      results,
      publishedPost,
      ...(publishedMedia ? { media: publishedMedia } : {})
    };
  };
}
