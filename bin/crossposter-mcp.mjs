#!/usr/bin/env node
// Dedicated entry: never invoke the dashboard launcher, updater or browser opener.
import { readFileSync } from "node:fs";
try {
  if (process.argv.length !== 2) throw new Error();
  const { startBridge } = await import("../dist/mcp/mcp/main.js");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  startBridge(version);
} catch {
  process.stderr.write("Crossposter MCP startup refused. Build the bridge and configure CROSSPOSTER_DATA_DIR, CROSSPOSTER_MCP_ENDPOINT and CROSSPOSTER_MCP_MEDIA_ROOTS. Start the persistent backend separately: CROSSPOSTER_RUN_MODE=production crossposter --host 127.0.0.1 --no-open --no-update --data-dir <absolute-data-directory>\n");
  process.exitCode = 1;
}
