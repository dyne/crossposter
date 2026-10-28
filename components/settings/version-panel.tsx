"use client";

import { AlertTriangle, CheckCircle2, Copy, Download, RefreshCw } from "lucide-react";
import type { useLocalSettings } from "./use-local-settings";
type Version = Pick<ReturnType<typeof useLocalSettings>, "appVersion" | "versionSummary" | "isCheckingAppVersion" | "loadAppVersion" | "managedByHomebrew" | "autoUpdateEnabled" | "isTogglingAutoUpdate" | "toggleAutoUpdate" | "versionActionIsUpdate" | "versionActionBusy" | "versionActionLabel" | "versionAlreadyCurrent" | "updateAppPackage" | "copyText">;
export function VersionPanel({ version }: { version: Version }) {
  const { appVersion, versionSummary, isCheckingAppVersion, loadAppVersion, managedByHomebrew, autoUpdateEnabled, isTogglingAutoUpdate, toggleAutoUpdate, versionActionIsUpdate, versionActionBusy, versionActionLabel, versionAlreadyCurrent, updateAppPackage, copyText } = version;
  return (
          <section className="info-panel version-panel">
            <div className="panel-heading compact">
              <h2>
                <Download size={20} />
                Version & Updates
              </h2>
              <button
                className="secondary compact-button config-info-button"
                type="button"
                disabled={isCheckingAppVersion}
                onClick={() => void loadAppVersion({ showStatus: true })}
                aria-label="Refresh version status"
              >
                <RefreshCw size={17} />
              </button>
            </div>
            <div className="config-panel">
              <div className="config-location version-card">
                <div className="config-location-title">
                  <div>
                    <span>Current version</span>
                    <strong>Crossposter {appVersion?.currentVersion || "checking..."}</strong>
                  </div>
                  {!appVersion ? (
                    <span className="status-pill">
                      <RefreshCw size={14} />
                      Checking
                    </span>
                  ) : appVersion.updateAvailable ? (
                    <span className="status-pill warn">
                      <AlertTriangle size={14} />
                      Update
                    </span>
                  ) : appVersion.latestError ? (
                    <span className="status-pill warn">
                      <AlertTriangle size={14} />
                      Check
                    </span>
                  ) : (
                    <span className="status-pill ok">
                      <CheckCircle2 size={14} />
                      Current
                    </span>
                  )}
                </div>
                <p>{versionSummary}</p>
                <div className="tailscale-status-grid">
                  <div>
                    <span>Latest release</span>
                    <strong>{appVersion?.latestVersion || "Unknown"}</strong>
                    <small>{appVersion?.installSource || "local"} install source</small>
                  </div>
                  <div>
                    <span>Update command</span>
                    <code>{appVersion?.updateCommand || "npx @apoorvdarshan/crossposter@latest"}</code>
                    <small>Updates the app without changing local config or uploads.</small>
                  </div>
                </div>
                <div className="service-switch-row app-update-row">
                  <div>
                    <span>{managedByHomebrew ? "Package updates" : "Auto-update"}</span>
                    <strong>
                      {managedByHomebrew
                        ? "Managed by Homebrew"
                        : "Check npm when Crossposter starts"}
                    </strong>
                  </div>
                  <button
                    aria-pressed={autoUpdateEnabled}
                    className={`service-switch ${autoUpdateEnabled ? "is-on" : ""}`}
                    disabled={isTogglingAutoUpdate || managedByHomebrew}
                    type="button"
                    onClick={() => void toggleAutoUpdate(!autoUpdateEnabled)}
                  >
                    <span className="sr-only">
                      {autoUpdateEnabled ? "Disable auto-update" : "Enable auto-update"}
                    </span>
                    <span aria-hidden="true" />
                  </button>
                </div>
                <p>
                  {managedByHomebrew
                    ? "Run the Homebrew update command above, then restart Crossposter so the new code can boot."
                    : "Auto-update is on by default. A running app still needs a restart after a package update so the new code can boot."}
                </p>
                <div className="inline-actions">
                  <button
                    className={`${versionActionIsUpdate ? "primary" : "secondary"} compact-button`}
                    type="button"
                    disabled={versionActionBusy}
                    onClick={() =>
                      void (versionActionIsUpdate
                        ? updateAppPackage()
                        : loadAppVersion({ showStatus: true }))
                    }
                  >
                    {versionActionBusy ? (
                      <RefreshCw size={15} />
                    ) : versionActionIsUpdate ? (
                      <Download size={15} />
                    ) : (
                      <RefreshCw size={15} />
                    )}
                    {versionActionLabel}
                  </button>
                  {versionAlreadyCurrent ? (
                    <span className="version-ready-note">
                      <CheckCircle2 size={15} />
                      Already updated
                    </span>
                  ) : null}
                  <button
                    className="secondary compact-button"
                    type="button"
                    onClick={() => void copyText(appVersion?.updateCommand || "npx @apoorvdarshan/crossposter@latest")}
                  >
                    <Copy size={15} />
                    Copy command
                  </button>
                </div>
              </div>
            </div>
          </section>

  );
}
