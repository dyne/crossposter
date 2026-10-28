import type { ConfigResponse, SettingsConfiguration } from "./contracts";
import type { AppVersionResponse, LocalServiceResponse, StorageResponse, TailscaleResponse } from "./contracts";

type ActionMessage = { error?: string; message?: string };

async function settingsRequest<T>(url: string, init: RequestInit): Promise<{ ok: boolean; body: T }> {
  const response = await fetch(url, init);
  return { ok: response.ok, body: await response.json() as T };
}

export const readSettingsStorage = () => settingsRequest<StorageResponse>("/api/storage", { cache: "no-store" });
export const clearSettingsStorage = () => settingsRequest<StorageResponse & ActionMessage>("/api/storage", { method: "DELETE" });
export const readLocalService = () => settingsRequest<LocalServiceResponse>("/api/local-service", { cache: "no-store" });
export const changeLocalService = (enabled: boolean) => settingsRequest<LocalServiceResponse>("/api/local-service", { method: enabled ? "POST" : "DELETE" });
export const readTailscale = () => settingsRequest<TailscaleResponse>("/api/network/tailscale", { cache: "no-store" });
export const readAppVersion = () => settingsRequest<AppVersionResponse>("/api/app-version", { cache: "no-store" });
export const requestAppUpdate = () => settingsRequest<AppVersionResponse & ActionMessage>("/api/app-version", { method: "POST" });

export function importProviderCookie(provider: "hackernews" | "youtube", profileId: string) {
  return settingsRequest<ActionMessage>(`/api/auth/${provider}/import-cookie`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId })
  });
}

export function loginProviderBrowser(provider: "instagram" | "x", profileId: string) {
  return settingsRequest<ActionMessage>(`/api/auth/${provider}/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileId })
  });
}

export function openLocalResource(resource: "config" | "storage") {
  return settingsRequest<ActionMessage>(`/api/${resource}/open`, { method: "POST" });
}

export function startProviderOAuth(provider: "linkedin" | "dribbble", profileId: string) {
  const startUrl = new URL(`/api/auth/${provider}/start`, window.location.origin);
  startUrl.searchParams.set("profileId", profileId);
  window.location.assign(startUrl.toString());
}

export function copyToClipboard(value: string) { return navigator.clipboard.writeText(value); }

async function configRequest(init: RequestInit, fallback: string): Promise<ConfigResponse> {
  const response = await fetch("/api/config", init);
  const body = (await response.json()) as ConfigResponse & { error?: string };
  if (!response.ok) throw new Error(body.error || fallback);
  return body;
}

export function loadSettingsConfig(): Promise<ConfigResponse> {
  return configRequest({ cache: "no-store" }, "Could not load config.");
}

export function writeSettingsConfig(config: SettingsConfiguration, fallback = "Could not save config."): Promise<ConfigResponse> {
  return configRequest({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config)
  }, fallback);
}
