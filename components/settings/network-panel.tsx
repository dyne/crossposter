"use client";

import { Copy, ExternalLink, Info, Network, RefreshCw } from "lucide-react";
import type { SettingsConfig } from "./use-settings-config";
import type { useLocalSettings } from "./use-local-settings";
type Network = Pick<ReturnType<typeof useLocalSettings>, "tailscale" | "displayTailscaleUrl" | "tailscaleSummary" | "showTailscaleInfo" | "setShowTailscaleInfo" | "loadTailscale" | "copyTailscaleUrl" | "displayLocalUrl">;
export function NetworkPanel({ config, network }: { config: Pick<SettingsConfig, "values" | "setValues">; network: Network }) {
  const { values, setValues } = config;
  const { tailscale, displayTailscaleUrl, tailscaleSummary, showTailscaleInfo, setShowTailscaleInfo, loadTailscale, copyTailscaleUrl, displayLocalUrl } = network;
  return (
          <section className="info-panel tailscale-panel">
            <div className="panel-heading compact">
              <h2>
                <Network size={20} />
                Tailscale Access
              </h2>
              <button
                aria-expanded={showTailscaleInfo}
                aria-label="Show Tailscale connection help"
                className="secondary compact-button config-info-button"
                type="button"
                onClick={() => setShowTailscaleInfo((current) => !current)}
              >
                <Info size={17} />
              </button>
            </div>
            <div className="config-panel">
              <div className="config-location tailscale-card">
                <div className="config-location-title">
                  <div>
                    <span>Tailscale connection</span>
                    <strong>Phone access over Tailnet</strong>
                  </div>
                </div>
                <p>{tailscaleSummary}</p>
                <div className="tailscale-status-grid">
                  <div>
                    <span>Status</span>
                    <strong>{tailscale?.running ? "Connected" : "Not connected"}</strong>
                    <small>
                      {tailscale?.detectedIp
                        ? `Detected ${tailscale.detectedIp}`
                        : tailscale?.error || "Refresh after opening Tailscale."}
                    </small>
                  </div>
                  <div>
                    <span>Phone URL</span>
                    {displayTailscaleUrl ? (
                      <a href={displayTailscaleUrl} target="_blank" rel="noreferrer">
                        {displayTailscaleUrl}
                        <ExternalLink size={15} />
                      </a>
                    ) : (
                      <code>Set host below</code>
                    )}
                    <small>Use this on iPhone when it is on the same Tailnet.</small>
                  </div>
                </div>
                <label className="config-field tailscale-host-field">
                  <span>Tailscale host or IP</span>
                  <input
                    value={values.POSTER_TAILSCALE_HOST || ""}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        POSTER_TAILSCALE_HOST: event.target.value
                      }))
                    }
                    placeholder="100.x.x.x or macbook.tailnet.ts.net"
                  />
                  <span className="field-hint">
                    Optional. Leave blank to auto-detect with <code>tailscale ip -4</code>.
                  </span>
                </label>
                <div className="inline-actions">
                  <button
                    className="secondary compact-button"
                    type="button"
                    onClick={() => void loadTailscale()}
                  >
                    <RefreshCw size={15} />
                    Refresh Tailscale
                  </button>
                  <button
                    className="secondary compact-button"
                    type="button"
                    onClick={() => void copyTailscaleUrl()}
                  >
                    <Copy size={15} />
                    Copy phone URL
                  </button>
                </div>
                {showTailscaleInfo ? (
                  <section className="setup-guide tailscale-guide">
                    <strong>Fix phone access</strong>
                    <ol>
                      <li>Install and sign in to Tailscale on this Mac and your phone.</li>
                      <li>Keep Crossposter running on this Mac at {displayLocalUrl}.</li>
                      <li>Refresh this card and open the Phone URL on your phone.</li>
                      <li>
                        If auto-detect fails, paste this Mac&apos;s Tailscale 100.x IP or MagicDNS
                        name into the host field, then Save config.
                      </li>
                    </ol>
                  </section>
                ) : null}
              </div>
            </div>
          </section>

  );
}
