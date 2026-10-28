"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConfigField } from "@/lib/config-spec";
import { validateConfigField } from "@/lib/config-validation";
import type { Platform, ProviderProfile } from "@/lib/types";
import { loadSettingsConfig, writeSettingsConfig } from "@/lib/settings/client";
import type { ConfigResponse, SettingsConfiguration } from "@/lib/settings/contracts";

const emptyConfiguration: SettingsConfiguration = { values: {}, profiles: {}, activeProfiles: {} };

export type SettingsConfig = ReturnType<typeof useSettingsConfig>;

export function useSettingsConfig() {
  const [fields, setFields] = useState<ConfigField[]>([]);
  const [values, setValues] = useState<SettingsConfiguration["values"]>({});
  const [profiles, setProfiles] = useState<SettingsConfiguration["profiles"]>({});
  const [activeProfiles, setActiveProfiles] = useState<SettingsConfiguration["activeProfiles"]>({});
  const [savedConfiguration, setSavedConfiguration] = useState(emptyConfiguration);
  const [configPath, setConfigPath] = useState("");
  const [localUrl, setLocalUrl] = useState("http://localhost:2004");
  const [status, setStatus] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState(false);
  const [confirmDeleteProfile, setConfirmDeleteProfile] = useState("");
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});

  const applyConfiguration = useCallback((body: ConfigResponse) => {
    const config = { values: body.values || {}, profiles: body.profiles || {}, activeProfiles: body.activeProfiles || {} };
    setValues(config.values);
    setProfiles(config.profiles);
    setActiveProfiles(config.activeProfiles);
    setSavedConfiguration(config);
    setConfigPath(body.configPath || "");
    setLocalUrl(body.localUrl || "http://localhost:2004");
  }, []);

  const loadConfig = useCallback(async () => {
    setIsLoading(true);
    try {
      const body = await loadSettingsConfig();
      setFields(body.fields || []);
      applyConfiguration(body);
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load config.");
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [applyConfiguration]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  const isDirty = useMemo(() => JSON.stringify({ values, profiles, activeProfiles }) !== JSON.stringify(savedConfiguration),
    [values, profiles, activeProfiles, savedConfiguration]);

  function fieldsFor(platform: Platform): ConfigField[] {
    return fields.filter((field) => field.requiredFor?.includes(platform) || field.showFor?.includes(platform));
  }

  function fieldIssue(field: ConfigField, profile: ProviderProfile, platform: Platform) {
    return validateConfigField(field, profile.values[field.name] || field.defaultValue || "", Boolean(field.requiredFor?.includes(platform)));
  }

  function addProfile(platform: Platform) {
    const profile: ProviderProfile = {
      id: `${platform}-${Date.now()}`,
      label: `New ${platform} profile`,
      values: Object.fromEntries(fieldsFor(platform).map((field) => [field.name, field.defaultValue || ""]))
    };
    setProfiles((current) => ({ ...current, [platform]: [...(current[platform] || []), profile] }));
    setActiveProfiles((current) => ({ ...current, [platform]: profile.id }));
  }

  function updateProfile(platform: Platform, profileId: string, nextProfile: ProviderProfile) {
    setProfiles((current) => ({ ...current, [platform]: (current[platform] || []).map((profile) => profile.id === profileId ? nextProfile : profile) }));
  }

  function selectProfile(platform: Platform, profileId: string) {
    setActiveProfiles((current) => ({ ...current, [platform]: profileId }));
  }

  function deleteProfile(platform: Platform, profileId: string) {
    const key = `${platform}:${profileId}`;
    if (confirmDeleteProfile !== key) {
      setConfirmDeleteProfile(key);
      setStatus("Confirm profile delete first.");
      return;
    }
    const remaining = (profiles[platform] || []).filter((profile) => profile.id !== profileId);
    setProfiles((current) => ({ ...current, [platform]: remaining }));
    setActiveProfiles((current) => current[platform] !== profileId ? current : { ...current, [platform]: remaining[0]?.id || "" });
    setConfirmDeleteProfile("");
    setStatus("Profile removed. Save config to keep this change.");
  }

  function isSecretVisible(key: string): boolean { return Boolean(visibleSecrets[key]); }
  function toggleSecret(key: string) { setVisibleSecrets((current) => ({ ...current, [key]: !current[key] })); }

  async function saveConfig(): Promise<boolean> {
    setStatus(""); setSaveFeedback(false); setIsSaving(true);
    try {
      const body = await writeSettingsConfig({ values, profiles, activeProfiles });
      // Preserve the existing response-wins behavior while a save is pending.
      applyConfiguration(body);
      setStatus("Saved locally."); setSaveFeedback(true);
      window.setTimeout(() => setSaveFeedback(false), 1600);
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save config.");
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  return { fields, values, setValues, profiles, setProfiles, activeProfiles, setActiveProfiles,
    configPath, setConfigPath, localUrl, setLocalUrl, status, setStatus, isLoading, isSaving, setIsSaving,
    saveFeedback, isDirty, savedConfiguration, confirmDeleteProfile, fieldsFor, fieldIssue,
    addProfile, updateProfile, selectProfile, deleteProfile, isSecretVisible, toggleSecret, loadConfig, saveConfig, applyConfiguration };
}
