import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { bridgeConfig } from "./config";
import { createBridgeServer } from "./server";

export function startBridge(version: string) {
  const config = bridgeConfig(process.env);
  const lifetime = new AbortController(); let warned = false; let closing = false;
  const handle = serveStdio(() => createBridgeServer(config, version, lifetime.signal), {
    legacy: "serve", transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }),
    onerror: () => { if (!warned) { warned = true; process.stderr.write("Crossposter MCP protocol connection failed.\n"); } }
  });
  const close = () => {
    if (closing) return; closing = true; lifetime.abort();
    void handle.close().catch(() => { process.exitCode = 1; });
  };
  process.stdin.once("end", close);
  process.once("SIGINT", close); process.once("SIGTERM", close);
}
