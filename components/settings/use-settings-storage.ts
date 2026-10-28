"use client";

import { useEffect, useState } from "react";
import type { StorageResponse, BrowserStorageStats } from "@/lib/settings/contracts";
import { emptyBrowserStorage, readBrowserStorageStats, clearBrowserStorage } from "@/lib/settings/browser-storage";
import { readSettingsStorage, clearSettingsStorage, openLocalResource, copyToClipboard } from "@/lib/settings/client";
export function useSettingsStorage(setStatus: (message: string) => void) {
  const [storage, setStorage] = useState<StorageResponse | null>(null);
  const [browserStorage, setBrowserStorage] = useState<BrowserStorageStats>(emptyBrowserStorage);
  const [confirmClearStorage, setConfirmClearStorage] = useState(false);
  const [isClearingStorage, setIsClearingStorage] = useState(false);
  const totalStorageBytes = (storage?.totalBytes || 0) + browserStorage.bytes;
  async function loadStorage() {
    try {
      const [response, browserStats] = await Promise.all([
        readSettingsStorage(),
        readBrowserStorageStats()
      ]);
      const { body } = response;

      setStorage(body);
      setBrowserStorage(browserStats);
    } catch {}
  }

  async function openStorageFolder() {
    setStatus("");

    try {
      const { ok, body } = await openLocalResource("storage");

      if (!ok) {
        setStatus(body.error || "Could not open storage folder.");
        return;
      }

      setStatus("Opened storage folder.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open storage folder.");
    }
  }

  async function copyStoragePath() {
    const storagePath = storage?.uploads.path;

    if (!storagePath) {
      setStatus("Storage path is not loaded yet.");
      return;
    }

    try {
      await copyToClipboard(storagePath);
      setStatus("Copied storage path.");
    } catch {
      setStatus(storagePath);
    }
  }

  async function clearStorage() {
    if (!confirmClearStorage) {
      setConfirmClearStorage(true);
      setStatus("Confirm storage clear first.");
      return;
    }

    setIsClearingStorage(true);
    setStatus("");

    try {
      const { ok, body } = await clearSettingsStorage();

      if (!ok) {
        setStatus(body.error || "Could not clear storage.");
        return;
      }

      await clearBrowserStorage();
      const browserStats = await readBrowserStorageStats();

      setStorage(body);
      setBrowserStorage(browserStats);
      setConfirmClearStorage(false);
      setStatus("Storage cleared. Config keys and profiles were kept.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not clear storage.");
    } finally {
      setIsClearingStorage(false);
    }
  }


  useEffect(() => { void loadStorage(); }, []);
  return { storage, browserStorage, totalStorageBytes, loadStorage, clearStorage, openStorageFolder, copyStoragePath, confirmClearStorage, isClearingStorage };
}
