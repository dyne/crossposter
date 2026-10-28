"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import NextImage from "next/image";
import { CheckCircle2, Save } from "lucide-react";
import { ProjectLinks } from "@/components/project-links";
import { ThemeToggle } from "@/components/theme-toggle";
import { useSettingsConfig } from "@/components/settings/use-settings-config";
import { useLocalSettings } from "@/components/settings/use-local-settings";
import { useSettingsStorage } from "@/components/settings/use-settings-storage";
import { LocalAppPanel } from "@/components/settings/local-app-panel";
import { NetworkPanel } from "@/components/settings/network-panel";
import { VersionPanel } from "@/components/settings/version-panel";
import { StoragePanel } from "@/components/settings/storage-panel";
import { ProviderSettings } from "@/components/settings/provider-settings";
import { settingsViews } from "@/lib/settings/provider-guides";
import type { SettingsView } from "@/lib/settings/contracts";

export default function SettingsClient({ initialView = "settings" }: { initialView?: SettingsView }) {
  const config = useSettingsConfig();
  const { status, setStatus, saveConfig, isSaving, saveFeedback } = config;
  const local = useLocalSettings(config, config.localUrl);
  const storageState = useSettingsStorage(setStatus);
  const [settingsView, setSettingsView] = useState<SettingsView>(initialView);
  useEffect(() => {
    setSettingsView(initialView);
  }, [initialView]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const section = params.get("section");
    const linkedinMessage = params.get("linkedin");
    const dribbbleMessage = params.get("dribbble");

    if (section === "settings" || section === "storage" || section === "socials") {
      setSettingsView(section);
    }

    const labels: Record<string, string> = {
      connected: "LinkedIn connected and saved locally.",
      token_only:
        "LinkedIn token saved. Add Sign In with LinkedIn using OpenID Connect to auto-fill the profile URN.",
      denied: "LinkedIn authorization was cancelled.",
      failed: "LinkedIn authorization failed.",
      bad_state: "LinkedIn authorization expired. Try Connect LinkedIn again."
    };
    const dribbbleLabels: Record<string, string> = {
      connected: "Dribbble connected and saved locally.",
      denied: "Dribbble authorization was cancelled.",
      failed: "Dribbble authorization failed.",
      bad_state: "Dribbble authorization expired. Try Connect Dribbble again.",
      missing_upload: "Dribbble authorization must include the upload scope.",
      cannot_upload: "This Dribbble account cannot upload shots."
    };

    if (linkedinMessage) {
      setStatus(labels[linkedinMessage] || "LinkedIn authorization finished.");
    } else if (dribbbleMessage) {
      setStatus(dribbbleLabels[dribbbleMessage] || "Dribbble authorization finished.");
    }

    if (section === "settings" || section === "storage" || section === "socials") {
      window.history.replaceState(
        null,
        "",
        settingsViews.find((view) => view.id === section)?.href || window.location.pathname
      );
    } else if (linkedinMessage || dribbbleMessage) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [setStatus]);

  const statusDismissMs = useMemo(() => {
    if (!status) {
      return 0;
    }

    if (/could not|not loaded|failed|error/i.test(status)) {
      return 7000;
    }

    if (/confirm/i.test(status)) {
      return 5000;
    }

    return 2600;
  }, [status]);

  useEffect(() => {
    if (!status) {
      return;
    }

    const timer = window.setTimeout(() => setStatus(""), statusDismissMs);

    return () => window.clearTimeout(timer);
  }, [status, statusDismissMs, setStatus]);


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
            <h1>{settingsViews.find((view) => view.id === settingsView)?.label || "Settings"}</h1>
            <ProjectLinks />
          </div>
        </div>
        <div className="masthead-actions">
          <nav className="top-tabs" aria-label="Primary sections">
            <Link className="top-tab" href="/">
              Dashboard
            </Link>
            <Link className="top-tab" href="/scheduled">
              Scheduler
            </Link>
            {settingsViews.map((view) => (
              <Link
                aria-current={settingsView === view.id ? "page" : undefined}
                className={`top-tab ${settingsView === view.id ? "is-active" : ""}`}
                href={view.href}
                key={view.id}
              >
                {view.label}
              </Link>
            ))}
          </nav>
          <ThemeToggle />
          <button
            className={`primary compact-button masthead-action-slot ${saveFeedback ? "is-saved" : ""}`}
            type="button"
            onClick={saveConfig}
            disabled={isSaving}
          >
            {saveFeedback ? <CheckCircle2 size={17} /> : <Save size={17} />}
            {isSaving ? "Saving..." : saveFeedback ? "Saved locally" : "Save config"}
          </button>
        </div>
      </header>

      <section className="settings-grid">
        {settingsView === "settings" ? <LocalAppPanel config={config} service={local} /> : null}
        {settingsView === "settings" ? (
          <div className="settings-side-column">
            <NetworkPanel config={config} network={local} />
            <VersionPanel version={local} />
          </div>
        ) : null}
        {settingsView === "storage" ? <StoragePanel storageState={storageState} /> : null}
        {settingsView === "socials" ? <ProviderSettings config={config} /> : null}
      </section>

      {status ? (
        <p className="floating-status" role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
    </main>
  );
}
