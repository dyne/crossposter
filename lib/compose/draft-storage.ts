import type { ComposeDraft, Platform, PublishTarget } from "@/lib/types";
import { platformIds } from "@/lib/platform-catalog";

export type SavedDraft = {
  title?: string;
  text?: string;
  linkUrl?: string;
  url?: string;
  selected?: string[];
  platforms?: Platform[];
  targets?: PublishTarget[];
  updatedAt?: string;
};

type StoredDraftMedia = {
  id: string;
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
};

const legacyStoragePrefix = ["personal", "crossposter"].join("-");
const draftStorageKey = "crossposter:compose-draft:v1";
const legacyDraftStorageKey = `${legacyStoragePrefix}:compose-draft:v1`;
const draftDbName = "crossposter-drafts";
const legacyDraftDbName = `${legacyStoragePrefix}-drafts`;
const draftDbVersion = 1;
const draftStoreName = "media";
const draftMediaKey = "compose-media";
export function normalizePlatforms(value: unknown): Platform[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is Platform => platformIds.includes(item as Platform));
}

export function normalizePublishTargets(value: unknown): PublishTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const record = item as Record<string, unknown>;
      const platform = record.platform;

      if (!platformIds.includes(platform as Platform)) {
        return null;
      }

      const profileId = typeof record.profileId === "string" ? record.profileId.slice(0, 120) : "";
      const id =
        typeof record.id === "string" && record.id.trim()
          ? record.id.slice(0, 180)
          : `${platform}:${profileId || "base"}`;
      const profileLabel =
        typeof record.profileLabel === "string" ? record.profileLabel.slice(0, 180) : "";

      return {
        id,
        platform: platform as Platform,
        ...(profileId ? { profileId } : {}),
        ...(profileLabel ? { profileLabel } : {})
      };
    })
    .filter((item): item is PublishTarget => Boolean(item));
}

export function readStoredDraft(): SavedDraft | null {
  try {
    const stored =
      window.localStorage.getItem(draftStorageKey) ||
      window.localStorage.getItem(legacyDraftStorageKey);

    if (!stored) {
      return null;
    }

    if (!window.localStorage.getItem(draftStorageKey)) {
      window.localStorage.setItem(draftStorageKey, stored);
    }

    const parsed = JSON.parse(stored) as SavedDraft;

    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      text: typeof parsed.text === "string" ? parsed.text : "",
      linkUrl:
        typeof parsed.linkUrl === "string"
          ? parsed.linkUrl
          : typeof parsed.url === "string"
            ? parsed.url
            : "",
      platforms: normalizePlatforms(parsed.platforms || parsed.selected),
      targets: normalizePublishTargets(parsed.targets),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined
    };
  } catch {
    return null;
  }
}

export function writeStoredDraft(draft: ComposeDraft) {
  window.localStorage.setItem(draftStorageKey, JSON.stringify(draft));
  window.localStorage.removeItem(legacyDraftStorageKey);
}

export function draftTimestamp(draft: ComposeDraft | SavedDraft | undefined | null): number {
  if (!draft?.updatedAt) {
    return 0;
  }

  const timestamp = Date.parse(draft.updatedAt);

  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function normalizeDraft(draft: ComposeDraft | SavedDraft | undefined | null): ComposeDraft {
  return {
    title: typeof draft?.title === "string" ? draft.title : "",
    text: typeof draft?.text === "string" ? draft.text : "",
    linkUrl:
      typeof draft?.linkUrl === "string"
        ? draft.linkUrl
        : typeof (draft as SavedDraft | undefined)?.url === "string"
          ? ((draft as SavedDraft).url as string)
          : "",
    platforms: normalizePlatforms(draft?.platforms || (draft as SavedDraft | undefined)?.selected),
    targets: normalizePublishTargets(draft?.targets),
    ...(typeof draft?.updatedAt === "string" ? { updatedAt: draft.updatedAt } : {})
  };
}

export function newestDraft(
  configDraft: ComposeDraft | undefined,
  browserDraft: SavedDraft | null
): ComposeDraft {
  return draftTimestamp(browserDraft) > draftTimestamp(configDraft)
    ? normalizeDraft(browserDraft)
    : normalizeDraft(configDraft);
}

function openDraftDb(dbName = draftDbName): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(dbName, draftDbVersion);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(draftStoreName)) {
        request.result.createObjectStore(draftStoreName, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open draft media store"));
  });
}

async function withDraftStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  dbName = draftDbName
): Promise<T> {
  const db = await openDraftDb(dbName);

  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(draftStoreName, mode);
      const request = run(transaction.objectStore(draftStoreName));

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Draft media operation failed"));
      transaction.onerror = () =>
        reject(transaction.error || new Error("Draft media transaction failed"));
    });
  } finally {
    db.close();
  }
}

export async function readStoredDraftMedia(): Promise<File | null> {
  if (!("indexedDB" in window)) {
    return null;
  }

  const stored =
    ((await withDraftStore("readonly", (store) =>
      store.get(draftMediaKey)
    )) as StoredDraftMedia | undefined) ||
    ((await withDraftStore("readonly", (store) => store.get(draftMediaKey), legacyDraftDbName)) as
      | StoredDraftMedia
      | undefined);

  if (!stored?.blob) {
    return null;
  }

  return new File([stored.blob], stored.name || "draft-media", {
    type: stored.type || stored.blob.type || "application/octet-stream",
    lastModified: stored.lastModified || Date.now()
  });
}

export async function saveStoredDraftMedia(file: File | null): Promise<void> {
  if (!("indexedDB" in window)) {
    return;
  }

  if (!file) {
    await withDraftStore("readwrite", (store) => store.delete(draftMediaKey));
    await withDraftStore("readwrite", (store) => store.delete(draftMediaKey), legacyDraftDbName);
    return;
  }

  await withDraftStore("readwrite", (store) =>
    store.put({
      id: draftMediaKey,
      blob: file,
      name: file.name,
      type: file.type,
      lastModified: file.lastModified
    } satisfies StoredDraftMedia)
  );
  await withDraftStore("readwrite", (store) => store.delete(draftMediaKey), legacyDraftDbName);
}


