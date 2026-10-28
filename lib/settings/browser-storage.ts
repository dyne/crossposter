import type { BrowserStorageStats } from "./contracts";

const legacyStoragePrefix = ["personal", "crossposter"].join("-");
const draftStorageKey = "crossposter:compose-draft:v1";
const legacyDraftStorageKey = `${legacyStoragePrefix}:compose-draft:v1`;
const draftDbName = "crossposter-drafts";
const legacyDraftDbName = `${legacyStoragePrefix}-drafts`;
const draftDbVersion = 1;
const draftStoreName = "media";

export const emptyBrowserStorage: BrowserStorageStats = {
  bytes: 0,
  files: 0,
  draftBytes: 0,
  mediaBytes: 0
};

function openStorageDb(dbName = draftDbName): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(dbName, draftDbVersion);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(draftStoreName)) {
        request.result.createObjectStore(draftStoreName, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local storage"));
  });
}

async function withStorageStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  dbName = draftDbName
): Promise<T | null> {
  const db = await openStorageDb(dbName);

  if (!db) {
    return null;
  }

  try {
    if (!db.objectStoreNames.contains(draftStoreName)) {
      return null;
    }

    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(draftStoreName, mode);
      const request = run(transaction.objectStore(draftStoreName));

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Storage operation failed"));
      transaction.onerror = () =>
        reject(transaction.error || new Error("Storage transaction failed"));
    });
  } finally {
    db.close();
  }
}

export async function readBrowserStorageStats(): Promise<BrowserStorageStats> {
  const draftBytes =
    typeof window === "undefined"
      ? 0
      : new Blob([
          window.localStorage.getItem(draftStorageKey) ||
            window.localStorage.getItem(legacyDraftStorageKey) ||
            ""
        ]).size;
  const records = ((await withStorageStore("readonly", (store) => store.getAll())) || []) as Array<{
    blob?: Blob;
  }>;
  const legacyRecords = ((await withStorageStore(
    "readonly",
    (store) => store.getAll(),
    legacyDraftDbName
  )) || []) as Array<{
    blob?: Blob;
  }>;
  const allRecords = [...records, ...legacyRecords];
  const mediaBytes = allRecords.reduce((total, record) => total + (record.blob?.size || 0), 0);

  return {
    bytes: draftBytes + mediaBytes,
    files: allRecords.filter((record) => record.blob).length,
    draftBytes,
    mediaBytes
  };
}

export async function clearBrowserStorage(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(draftStorageKey);
  window.localStorage.removeItem(legacyDraftStorageKey);
  await withStorageStore("readwrite", (store) => store.clear()).catch(() => null);
  await withStorageStore("readwrite", (store) => store.clear(), legacyDraftDbName).catch(() => null);
}
