"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComposeDraft, PublishedMedia, PublishedPost, PublishTarget } from "@/lib/types";
import { composeClient, fileFromDraftMedia } from "@/lib/compose/client";
import {
  draftTimestamp, newestDraft, normalizeDraft, readStoredDraft,
  readStoredDraftMedia, writeStoredDraft, readStoredDraftRevision, writeStoredDraftRevision
} from "@/lib/compose/draft-storage";
import { platformIds } from "@/lib/platform-catalog";

type Options = {
  availableTargets: PublishTarget[];
  configHydrated: boolean;
  hydrateMedia: (file: File | null) => void;
  clearMedia: () => Promise<void>;
};

const message = (error: unknown) => error instanceof Error ? error.message : "Draft persistence failed";

export function useComposerDraft({ availableTargets, configHydrated, hydrateMedia, clearMedia }: Options) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [publishedPosts, setPublishedPosts] = useState<PublishedPost[]>([]);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [hasSavedDraft, setHasSavedDraft] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [attachedMedia, setAttachedMedia] = useState<PublishedMedia>();
  const saveState = useRef({ active: true, revision: 0, serverRevision: undefined as string | undefined,
    pending: Promise.resolve(), blocked: "" });

  const persistDraft = useCallback((draft: ComposeDraft) => {
    const state = saveState.current;
    const save = state.pending.then(async () => {
      if (!state.active) return;
      if (state.blocked) throw new Error(state.blocked);
      try {
        const response = await composeClient.saveDraft(draft, state.serverRevision);
        if (!response.ok) throw new Error(response.status === 409
          ? "Draft changed elsewhere. Reload before saving; your edits remain in this browser."
          : "Draft could not be saved. Reload before trying again; your edits remain in this browser.");
        const body = await response.json() as { revision?: string };
        if (body.revision) {
          state.serverRevision = body.revision;
          try { writeStoredDraftRevision(body.revision); }
          catch (error) { if (state.active) setStorageError(message(error)); }
        }
      } catch (error) {
        // A failed response may follow a completed server write. Never guess a
        // new base or replay queued edits over another client's draft.
        state.blocked = message(error);
        throw error;
      }
    });
    state.pending = save.catch(() => undefined);
    return save;
  }, []);

  useEffect(() => {
    let active = true;
    const state = saveState.current;
    state.active = true;
    const controller = new AbortController();
    function restore(draft: ComposeDraft) {
      setTitle(draft.title);
      setText(draft.text);
      setLinkUrl(draft.linkUrl);
      setSelected(draft.targets?.length ? draft.targets.map((target) => target.id) : draft.platforms);
      setHasSavedDraft(draftTimestamp(draft) > 0);
    }
    async function loadDraft() {
      try {
        const body = await composeClient.readDraft(controller.signal);
        const browserDraft = readStoredDraft();
        // A versioned backend owns the shared singleton. Browser timestamps
        // cannot silently resurrect edits made before a newer MCP save/clear.
        // A never-saved backend still accepts the existing browser migration.
        const serverSaved = Boolean(body.revision && body.draft?.updatedAt);
        const draft = serverSaved ? normalizeDraft(body.draft) : newestDraft(body.draft, browserDraft);
        const serverMediaImport = body.draft?.media && (serverSaved || draftTimestamp(body.draft) >= draftTimestamp(browserDraft))
          ? await fileFromDraftMedia(body.draft.media, controller.signal) : null;
        const previousRevision = readStoredDraftRevision();
        const legacySameDraft = !previousRevision && draftTimestamp(body.draft) === draftTimestamp(browserDraft)
          && JSON.stringify(normalizeDraft(body.draft)) === JSON.stringify(normalizeDraft(browserDraft));
        const recoverBrowserMedia = !serverSaved || previousRevision === body.revision || legacySameDraft;
        const storedMedia = serverMediaImport || (recoverBrowserMedia ? await readStoredDraftMedia() : null);
        if (!active) return;
        state.serverRevision = body.revision;
        state.blocked = "";
        if (body.revision) {
          try { writeStoredDraftRevision(body.revision); }
          catch (error) { setStorageError(message(error)); }
        }
        setAttachedMedia(body.draft?.media);
        restore(draft);
        setPublishedPosts(body.publishedPosts || []);
        hydrateMedia(storedMedia);
      } catch (error) {
        if (!active) return;
        // Preserve the existing browser recovery, including falling back to
        // browser text when reading the attached IndexedDB media fails.
        restore(normalizeDraft(readStoredDraft()));
        setLoadError(message(error));
        hydrateMedia(null);
      } finally {
        if (active) setDraftHydrated(true);
      }
    }
    void loadDraft();
    return () => { active = false; state.active = false; controller.abort(); };
  }, [hydrateMedia]);

  useEffect(() => {
    if (!draftHydrated || !configHydrated) return;
    setSelected((current) => {
      const ids = new Set(availableTargets.map((target) => target.id));
      const next = Array.from(new Set(current.flatMap((item) => {
        if (ids.has(item)) return [item];
        if (platformIds.includes(item as typeof platformIds[number])) {
          const target = availableTargets.find((target) => target.platform === item);
          return target ? [target.id] : [];
        }
        return [];
      })));
      if (hasSavedDraft) return next;
      return next.length ? next : availableTargets.slice(0, 1).map((target) => target.id);
    });
  }, [availableTargets, configHydrated, draftHydrated, hasSavedDraft]);

  const selectedTargets = useMemo(() => {
    const byId = new Map(availableTargets.map((target) => [target.id, target]));
    return selected.map((id) => byId.get(id)).filter((target): target is PublishTarget => Boolean(target));
  }, [availableTargets, selected]);
  const selectedPlatforms = useMemo(() => Array.from(new Set(selectedTargets.map((target) => target.platform))), [selectedTargets]);

  useEffect(() => {
    if (!draftHydrated || !configHydrated) return;
    if (!hasSavedDraft && !title && !text && !linkUrl && selected.length === 0) return;
    const draft: ComposeDraft = { title, text, linkUrl, platforms: selectedPlatforms, targets: selectedTargets,
      ...(attachedMedia ? { media: attachedMedia } : {}), updatedAt: new Date().toISOString() };
    try { writeStoredDraft(draft); setStorageError(""); }
    catch (error) { setStorageError(message(error)); }
    let active = true;
    const state = saveState.current;
    state.revision++;
    const timer = window.setTimeout(() => {
      setIsSavingDraft(true);
      // Serialize writes and advance only from a successful server revision.
      // Responses never replace current editor text.
      void persistDraft(draft).then(() => {
        if (active) setSaveError("");
      }).catch((error: unknown) => {
        if (active) setSaveError(message(error));
      }).finally(() => {
        if (active) setIsSavingDraft(false);
      });
    }, 250);
    return () => { active = false; state.revision++; window.clearTimeout(timer); };
  }, [title, text, linkUrl, selected, selectedPlatforms, selectedTargets, draftHydrated, configHydrated, hasSavedDraft, attachedMedia, persistDraft]);

  async function clearDraft() {
    const draft: ComposeDraft = { title: "", text: "", linkUrl: "", platforms: [], targets: [], updatedAt: new Date().toISOString() };
    setHasSavedDraft(true);
    setTitle(""); setText(""); setLinkUrl(""); setSelected([]);
    setAttachedMedia(undefined);
    try { writeStoredDraft(draft); setStorageError(""); }
    catch (error) { setStorageError(message(error)); }
    await clearMedia();
    const state = saveState.current;
    const revision = state.revision;
    await persistDraft(draft).catch((error: unknown) => {
      if (state.active && state.revision === revision) setSaveError(message(error));
    });
  }

  return {
    title, setTitle, text, setText, linkUrl, setLinkUrl, selected, setSelected,
    publishedPosts, setPublishedPosts, draftHydrated, hasSavedDraft, setHasSavedDraft, clearDraft,
    isLoadingDraft: !draftHydrated, isSavingDraft, loadError, saveError, storageError,
    detachMedia: () => setAttachedMedia(undefined)
  };
}
