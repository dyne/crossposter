"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppVersionResponse, LocalServiceResponse, TailscaleResponse } from "@/lib/settings/contracts";
import { changeLocalService, readLocalService, readTailscale, readAppVersion, requestAppUpdate, writeSettingsConfig, openLocalResource, copyToClipboard } from "@/lib/settings/client";
import { normalizeNetworkHost } from "@/lib/settings/presentation";
import type { SettingsConfig } from "./use-settings-config";
type LocalConfig = Pick<SettingsConfig, "values" | "profiles" | "activeProfiles" | "setValues" | "setStatus" | "configPath" | "saveConfig" | "applyConfiguration">;
export function useLocalSettings({ values, profiles, activeProfiles, setValues, setStatus, configPath, saveConfig, applyConfiguration }: LocalConfig, localUrl: string) {
  const [localService, setLocalService] = useState<LocalServiceResponse | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleResponse | null>(null);
  const [appVersion, setAppVersion] = useState<AppVersionResponse | null>(null);
  const [showTailscaleInfo, setShowTailscaleInfo] = useState(false);
  const [isTogglingLocalService, setIsTogglingLocalService] = useState(false);
  const [isUpdatingApp, setIsUpdatingApp] = useState(false);
  const [isCheckingAppVersion, setIsCheckingAppVersion] = useState(false);
  const [isTogglingAutoUpdate, setIsTogglingAutoUpdate] = useState(false);
  const displayLocalUrl = useMemo(() => {
    const port = values.POSTER_LOCAL_PORT?.trim();

    return port && /^\d+$/.test(port) ? `http://localhost:${port}` : localUrl;
  }, [localUrl, values.POSTER_LOCAL_PORT]);
  const displayTailscaleHost = useMemo(
    () =>
      normalizeNetworkHost(values.POSTER_TAILSCALE_HOST) ||
      normalizeNetworkHost(tailscale?.host) ||
      normalizeNetworkHost(tailscale?.detectedIp),
    [tailscale?.detectedIp, tailscale?.host, values.POSTER_TAILSCALE_HOST]
  );
  const displayTailscaleUrl = useMemo(() => {
    const port = values.POSTER_LOCAL_PORT?.trim();
    const normalizedPort = port && /^\d+$/.test(port) ? port : tailscale?.port || "2004";

    return displayTailscaleHost ? `http://${displayTailscaleHost}:${normalizedPort}` : "";
  }, [displayTailscaleHost, tailscale?.port, values.POSTER_LOCAL_PORT]);
  const managedByHomebrew = Boolean(appVersion?.managedByHomebrew);
  const autoUpdateEnabled = !managedByHomebrew && values.POSTER_AUTO_UPDATE !== "false";
  const versionSummary = useMemo(() => {
    if (!appVersion) {
      return "Checking the installed Crossposter package.";
    }

    if (appVersion.latestError) {
      return appVersion.latestError;
    }

    if (appVersion.updateAvailable) {
      return `Update available: ${appVersion.latestVersion}. Restart after updating.`;
    }

    return managedByHomebrew
      ? "You are on the latest version available to Homebrew."
      : "You are on the latest version published to npm.";
  }, [appVersion, managedByHomebrew]);
  const versionActionIsUpdate = Boolean(appVersion?.updateAvailable);
  const versionActionBusy = isUpdatingApp || isCheckingAppVersion;
  const versionAlreadyCurrent = Boolean(
    appVersion && !appVersion.updateAvailable && appVersion.latestVersion && !appVersion.latestError
  );
  const versionActionLabel = isUpdatingApp
    ? "Updating..."
    : isCheckingAppVersion
      ? "Checking..."
      : versionActionIsUpdate
        ? "Update now"
        : "Check for update";
  const tailscaleSummary = useMemo(() => {
    if (!tailscale) {
      return "Checking Tailscale status...";
    }

    if (displayTailscaleUrl && values.POSTER_TAILSCALE_HOST?.trim()) {
      return "Using the host saved in config. Change it here if your Tailnet name or 100.x IP changes.";
    }

    if (tailscale.running && displayTailscaleUrl) {
      return "Detected from this Mac. Open this URL on a phone signed in to the same Tailnet.";
    }

    if (tailscale.installed) {
      return tailscale.error || "Tailscale is installed, but this Mac is not connected right now.";
    }

    return "Tailscale was not detected. Install or start Tailscale, then refresh.";
  }, [displayTailscaleUrl, tailscale, values.POSTER_TAILSCALE_HOST]);
  const localServiceSummary = useMemo(() => {
    if (!localService) {
      return "Checking macOS auto-start status...";
    }

    if (!localService.supported) {
      return "macOS LaunchAgent controls are not available on this system.";
    }

    if (localService.manager === "homebrew" && localService.legacyServiceInstalled) {
      return "A legacy Crossposter LaunchAgent is installed. Remove it before enabling the Homebrew service.";
    }

    if (localService.installed && localService.running) {
      return `On. macOS will start Crossposter after login and keep ${displayLocalUrl} running.`;
    }

    if (localService.installed) {
      return `On for http://localhost:${localService.port}, but the service is not running right now.`;
    }

    return "Off. Turn this on once so macOS starts Crossposter after login and restarts it if it exits.";
  }, [displayLocalUrl, localService]);

  async function loadLocalService() {
    try {
      const { ok, body } = await readLocalService();

      if (ok) {
        setLocalService(body);
      }
    } catch {}
  }

  async function loadTailscale() {
    try {
      const { ok, body } = await readTailscale();

      if (ok) {
        setTailscale(body);
      }
    } catch {}
  }

  const loadAppVersion = useCallback(async (options: { showStatus?: boolean } = {}) => {
    if (options.showStatus) {
      setStatus("");
      setIsCheckingAppVersion(true);
    }

    try {
      const { ok, body } = await readAppVersion();

      if (ok) {
        setAppVersion(body);
        setValues((current) => ({
          ...current,
          POSTER_AUTO_UPDATE: body.autoUpdate ? "true" : "false"
        }));

        if (options.showStatus) {
          if (body.latestError) {
            setStatus(body.latestError);
          } else if (body.updateAvailable) {
            setStatus(`Update available: ${body.latestVersion}.`);
          } else {
            setStatus("Already updated.");
          }
        }
      } else if (options.showStatus) {
        setStatus(body.message || body.latestError || "Could not check Crossposter version.");
      }
    } catch (error) {
      if (options.showStatus) {
        setStatus(error instanceof Error ? error.message : "Could not check Crossposter version.");
      }
    } finally {
      if (options.showStatus) {
        setIsCheckingAppVersion(false);
      }
    }
  }, [setStatus, setValues]);

  async function toggleLocalService(enabled: boolean) {
    setStatus("");
    setIsTogglingLocalService(true);

    try {
      if (enabled) {
        const saved = await saveConfig();

        if (!saved) {
          return;
        }
      }

      const { ok, body } = await changeLocalService(enabled);

      setLocalService(body);

      if (!ok) {
        setStatus(body.error || "Could not update local auto-start.");
        return;
      }

      setStatus(
        enabled
          ? `Auto-start enabled for http://localhost:${body.port}.`
          : "Auto-start disabled."
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update local auto-start.");
    } finally {
      setIsTogglingLocalService(false);
    }
  }

  async function toggleAutoUpdate(enabled: boolean) {
    setStatus("");
    setIsTogglingAutoUpdate(true);

    const nextValues = {
      ...values,
      POSTER_AUTO_UPDATE: enabled ? "true" : "false"
    };

    setValues(nextValues);

    try {
      const body = await writeSettingsConfig({ values: nextValues, profiles, activeProfiles }, "Could not save auto-update setting.");
      applyConfiguration({ ...body, values: body.values || nextValues, profiles: body.profiles || profiles, activeProfiles: body.activeProfiles || activeProfiles });
      setAppVersion((current) => (current ? { ...current, autoUpdate: enabled } : current));
      setStatus(enabled ? "Auto-update enabled." : "Auto-update disabled.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save auto-update setting.");
    } finally {
      setIsTogglingAutoUpdate(false);
    }
  }

  async function updateAppPackage() {
    setStatus("");
    setIsUpdatingApp(true);

    try {
      const { ok, body } = await requestAppUpdate();

      setAppVersion(body);

      if (!ok || body.ok === false) {
        setStatus(body.message || body.error || "Could not update Crossposter.");
        return;
      }

      setStatus(body.message || "Crossposter update downloaded. Restart to use it.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update Crossposter.");
    } finally {
      setIsUpdatingApp(false);
    }
  }

  async function openConfigFile() {
    setStatus("");

    try {
      const { ok, body } = await openLocalResource("config");

      if (!ok) {
        setStatus(body.error || "Could not open config file.");
        return;
      }

      setStatus("Opened local config file.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open config file.");
    }
  }

  async function copyConfigPath() {
    if (!configPath) {
      setStatus("Config path is not loaded yet.");
      return;
    }

    try {
      await copyToClipboard(configPath);
      setStatus("Copied config path.");
    } catch {
      setStatus(configPath);
    }
  }

  async function copyTailscaleUrl() {
    if (!displayTailscaleUrl) {
      setStatus("No Tailscale URL is available yet.");
      return;
    }

    try {
      await copyToClipboard(displayTailscaleUrl);
      setStatus("Copied Tailscale URL.");
    } catch {
      setStatus(displayTailscaleUrl);
    }
  }

  async function copyText(value: string) {
    try {
      await copyToClipboard(value);
      setStatus("Copied.");
    } catch {
      setStatus(value);
    }
  }


  useEffect(() => { void loadLocalService(); void loadTailscale(); void loadAppVersion(); }, [loadAppVersion]);
  return { localService, localServiceSummary, isTogglingLocalService, toggleLocalService, loadLocalService, displayLocalUrl,
    openConfigFile, copyConfigPath, tailscale, displayTailscaleUrl, tailscaleSummary, showTailscaleInfo, setShowTailscaleInfo, loadTailscale, copyTailscaleUrl,
    appVersion, versionSummary, isCheckingAppVersion, loadAppVersion, managedByHomebrew, autoUpdateEnabled, isTogglingAutoUpdate, toggleAutoUpdate,
    versionActionIsUpdate, versionActionBusy, versionActionLabel, versionAlreadyCurrent, updateAppPackage, copyText };
}
