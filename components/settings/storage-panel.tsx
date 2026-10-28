"use client";

import { AlertTriangle, Copy, ExternalLink, HardDrive, Trash2 } from "lucide-react";
import { formatBytes } from "@/lib/settings/presentation";
import type { useSettingsStorage } from "./use-settings-storage";
export function StoragePanel({ storageState }: { storageState: ReturnType<typeof useSettingsStorage> }) {
  const { storage, browserStorage, totalStorageBytes, loadStorage, clearStorage, openStorageFolder, copyStoragePath, confirmClearStorage, isClearingStorage } = storageState;
  return (
        <section className="info-panel">
          <div className="panel-heading compact">
            <h2>
              <HardDrive size={20} />
              Local Storage
            </h2>
            <button className="secondary compact-button" type="button" onClick={() => void loadStorage()}>
              Refresh
            </button>
          </div>
          <div className="config-panel">
            <div className="storage-total">
              <span>Total saved editing data</span>
              <strong>{formatBytes(totalStorageBytes)}</strong>
            </div>
            <div className="storage-breakdown">
              <div>
                <span>Local uploaded files</span>
                <strong>{formatBytes(storage?.uploads.bytes || 0)}</strong>
                <small>{storage?.uploads.files || 0} files</small>
              </div>
              <div>
                <span>Browser draft media</span>
                <strong>{formatBytes(browserStorage.mediaBytes)}</strong>
                <small>{browserStorage.files} draft/history files</small>
              </div>
              <div>
                <span>Draft</span>
                <strong>
                  {formatBytes((storage?.config.draftBytes || 0) + browserStorage.draftBytes)}
                </strong>
                <small>Title, post, selected channels</small>
              </div>
              <div>
                <span>Published history</span>
                <strong>{formatBytes(storage?.config.publishedPostsBytes || 0)}</strong>
                <small>{storage?.config.publishedPosts || 0} posts</small>
              </div>
              <div>
                <span>Scheduled queue</span>
                <strong>{formatBytes(storage?.config.scheduledPostsBytes || 0)}</strong>
                <small>{storage?.config.scheduledPosts || 0} posts</small>
              </div>
            </div>
            {storage?.uploads.path ? (
              <div className="config-location">
                <div>
                  <span>Local upload folder</span>
                  <code>{storage.uploads.path}</code>
                </div>
                <div className="inline-actions">
                  <button className="secondary compact-button" type="button" onClick={openStorageFolder}>
                    <ExternalLink size={15} />
                    Open folder
                  </button>
                  <button className="secondary compact-button" type="button" onClick={copyStoragePath}>
                    <Copy size={15} />
                    Copy path
                  </button>
                </div>
              </div>
            ) : null}
            <p className="hint">
              Clear storage removes current draft, browser draft media, local uploaded files,
              scheduled posts, and published history. It does not delete config keys, profiles, or provider setup.
            </p>
            {confirmClearStorage ? (
              <div className="storage-warning">
                <AlertTriangle size={18} />
                <span>This will clear saved editing/history storage. Config stays untouched.</span>
              </div>
            ) : null}
            <button
              className={confirmClearStorage ? "danger-button compact-button" : "secondary compact-button"}
              type="button"
              onClick={() => void clearStorage()}
              disabled={isClearingStorage}
            >
              <Trash2 size={16} />
              {isClearingStorage
                ? "Clearing..."
                : confirmClearStorage
                  ? "Confirm clear storage"
                  : "Clear storage"}
            </button>
          </div>
        </section>
  );
}
