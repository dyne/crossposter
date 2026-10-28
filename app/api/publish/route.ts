import { NextResponse } from "next/server";
import { createPublishRequestSchema, requestValidationMessage } from "@/lib/publishing/contracts";
import { getConfigValue } from "@/lib/local-config";
import { runPublish } from "@/lib/publish-runner";
import { requestOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";
export const maxDuration = 900;

const requestSchema = createPublishRequestSchema(getConfigValue);

export async function POST(request: Request) {
  const requirePasswordSetting = getConfigValue("POSTER_REQUIRE_ADMIN_PASSWORD");
  const requiresPassword =
    requirePasswordSetting === "true" ||
    (process.env.NODE_ENV === "production" &&
      requirePasswordSetting !== "false");
  const configuredPassword = getConfigValue("POSTER_ADMIN_PASSWORD");

  if (requiresPassword && !configuredPassword) {
    return NextResponse.json(
      { error: "Server is missing POSTER_ADMIN_PASSWORD" },
      { status: 500 }
    );
  }

  const parsed = requestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: requestValidationMessage(parsed.error, "publish") }, { status: 400 });
  }

  if (requiresPassword && parsed.data.adminPassword !== configuredPassword) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { results, publishedPost } = await runPublish({
      title: parsed.data.title,
      text: parsed.data.text,
      linkUrl: parsed.data.linkUrl,
      mediaId: parsed.data.mediaId || undefined,
      mediaUrl: parsed.data.mediaUrl,
      platforms: parsed.data.platforms || [],
      targets: parsed.data.targets,
      requestUrl: requestOrigin(request)
    });

    return NextResponse.json({ results, publishedPost });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Publish failed" },
      { status: 400 }
    );
  }
}
