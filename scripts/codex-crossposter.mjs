#!/usr/bin/env node
// User-invoked debug host. Never starts the backend, copies auth or runs a model turn.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, createWriteStream, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const usage = `Usage: node scripts/codex-crossposter.mjs --data-dir <absolute-directory>
  --endpoint http://127.0.0.1:2004 [--media-root <absolute-directory>]... [--console]
  [--state-home <absolute-directory>] [--codex <executable>]

Default: raw app-server stdio; stdout is protocol only. --console provides a small
direct-tool console (not Codex TUI). State defaults to ~/.codex-crossposter.
Private logs: <state-home>/crossposter-debug/<unique-run>/. No backend is started.
No auth/config is copied. See MCP_SETUP.md for fresh login, fixtures and recovery.`;
const toolNames = new Set(["get_status", "list_targets", "get_draft", "save_draft", "clear_draft", "upload_media", "get_media", "prepare_action", "get_action", "commit_action", "list_posts", "get_post", "list_scheduled_posts"]);
const safeMethods = new Set(["initialize", "initialized", "thread/start", "mcpServerStatus/list", "mcpServer/tool/call", "mcpServer/startupStatus/updated"]);
const utc = () => new Date().toISOString();

function options(args) {
  const result = { mediaRoots: [], stateHome: path.join(homedir(), ".codex-crossposter"), codex: "codex", console: false };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--console") { result.console = true; continue; }
    const key = { "--data-dir": "data", "--endpoint": "endpoint", "--state-home": "stateHome", "--codex": "codex", "--media-root": "media" }[name];
    if (!key || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("usage");
    const value = args[++index];
    if (key === "media") result.mediaRoots.push(value); else result[key] = value;
  }
  if (!result.data || !result.endpoint || !path.isAbsolute(result.stateHome) || !path.isAbsolute(result.data) || result.mediaRoots.length > 16) throw new Error("usage");
  const endpoint = new URL(result.endpoint);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname) || endpoint.origin !== result.endpoint || endpoint.username || endpoint.password) throw new Error("usage");
  for (const directory of [result.data, ...result.mediaRoots]) if (!path.isAbsolute(directory) || !lstatSync(directory).isDirectory()) throw new Error("usage");
  return result;
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("private_directory_required");
}

function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

// Deliberately exclude inherited account/owner/API tokens and Gestalt control variables.
function childEnvironment(crossposterCodexHome) {
  const names = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"];
  return { ...Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])), CODEX_HOME: crossposterCodexHome };
}

function observe(stream, direction, record) {
  let buffered = "";
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk) => {
    buffered += decoder.write(chunk);
    if (buffered.length > 1024 * 1024) { record({ event: "protocol-frame-too-large", direction }); buffered = ""; return; }
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line);
        const method = safeMethods.has(frame.method) ? frame.method : frame.method ? "other" : undefined;
        const event = { event: "protocol-frame", direction, ...(method ? { method } : {}), response: Object.hasOwn(frame, "result"), error: Object.hasOwn(frame, "error") };
        const version = typeof frame.result?.userAgent === "string" ? /codex[^0-9]{0,20}(\d+\.\d+\.\d+)/i.exec(frame.result.userAgent)?.[1] : undefined;
        if (version) event.codexVersion = version;
        record(event); // Never arguments, results, IDs, passwords or tokens.
      } catch { record({ event: "protocol-invalid-json", direction }); }
    }
  });
}

async function consoleSession(child, config, record, stop) {
  let sequence = 0, buffered = "", threadId;
  const decoder = new StringDecoder("utf8");
  const pending = new Map();
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const rejectPending = () => { for (const waiter of pending.values()) waiter.reject(new Error("host_closed")); };
  child.once("close", rejectPending);
  child.stdout.on("data", (chunk) => {
    buffered += decoder.write(chunk);
    if (buffered.length > 1024 * 1024) { rejectPending(); stop("console_frame_limit"); return; }
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      try {
        const frame = JSON.parse(line);
        const waiter = pending.get(frame.id);
        if (waiter) frame.error ? waiter.reject(new Error("rpc_failed")) : waiter.resolve(frame.result);
        else if (frame.id !== undefined && frame.method) send({ id: frame.id, error: { code: -32601, message: "Manual console does not handle interactive host requests." } });
      } catch { rejectPending(); stop("console_invalid_json"); }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) { reject(new Error("host_closed")); return; }
    const id = ++sequence;
    const timeout = method === "mcpServer/tool/call" && params.tool === "upload_media" ? 910_000 : 45_000;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("rpc_timeout")); }, timeout);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); pending.delete(id); resolve(value); }, reject: (error) => { clearTimeout(timer); pending.delete(id); reject(error); } });
    send({ id, method, params });
  });
  const connect = async () => {
    const identity = await request("initialize", { clientInfo: { name: "crossposter-manual-debug", version: "1" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    const thread = await request("thread/start", { ephemeral: true, cwd: config.stateHome, approvalPolicy: "never", sandbox: "workspace-write" });
    threadId = thread.thread.id;
    record({ event: "console-initialized", identityObserved: Boolean(identity), ephemeral: true });
  };
  const tools = async () => {
    const inventory = await request("mcpServerStatus/list", { threadId, detail: "full", limit: 100 });
    if (inventory.nextCursor || inventory.data.some((server) => server.name !== "crossposter" && Object.keys(server.tools).length)) throw new Error("unexpected_inventory");
    return inventory;
  };
  await connect();
  process.stderr.write("Manual tool console: tools | call <tool> <JSON object> | quit. No model turns or owner decisions are automated.\n");
  const input = createInterface({ input: process.stdin, output: process.stderr, terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY), historySize: 0 });
  child.once("close", () => input.close());
  try {
    for await (const line of input) {
      if (line.trim() === "quit") break;
      try {
        if (line.trim() === "tools") process.stdout.write(`${JSON.stringify(await tools(), null, 2)}\n`);
        else {
          const match = /^call ([a-z_]+) (\{.*\})$/.exec(line.trim());
          if (!match || !toolNames.has(match[1])) throw new Error("console_usage");
          const argumentsValue = JSON.parse(match[2]);
          const result = await request("mcpServer/tool/call", { threadId, server: "crossposter", tool: match[1], arguments: argumentsValue });
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          const approval = result.structuredContent?.data?.approvalUrl;
          if (typeof approval === "string" && /^\/approvals\/[A-Za-z0-9_-]+$/.test(approval)) process.stderr.write(`Open locally for independent owner review: ${config.endpoint}${approval}\n`);
        }
      } catch { process.stderr.write("Command failed. Check syntax, the structured tool result and private debug logs. No action was retried.\n"); }
    }
  } finally { input.close(); child.stdin.end(); stop("console_closed", undefined, true); }
}

async function main() {
  if (process.argv.slice(2).length === 1 && ["--help", "-h"].includes(process.argv[2])) { process.stdout.write(`${usage}\n`); return; }
  const config = options(process.argv.slice(2));
  const crossposterCodexHome = path.resolve(config.stateHome);
  const reserved = [path.join(homedir(), ".codex"), path.join(homedir(), ".codex-gestalt"), process.env.CODEX_HOME].filter(Boolean).map((name) => path.resolve(name));
  if (reserved.includes(crossposterCodexHome)) throw new Error("separate_home_required");
  process.umask(0o077);
  privateDirectory(crossposterCodexHome);
  config.stateHome = realpathSync(crossposterCodexHome);
  privateDirectory(path.join(config.stateHome, "crossposter-debug"));
  const runDirectory = path.join(config.stateHome, "crossposter-debug", `${utc().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`);
  privateDirectory(runDirectory);
  privateDirectory(path.join(runDirectory, "codex-log"));
  privateDirectory(path.join(config.stateHome, "sqlite"));
  const lifecycle = (entry) => appendFileSync(path.join(runDirectory, "lifecycle.jsonl"), `${JSON.stringify({ observedAt: utc(), ...entry })}\n`, { mode: 0o600 });
  const protocol = (entry) => appendFileSync(path.join(runDirectory, "protocol.jsonl"), `${JSON.stringify({ observedAt: utc(), ...entry })}\n`, { mode: 0o600 });
  writeFileSync(path.join(runDirectory, "protocol.jsonl"), "", { flag: "wx", mode: 0o600 });
  const stderrLog = createWriteStream(path.join(runDirectory, "stderr.log"), { flags: "wx", mode: 0o600 });
  const version = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
  lifecycle({ event: "start", appVersion: version, codexVersion: null, stateHome: config.stateHome, cwd: config.stateHome, endpoint: config.endpoint, dataRoot: config.data, mediaRoots: config.mediaRoots, mode: config.console ? "console" : "stdio" });
  process.stderr.write(`Crossposter Codex debug logs: ${runDirectory}\n`);
  const mediaLimits = Object.fromEntries(["CROSSPOSTER_MCP_UPLOAD_MAX_BYTES", "CROSSPOSTER_MCP_UPLOAD_TIMEOUT_MS"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const mcp = { crossposter: { command: process.execPath, args: [path.join(appRoot, "bin/crossposter-mcp.mjs")], cwd: appRoot, tool_timeout_sec: 930, env: { CROSSPOSTER_DATA_DIR: config.data, CROSSPOSTER_MCP_ENDPOINT: config.endpoint, CROSSPOSTER_MCP_MEDIA_ROOTS: JSON.stringify(config.mediaRoots), ...mediaLimits } } };
  const overrides = { mcp_servers: mcp, "features.apps": false, "plugins._default.enabled": false, log_dir: path.join(runDirectory, "codex-log"), sqlite_home: path.join(config.stateHome, "sqlite"), "history.persistence": "none", cli_auth_credentials_store: "file", approval_policy: "never", sandbox_mode: "workspace-write" };
  const args = ["app-server", "--stdio", ...Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`])];
  const child = spawn(config.codex, args, { cwd: config.stateHome, env: childEnvironment(config.stateHome), detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  let spawnFailure, requestedSignal, killTimer, ended = false, consoleFailure = false;
  const signalChild = (signal) => {
    if (ended || !child.pid) return;
    try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") lifecycle({ event: "signal_failed", signal }); }
  };
  const stop = (reason, signal = "SIGTERM", graceful = false) => {
    if (ended || killTimer) return;
    lifecycle({ event: "shutdown", reason, ...(signal ? { signal } : {}) });
    if (!graceful) signalChild(signal);
    killTimer = setTimeout(() => { signalChild("SIGTERM"); killTimer = setTimeout(() => signalChild("SIGKILL"), 5000); killTimer.unref(); }, graceful ? 5000 : 1000);
    killTimer.unref();
  };
  const handlers = Object.fromEntries(["SIGINT", "SIGTERM"].map((signal) => [signal, () => { requestedSignal = signal; stop("parent_signal", signal); }]));
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  child.once("spawn", () => lifecycle({ event: "spawn", childPid: child.pid }));
  child.once("error", (error) => { spawnFailure = error.code || "spawn_error"; lifecycle({ event: "startup_failure", code: spawnFailure }); stderrLog.write(`Codex process could not start (${spawnFailure}).\n`); });
  child.stdin.on("error", () => { /* closed host input is recorded by close/error */ });
  child.stderr.pipe(stderrLog);
  observe(child.stdout, "host-to-client", protocol);
  const stdoutClosed = () => stop("stdout_closed");
  if (config.console) void consoleSession(child, config, lifecycle, stop).catch(() => { consoleFailure = true; lifecycle({ event: "console_startup_failure" }); stop("console_startup_failure"); });
  else {
    process.stdout.on("error", stdoutClosed);
    observe(process.stdin, "client-to-host", protocol);
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout, { end: false });
    process.stdin.once("end", () => stop("stdin_eof", undefined, true));
  }
  const result = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  ended = true;
  clearTimeout(killTimer);
  for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
  process.stdout.removeListener("error", stdoutClosed);
  process.stdin.unpipe(child.stdin); process.stdin.pause();
  if (!stderrLog.writableEnded) stderrLog.end();
  await finished(stderrLog);
  const exitCode = spawnFailure ? 127 : requestedSignal ? requestedSignal === "SIGINT" ? 130 : 143 : consoleFailure ? 1 : result.signal ? result.signal === "SIGINT" ? 130 : result.signal === "SIGTERM" ? 143 : 1 : result.code;
  lifecycle({ event: "end", exitCode, childExit: result.code, signal: result.signal, requestedSignal: requestedSignal || null });
  process.exitCode = exitCode;
}

main().catch(() => { process.stderr.write(`Crossposter Codex debug launch refused. Use private absolute paths and a separate state home.\n${usage}\n`); process.exitCode = 2; });
