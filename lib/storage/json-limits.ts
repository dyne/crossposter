import "server-only";

export const maxJsonStorageBytes = 64 * 1024 * 1024;

// Include the persisted newline, and count UTF-8 bytes rather than JS UTF-16
// code units. A caller must reject overflow before touching the previous file.
export function serializeStoredJson(value: unknown, maxBytes = maxJsonStorageBytes): string {
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new RangeError("Local JSON storage size limit exceeded.");
  return serialized;
}
