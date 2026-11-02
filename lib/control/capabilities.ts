import { channels } from "@/lib/compose/channels";
import type { Platform } from "@/lib/platform-catalog";
import type { ControlTarget } from "./contracts";

// Whether the channel consumes each composer field. This does not promise that
// any particular media kind/size is valid or that a provider login was checked.
// Reuse the dashboard's browser-safe metadata rather than a second rule table.
export function controlCapabilities(platform: Platform): ControlTarget["capabilities"] {
  const uses = channels.find((channel) => channel.id === platform)?.uses ?? [];
  return { text: uses.includes("Post"), title: uses.includes("Title"), singleMedia: uses.includes("Media") };
}
