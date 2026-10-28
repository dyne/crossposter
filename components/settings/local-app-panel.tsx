"use client";

import { useMemo } from "react";
import { Copy, ExternalLink, Eye, EyeOff, RefreshCw } from "lucide-react";
import type { SettingsConfig } from "./use-settings-config";
import type { useLocalSettings } from "./use-local-settings";
type Service = Pick<ReturnType<typeof useLocalSettings>, "localService" | "localServiceSummary" | "isTogglingLocalService" | "toggleLocalService" | "loadLocalService" | "displayLocalUrl" | "openConfigFile" | "copyConfigPath">;
export function LocalAppPanel({ config, service }: { config: Pick<SettingsConfig, "fields" | "values" | "setValues" | "configPath" | "isSecretVisible" | "toggleSecret">; service: Service }) {
  const { fields, values, setValues, configPath, isSecretVisible, toggleSecret } = config;
  const { localService, localServiceSummary, isTogglingLocalService, toggleLocalService, loadLocalService, displayLocalUrl, openConfigFile, copyConfigPath } = service;
  const localFields = useMemo(
    () =>
      fields.filter(
        (field) =>
          field.name !== "POSTER_TAILSCALE_HOST" &&
          field.name !== "POSTER_AUTO_UPDATE" &&
          !field.requiredFor?.length &&
          !field.showFor?.length
      ),
    [fields]
  );

  return (
        <section className="info-panel">
          <div className="panel-heading compact">
            <h2>Local App Settings</h2>
          </div>
          <div className="config-panel">
            <p className="hint">
              Everything here is saved to <code>poster.config.local.json</code>. That file is
              gitignored and stays on this machine.
            </p>
            <div className="config-location">
              <div>
                <span>Bookmark URL</span>
                <a href={displayLocalUrl} target="_blank" rel="noreferrer">
                  {displayLocalUrl}
                  <ExternalLink size={15} />
                </a>
              </div>
              <p>Auto-start uses this same port after the next local service restart.</p>
            </div>
            <div className="config-location local-service-card">
              <div className="service-switch-row">
                <div>
                  <span>Auto-start</span>
                  <strong>Always restart localhost</strong>
                </div>
                <button
                  aria-pressed={Boolean(localService?.installed)}
                  className={`service-switch ${localService?.installed ? "is-on" : ""}`}
                  disabled={isTogglingLocalService || !localService?.supported}
                  type="button"
                  onClick={() => void toggleLocalService(!localService?.installed)}
                >
                  <span className="sr-only">
                    {localService?.installed ? "Disable auto-start" : "Enable auto-start"}
                  </span>
                  <span aria-hidden="true" />
                </button>
              </div>
              <p>{localServiceSummary}</p>
              <div className="inline-actions">
                <button
                  className="secondary compact-button"
                  type="button"
                  onClick={() => void loadLocalService()}
                >
                  <RefreshCw size={15} />
                  Refresh status
                </button>
              </div>
            </div>
            <div className="config-location">
              <div>
                <span>Config file</span>
                <code>{configPath || "poster.config.local.json"}</code>
              </div>
              <div className="inline-actions">
                <button className="secondary compact-button" type="button" onClick={openConfigFile}>
                  <ExternalLink size={15} />
                  Open file
                </button>
                <button className="secondary compact-button" type="button" onClick={copyConfigPath}>
                  <Copy size={15} />
                  Copy path
                </button>
              </div>
            </div>
            {localFields.map((field) => (
              <label className="config-field" key={field.name}>
                <span>{field.label}</span>
                <span className="secret-input">
                  <input
                    type={field.secret && !isSecretVisible(`base:${field.name}`) ? "password" : "text"}
                    value={values[field.name] || ""}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.name]: event.target.value }))
                    }
                    placeholder={field.name}
                  />
                  {field.secret ? (
                    <button
                      aria-label={
                        isSecretVisible(`base:${field.name}`) ? "Hide secret" : "Show secret"
                      }
                      type="button"
                      onClick={() => toggleSecret(`base:${field.name}`)}
                    >
                      {isSecretVisible(`base:${field.name}`) ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  ) : null}
                </span>
                <span className="field-hint">{field.help}</span>
              </label>
            ))}
          </div>
        </section>
  );
}
