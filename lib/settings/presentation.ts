export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function normalizeNetworkHost(value: string | undefined): string {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  const withoutProtocol = raw.replace(/^https?:\/\//i, "");
  const hostWithOptionalPort = withoutProtocol.split(/[/?#]/)[0] || "";

  return hostWithOptionalPort.replace(/:\d+$/, "").trim();
}
