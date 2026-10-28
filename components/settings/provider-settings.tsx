"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, Eye, EyeOff, Info, Plus, RefreshCw, Trash2 } from "lucide-react";
import { SocialLogo } from "@/components/social-logo";
import type { Platform } from "@/lib/types";
import { platforms, setupGuides } from "@/lib/settings/provider-guides";
import type { SettingsConfig } from "./use-settings-config";
import { useProviderConnections } from "./use-provider-connections";
export function ProviderSettings({ config }: { config: Pick<SettingsConfig, "fields" | "profiles" | "values" | "activeProfiles" | "setStatus" | "setIsSaving" | "saveConfig" | "loadConfig" | "fieldsFor" | "fieldIssue" | "addProfile" | "updateProfile" | "deleteProfile" | "confirmDeleteProfile" | "isSecretVisible" | "toggleSecret"> }) {
  const { fields, profiles, fieldsFor, fieldIssue, addProfile, updateProfile, deleteProfile, confirmDeleteProfile, isSecretVisible, toggleSecret } = config;
  const { importingHackerNewsCookie, importingYouTubeCookie, connectingInstagram, connectingX, connectLinkedIn, connectDribbble, importHackerNewsCookie, importYouTubeCookie, connectInstagram, connectX } = useProviderConnections(config);
  const [openGuides, setOpenGuides] = useState<Partial<Record<Platform, boolean>>>({});
  const socialColumns = useMemo(() => {
    const columns: Array<{ platforms: typeof platforms; weight: number }> = [
      { platforms: [], weight: 0 },
      { platforms: [], weight: 0 }
    ];

    for (const platform of platforms) {
      const providerProfiles = profiles[platform.id] || [];
      const providerFieldCount = fields.filter(
        (field) => field.requiredFor?.includes(platform.id) || field.showFor?.includes(platform.id)
      ).length;
      const guide = setupGuides[platform.id];
      const profileWeight = Math.max(1, providerProfiles.length) * (providerFieldCount + 4);
      const guideWeight = openGuides[platform.id] && guide ? guide.steps.length * 0.6 + 4 : 0;
      const panelWeight = 5 + profileWeight + guideWeight;
      const target = columns[0].weight <= columns[1].weight ? columns[0] : columns[1];

      target.platforms.push(platform);
      target.weight += panelWeight;
    }

    return columns.map((column) => column.platforms);
  }, [fields, openGuides, profiles]);

  function toggleGuide(platform: Platform) {
    setOpenGuides((current) => ({
      ...current,
      [platform]: !current[platform]
    }));
  }

  function renderSocialPanel(platform: (typeof platforms)[number]) {
    const providerFields = fieldsFor(platform.id);
    const providerProfiles = profiles[platform.id] || [];
    const setupGuide = setupGuides[platform.id];

    return (
      <section className="info-panel" key={platform.id}>
        <div className="panel-heading compact">
          <h2>
            <SocialLogo platform={platform.id} />
            {platform.label}
          </h2>
          <div className="panel-actions">
            {setupGuide ? (
              <button
                aria-expanded={Boolean(openGuides[platform.id])}
                aria-label={`${platform.label} setup guide`}
                className="secondary compact-button icon-button"
                type="button"
                onClick={() => toggleGuide(platform.id)}
              >
                <Info size={17} />
              </button>
            ) : null}
            <button className="secondary compact-button" type="button" onClick={() => addProfile(platform.id)}>
              <Plus size={16} />
              Add profile
            </button>
          </div>
        </div>
        <div className="config-panel">
          {setupGuide && openGuides[platform.id] ? (
            <section className="setup-guide">
              <div>
                <strong>{setupGuide.title}</strong>
                <p>{setupGuide.intro}</p>
              </div>
              <div className="setup-links">
                {setupGuide.links.map((link) => (
                  <a href={link.href} key={link.href} target="_blank" rel="noreferrer">
                    {link.label}
                    <ExternalLink size={14} />
                  </a>
                ))}
              </div>
              <ol>
                {setupGuide.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </section>
          ) : null}
          {providerProfiles.length === 0 ? (
            <p className="hint">No profiles yet. Add one to connect this social locally.</p>
          ) : null}

          {providerProfiles.map((profile) => (
            <section className="config-group" key={profile.id}>
              <div className="config-group-title">
                <strong>{profile.label || "Untitled profile"}</strong>
                <div className="profile-actions">
                  {platform.id === "linkedin" ? (
                    <button
                      className="secondary compact-button"
                      type="button"
                      onClick={() => void connectLinkedIn(profile)}
                    >
                      <RefreshCw size={15} />
                      Connect LinkedIn
                    </button>
                  ) : null}
                  {platform.id === "dribbble" ? (
                    <button
                      className="secondary compact-button"
                      type="button"
                      onClick={() => void connectDribbble(profile)}
                    >
                      <RefreshCw size={15} />
                      Connect Dribbble
                    </button>
                  ) : null}
                  {platform.id === "instagram" ? (
                    <button
                      className="secondary compact-button"
                      type="button"
                      onClick={() => void connectInstagram(profile)}
                      disabled={Boolean(connectingInstagram)}
                    >
                      <RefreshCw size={15} />
                      {connectingInstagram === profile.id ? "Opening browser..." : "Log in to Instagram"}
                    </button>
                  ) : null}
                  {platform.id === "x" ? (
                    <button
                      className="secondary compact-button"
                      type="button"
                      onClick={() => void connectX(profile)}
                      disabled={Boolean(connectingX)}
                    >
                      <RefreshCw size={15} />
                      {connectingX === profile.id ? "Opening browser..." : "Log in to X"}
                    </button>
                  ) : null}
                  {platform.id === "hackernews" ? (
                    <button
                      className="secondary compact-button"
                      type="button"
                      onClick={() => void importHackerNewsCookie(profile)}
                      disabled={Boolean(importingHackerNewsCookie)}
                    >
                      <RefreshCw size={15} />
                      {importingHackerNewsCookie === profile.id
                        ? "Importing..."
                        : "Import Chrome cookie"}
                    </button>
                  ) : null}
                  {platform.id === "youtube" ? (
                    <button
                      className="secondary compact-button"
                      type="button"
                      onClick={() => void importYouTubeCookie(profile)}
                      disabled={Boolean(importingYouTubeCookie)}
                    >
                      <RefreshCw size={15} />
                      {importingYouTubeCookie === profile.id
                        ? "Importing..."
                        : "Import Chrome cookies"}
                    </button>
                  ) : null}
                  <button
                    className={
                      confirmDeleteProfile === `${platform.id}:${profile.id}`
                        ? "danger-button compact-button"
                        : "secondary compact-button"
                    }
                    type="button"
                    onClick={() => deleteProfile(platform.id, profile.id)}
                  >
                    <Trash2 size={15} />
                    {confirmDeleteProfile === `${platform.id}:${profile.id}`
                      ? "Confirm delete"
                      : "Delete profile"}
                  </button>
                </div>
              </div>
              <label className="config-field">
                <span>Profile name</span>
                <input
                  value={profile.label}
                  onChange={(event) =>
                    updateProfile(platform.id, profile.id, {
                      ...profile,
                      label: event.target.value
                    })
                  }
                />
              </label>
              {providerFields.map((field) => {
                const fieldValue = profile.values[field.name] || field.defaultValue || "";
                const isBooleanField =
                  field.name === "X_PREMIUM_LONG_POSTS" ||
                  field.name === "DRIBBBLE_LOW_PROFILE" ||
                  field.name === "PINTEREST_HEADLESS" ||
                  field.name === "INSTAGRAM_BROWSER_HEADLESS";
                const issue = fieldIssue(field, profile, platform.id);

                if (isBooleanField) {
                  return (
                    <label
                      className={`config-field ${issue ? "is-invalid" : ""}`}
                      key={field.name}
                    >
                      <span>{field.label}</span>
                      <span className="check-row">
                        <input
                          checked={fieldValue === "true"}
                          onChange={(event) =>
                            updateProfile(platform.id, profile.id, {
                              ...profile,
                              values: {
                                ...profile.values,
                                [field.name]: event.target.checked ? "true" : "false"
                              }
                            })
                          }
                          type="checkbox"
                        />
                        <span>
                          {field.name === "DRIBBBLE_LOW_PROFILE"
                            ? fieldValue === "true"
                              ? "Publish as Low Profile"
                              : "Normal shot profile"
                            : field.name === "PINTEREST_HEADLESS"
                              ? fieldValue === "true"
                                ? "Headless Chrome login"
                                : "Visible Chrome login"
                            : field.name === "INSTAGRAM_BROWSER_HEADLESS"
                              ? fieldValue === "true"
                                ? "Invisible posting"
                                : "Visible browser"
                            : fieldValue === "true"
                              ? "Premium video limit"
                              : "280 chars / 512 MB video"}
                        </span>
                      </span>
                      <span className={`field-hint ${issue ? "is-warning" : ""}`}>
                        {issue?.message || field.help}
                      </span>
                    </label>
                  );
                }

                return (
                  <label
                    className={`config-field ${issue ? "is-invalid" : ""}`}
                    key={field.name}
                  >
                    <span>{field.label}</span>
                    <span className="secret-input">
                      <input
                        type={
                          field.secret && !isSecretVisible(`${profile.id}:${field.name}`)
                            ? "password"
                            : "text"
                        }
                        value={fieldValue}
                        onChange={(event) =>
                          updateProfile(platform.id, profile.id, {
                            ...profile,
                            values: {
                              ...profile.values,
                              [field.name]: event.target.value
                            }
                          })
                        }
                        placeholder={field.name}
                      />
                      {field.secret ? (
                        <button
                          aria-label={
                            isSecretVisible(`${profile.id}:${field.name}`)
                              ? "Hide secret"
                              : "Show secret"
                          }
                          type="button"
                          onClick={() => toggleSecret(`${profile.id}:${field.name}`)}
                        >
                          {isSecretVisible(`${profile.id}:${field.name}`) ? (
                            <EyeOff size={17} />
                          ) : (
                            <Eye size={17} />
                          )}
                        </button>
                      ) : null}
                    </span>
                    <span className={`field-hint ${issue ? "is-warning" : ""}`}>
                      {issue?.message || field.help}
                    </span>
                  </label>
                );
              })}
            </section>
          ))}
        </div>
      </section>
    );
  }

  return (
          <>
            <section className="info-panel socials-disclaimer">
              <div className="panel-heading compact">
                <h2>
                  <AlertTriangle size={18} />
                  Unofficial integrations
                </h2>
              </div>
              <div className="config-panel">
                <p className="hint">
                  Crossposter mixes official APIs with local, unofficial flows. X / Twitter,
                  Instagram, YouTube, Pinterest, and Hacker News may use your own
                  browser sessions, saved cookies, private APIs, or normal web submit flows —
                  all running locally on this machine.
                </p>
                <p className="hint">
                  Instagram and X / Twitter sign in to a dedicated, isolated browser once per
                  account and reuse that real session, so there is no stored password. It is still
                  automation, not an official API.
                </p>
                <p className="hint">
                  Use these only for accounts you own or manage, and keep posting occasional and
                  human-paced. Platforms can change, challenge, rate-limit, reject, or restrict
                  accounts for automated or high-volume activity.
                </p>
              </div>
            </section>
            <div className="socials-masonry">
              {socialColumns.map((column, index) => (
                <div className="socials-column" key={index === 0 ? "primary" : "secondary"}>
                  {column.map((platform) => renderSocialPanel(platform))}
                </div>
              ))}
            </div>
          </>
  );
}
