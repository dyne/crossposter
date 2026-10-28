"use client";

import { useState } from "react";
import type { ProviderProfile } from "@/lib/types";
import type { SettingsConfig } from "./use-settings-config";
import { importProviderCookie, loginProviderBrowser, startProviderOAuth, writeSettingsConfig } from "@/lib/settings/client";

type ConnectionConfig = Pick<SettingsConfig, "values" | "profiles" | "activeProfiles" | "setStatus" | "setIsSaving" | "saveConfig" | "loadConfig">;

export function useProviderConnections({ values, profiles, activeProfiles, setStatus, setIsSaving, saveConfig, loadConfig }: ConnectionConfig) {
  const [importingHackerNewsCookie, setImportingHackerNewsCookie] = useState("");
  const [importingYouTubeCookie, setImportingYouTubeCookie] = useState("");
  const [connectingInstagram, setConnectingInstagram] = useState("");
  const [connectingX, setConnectingX] = useState("");
  async function connectLinkedIn(profile: ProviderProfile) {
    const clientId = profile.values.LINKEDIN_CLIENT_ID?.trim();
    const clientSecret = profile.values.LINKEDIN_CLIENT_SECRET?.trim();

    if (!clientId || !clientSecret) {
      setStatus("Add LinkedIn client ID and client secret first.");
      return;
    }

    setStatus("");
    setIsSaving(true);

    try {
      await writeSettingsConfig({ values, profiles, activeProfiles }, "Could not save config before connecting LinkedIn.");
      startProviderOAuth("linkedin", profile.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not connect LinkedIn.");
    } finally {
      setIsSaving(false);
    }
  }

  async function connectDribbble(profile: ProviderProfile) {
    const clientId = profile.values.DRIBBBLE_CLIENT_ID?.trim();
    const clientSecret = profile.values.DRIBBBLE_CLIENT_SECRET?.trim();
    const scopes = profile.values.DRIBBBLE_OAUTH_SCOPES?.trim() || "public upload";

    if (!clientId || !clientSecret) {
      setStatus("Add Dribbble client ID and client secret first.");
      return;
    }

    if (!scopes.split(/[\s,]+/).includes("upload")) {
      setStatus("Dribbble OAuth scopes must include upload.");
      return;
    }

    setStatus("");
    setIsSaving(true);

    try {
      await writeSettingsConfig({ values, profiles, activeProfiles }, "Could not save config before connecting Dribbble.");
      startProviderOAuth("dribbble", profile.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not connect Dribbble.");
    } finally {
      setIsSaving(false);
    }
  }

  async function importHackerNewsCookie(profile: ProviderProfile) {
    setStatus("");
    setImportingHackerNewsCookie(profile.id);

    try {
      const saved = await saveConfig();

      if (!saved) {
        return;
      }

      const { ok, body } = await importProviderCookie("hackernews", profile.id);

      if (!ok) {
        setStatus(body.error || "Could not import Hacker News cookie from Chrome.");
        return;
      }

      if (!(await loadConfig())) return;
      setStatus(body.message || "Imported Hacker News session from Chrome.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not import Hacker News cookie from Chrome.");
    } finally {
      setImportingHackerNewsCookie("");
    }
  }

  async function importYouTubeCookie(profile: ProviderProfile) {
    setStatus("");
    setImportingYouTubeCookie(profile.id);

    try {
      const saved = await saveConfig();

      if (!saved) {
        return;
      }

      const { ok, body } = await importProviderCookie("youtube", profile.id);

      if (!ok) {
        setStatus(body.error || "Could not import YouTube cookies from Chrome.");
        return;
      }

      if (!(await loadConfig())) return;
      setStatus(body.message || "Imported YouTube cookies from Chrome.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not import YouTube cookies from Chrome.");
    } finally {
      setImportingYouTubeCookie("");
    }
  }

  async function connectInstagram(profile: ProviderProfile) {
    setConnectingInstagram(profile.id);
    setStatus("A browser window is opening. Sign in to Instagram (including any 2FA), then it saves and closes.");

    try {
      const saved = await saveConfig();

      if (!saved) {
        return;
      }

      const { ok, body } = await loginProviderBrowser("instagram", profile.id);

      if (!ok) {
        setStatus(body.error || "Could not complete the Instagram browser login.");
        return;
      }

      if (!(await loadConfig())) return;
      setStatus(body.message || "Instagram session saved for this profile.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not complete the Instagram browser login.");
    } finally {
      setConnectingInstagram("");
    }
  }

  async function connectX(profile: ProviderProfile) {
    setConnectingX(profile.id);
    setStatus("A browser window is opening. Sign in to X (including any 2FA), then it saves and closes.");

    try {
      const saved = await saveConfig();

      if (!saved) {
        return;
      }

      const { ok, body } = await loginProviderBrowser("x", profile.id);

      if (!ok) {
        setStatus(body.error || "Could not complete the X browser login.");
        return;
      }

      if (!(await loadConfig())) return;
      setStatus(body.message || "X session saved for this profile.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not complete the X browser login.");
    } finally {
      setConnectingX("");
    }
  }


  return { importingHackerNewsCookie, importingYouTubeCookie, connectingInstagram, connectingX, connectLinkedIn, connectDribbble, importHackerNewsCookie, importYouTubeCookie, connectInstagram, connectX };
}
