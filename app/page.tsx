"use client";

import { useEffect, useMemo, useState } from "react";
import NextImage from "next/image";
import Link from "next/link";
import { ProjectLinks } from "@/components/project-links";
import { ThemeToggle } from "@/components/theme-toggle";
import { composeClient } from "@/lib/compose/client";
import { mediaPreflightIssues, videoTargetBytesForPlatforms } from "@/lib/compose/media-policy";
import { channelTargets, publishTargetFromCard, type ChannelTarget } from "@/lib/compose/channels";
import { getDraftValidation } from "@/lib/compose/validation";
import { useComposerDraft } from "@/components/composer/use-composer-draft";
import { useComposerMedia } from "@/components/composer/use-composer-media";
import { useComposerActions } from "@/components/composer/use-composer-actions";
import { ComposerEditor } from "@/components/composer/composer-editor";
import { MediaEditor } from "@/components/composer/media-editor";
import { ChannelSelection } from "@/components/composer/channel-selection";
import { PublishPanel } from "@/components/composer/publish-panel";
import { ComposeToolbar } from "@/components/composer/compose-toolbar";
import type { Platform, ProviderProfile } from "@/lib/types";

export default function Home() {
  const [configHydrated, setConfigHydrated] = useState(false);
  const [configLoadFailed, setConfigLoadFailed] = useState(false);
  const [configProfiles, setConfigProfiles] = useState<Partial<Record<Platform, ProviderProfile[]>>>({});

  const visibleTargets = useMemo(() => channelTargets(configProfiles), [configProfiles]);

  useEffect(() => {
    let active = true;

    async function loadConfig() {
      try {
        const body = await composeClient.readConfig();

        if (!active) {
          return;
        }

        setConfigLoadFailed(false);
        setConfigProfiles(body.profiles || {});
      } catch {
        if (active) {
          setConfigLoadFailed(true);
          setConfigProfiles({});
        }
      } finally {
        if (active) {
          setConfigHydrated(true);
        }
      }
    }

    void loadConfig();

    return () => {
      active = false;
    };
  }, []);

  const media = useComposerMedia({
    onEdit: () => setHasSavedDraft(true),
    onReplace: () => actions.resetFeedback(),
    setError: (value) => actions.setError(value), setProgress: (value) => actions.setProgress(value), videoTargetBytes: videoTargetBytesForPlatforms
  });
  const availableTargets = useMemo(() => visibleTargets.map(publishTargetFromCard), [visibleTargets]);
  const draft = useComposerDraft({
    availableTargets, configHydrated, hydrateMedia: media.hydrateMedia, clearMedia: media.clearMedia
  });
  const {
    title, setTitle, text, setText, linkUrl, setLinkUrl, selected, setSelected,
    publishedPosts, setHasSavedDraft
  } = draft;
  const selectedTargets = useMemo(() => {
    const byId = new Map(visibleTargets.map((target) => [target.targetId, target]));

    return selected
      .map((targetId) => byId.get(targetId))
      .filter((target): target is ChannelTarget => Boolean(target));
  }, [selected, visibleTargets]);

  const selectedPlatforms = useMemo(
    () => Array.from(new Set(selectedTargets.map((target) => target.id))),
    [selectedTargets]
  );
  const selectedLimitTargets = useMemo(
    () =>
      selectedTargets.map((target) => ({
        platform: target.id,
        profileLabel: target.profileLabel,
        xPremium: target.id === "x" && target.profileValues.X_PREMIUM_LONG_POSTS === "true"
      })),
    [selectedTargets]
  );

  const selectedLabel = useMemo(() => {
    if (selectedTargets.length === 0) {
      return "No channels";
    }

    return `${selectedTargets.length} selected`;
  }, [selectedTargets.length]);

  function toggleTarget(targetId: string) {
    setHasSavedDraft(true);
    setSelected((current) =>
      current.includes(targetId)
        ? current.filter((item) => item !== targetId)
        : [...current, targetId]
    );
  }

  const actions = useComposerActions({ draft, media, selectedTargets, selectedLimitTargets });
  const { postLength, titleLimitWarnings, postLimitWarnings, devtoBodyLimitWarning, isHackerNewsOnly, canSubmitDraft } =
    getDraftValidation({
      title, text, selectedPlatforms, selectedLimitTargets, selectedTargetCount: selectedTargets.length,
      mediaFile: media.mediaFile,
      preflightIssues: mediaPreflightIssues(selectedLimitTargets, media.mediaFile, media.mediaDimensions),
      isBusy: actions.isPublishing || actions.isScheduling || media.isUploadingMedia || media.isCompressingMedia || media.isCroppingMedia
    });
  const canSchedule = Boolean(canSubmitDraft && actions.scheduledForIso && Date.parse(actions.scheduledForIso) >= Date.now() - 60_000);
  const readyCount = visibleTargets.filter((target) => target.ready).length;
  return (
    <main className="workspace">
      <header className="masthead">
        <div className="brand-lockup">
          <NextImage
            alt=""
            className="mark"
            height="46"
            src="/assets/logo-crossposter.png"
            width="46"
          />
          <div className="brand-copy">
            <h1>Crossposter</h1>
            <ProjectLinks />
          </div>
        </div>
        <div className="masthead-actions">
          <nav className="top-tabs" aria-label="Primary sections">
            <span className="top-tab is-active" aria-current="page">
              Dashboard
            </span>
            <Link className="top-tab" href="/scheduled">
              Scheduler
            </Link>
            <Link className="top-tab" href="/settings">
              Settings
            </Link>
            <Link className="top-tab" href="/settings/storage">
              Storage
            </Link>
            <Link className="top-tab" href="/settings/socials">
              Socials
            </Link>
          </nav>
          <ThemeToggle />
          <div className="status-pill masthead-action-slot">
            <span className="dot" />
            <span>
              {selectedLabel} · {readyCount} ready
            </span>
          </div>
        </div>
      </header>

      <section className="dashboard">
        <section className="compose-panel" aria-labelledby="composeTitle">
          <ComposeToolbar actions={actions} postLength={postLength}
            canPublish={canSubmitDraft} canOpenSchedule={canSubmitDraft} canSchedule={canSchedule} />

          <div className="composer">
            <ComposerEditor
              title={title} text={text} linkUrl={linkUrl}
              onTitleChange={(value) => { setHasSavedDraft(true); setTitle(value); }}
              onTextChange={(value) => { setHasSavedDraft(true); setText(value); }}
              onLinkChange={(value) => { setHasSavedDraft(true); setLinkUrl(value); }}
              titleLimitWarnings={titleLimitWarnings} postLimitWarnings={postLimitWarnings}
              devtoBodyLimitWarning={devtoBodyLimitWarning} isHackerNewsOnly={isHackerNewsOnly}
            />
            <MediaEditor media={media} selectedPlatforms={selectedPlatforms}
              selectedLimitTargets={selectedLimitTargets} progress={actions.progress} />
            <ChannelSelection
              visibleTargets={visibleTargets} selected={selected}
              configHydrated={configHydrated} configLoadFailed={configLoadFailed}
              onSelectAll={() => { setHasSavedDraft(true); setSelected(visibleTargets.map((target) => target.targetId)); }}
              onSelectNone={() => { setHasSavedDraft(true); setSelected([]); }}
              onToggleTarget={toggleTarget}
            />

          </div>
        </section>

        <PublishPanel
          publishedPosts={publishedPosts} results={actions.results} error={actions.error}
          isPublishing={actions.isPublishing} isUploadingMedia={media.isUploadingMedia}
          onClearHistory={actions.clearPublishedPosts}
        />
      </section>
    </main>
  );
}
