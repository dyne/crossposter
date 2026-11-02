import { storedMediaSizeLimit } from "@/lib/platform-limits";

// Shared configuration parsing only; no filesystem reads or provider imports.
// The later bridge authorizes realpaths/symlinks within these explicit roots.
export function controlMediaSettings(value: (name: string) => string | undefined) {
  const number = (name: string, fallback: number, ceiling: number) => {
    const text = value(name);
    if (text === undefined || text === "") return fallback;
    const parsed = Number(text);
    if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(parsed) || parsed > ceiling) throw new Error("Invalid media configuration");
    return parsed;
  };
  let roots: unknown;
  try { roots = JSON.parse(value("CROSSPOSTER_MCP_MEDIA_ROOTS") || "[]"); } catch { throw new Error("Invalid media configuration"); }
  if (!Array.isArray(roots) || roots.length > 16 || roots.some((root) => typeof root !== "string" || !root.startsWith("/") || root.length > 4096 || root.includes("\0"))) throw new Error("Invalid media configuration");
  return { localRoots: [...new Set(roots as string[])],
    maxBytes: number("CROSSPOSTER_MCP_UPLOAD_MAX_BYTES", 512 * 1024 * 1024, storedMediaSizeLimit),
    timeoutMs: number("CROSSPOSTER_MCP_UPLOAD_TIMEOUT_MS", 900_000, 900_000) };
}
