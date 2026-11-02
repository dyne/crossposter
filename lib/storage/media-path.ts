import "server-only";
import path from "node:path";

const mediaIdPattern = /^[a-f0-9-]{36}(?:\.[a-z0-9]{1,12})?$/i;

export function mediaFilePath(directory: string, id: string): string {
  if (!mediaIdPattern.test(id)) throw new Error("Invalid media id");
  return path.join(directory, id);
}
