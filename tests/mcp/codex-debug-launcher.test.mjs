import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const launcher = path.join(repository, "scripts/codex-crossposter.mjs");
const names = ["get_status", "list_targets", "get_draft", "save_draft", "clear_draft", "upload_media", "get_media", "prepare_action", "get_action", "commit_action", "list_posts", "get_post", "list_scheduled_posts"];
function fixture(mode = "echo") {
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-codex-fake-"));
  const home = path.join(root, "caller home ü"), data = path.join(root, "data directory"), media = path.join(root, "media ü");
  for (const directory of [home, data, media, path.join(home, ".codex")]) mkdirSync(directory, { mode: 0o700 });
  writeFileSync(path.join(home, ".codex/auth.json"), "auth-file-canary-never-copy", { mode: 0o600 });
  const fake = path.join(root, "fake codex ü.mjs");
  writeFileSync(path.join(root, "mode.json"), JSON.stringify({ mode, names }));
  writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process"; import { createInterface } from "node:readline";
const root=path.dirname(fileURLToPath(import.meta.url)), setting=JSON.parse(fs.readFileSync(path.join(root,"mode.json")));
fs.writeFileSync(path.join(root,"capture.json"),JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,codexHome:process.env.CODEX_HOME,pid:process.pid,ownerInherited:process.env.POSTER_ADMIN_PASSWORD!==undefined,apiInherited:process.env.OPENAI_API_KEY!==undefined,sessionInherited:process.env.CODEX_THREAD_ID!==undefined}));
if(setting.mode==="failure") { process.stderr.write("Synthetic native startup failure.\\n"); process.exit(23); }
else if(setting.mode==="signal") {
 const marker=path.join(root,"descendant-exit"); const ready=path.join(root,"descendant-ready");
 const nested=spawn(process.execPath,["-e",'const fs=require("fs");fs.writeFileSync(process.argv[2],"ready");process.on("SIGTERM",()=>{fs.writeFileSync(process.argv[1],"stopped");process.exit(0)});setInterval(()=>{},1000)',marker,ready],{stdio:"ignore"});
 process.on("SIGTERM",()=>{nested.once("exit",()=>process.exit(0));}); setInterval(()=>{},1000);
} else if(setting.mode==="console" || setting.mode==="console-error") {
 const input=createInterface({input:process.stdin});input.on("line",line=>{const q=JSON.parse(line);fs.appendFileSync(path.join(root,"methods.jsonl"),JSON.stringify({method:q.method,tool:q.params?.tool})+"\\n");if(q.id===undefined)return;
 if(setting.mode==="console-error") {process.stdout.write(JSON.stringify({id:q.id,error:{code:-32000,message:"error-payload-canary-never-log"}})+"\\n");return;}
 const result=q.method==="initialize"?{userAgent:"codex_cli_rs/0.164.0 MOCK"}:q.method==="thread/start"?{thread:{id:"mock-thread"}}:q.method==="mcpServerStatus/list"?{data:[{name:"crossposter",tools:Object.fromEntries(setting.names.map(n=>[n,{}]))}],nextCursor:null}:{content:[],structuredContent:{ok:true,data:{instanceId:"mock-instance",text:"Unicode ü ✓"}}};
 process.stdout.write(JSON.stringify({id:q.id,result})+"\\n");});
} else { process.stdin.pipe(process.stdout); }
`, { mode: 0o700 });
  const stateHome = path.join(home, ".codex-crossposter");
  const args = [launcher, "--data-dir", data, "--endpoint", "http://127.0.0.1:2004", "--media-root", media, "--codex", fake];
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: path.join(home, ".codex"), CODEX_THREAD_ID: "session-canary", POSTER_ADMIN_PASSWORD: "owner-password-canary", OPENAI_API_KEY: "api-key-canary" };
  return { root, home, data, media, fake, stateHome, args, env, close: () => rmSync(root, { recursive: true, force: true }) };
}
function logs(f) {
  const parent = path.join(f.stateHome, "crossposter-debug");
  const directory = path.join(parent, readdirSync(parent)[0]);
  return { directory, lifecycle: readFileSync(path.join(directory, "lifecycle.jsonl"), "utf8").trim().split("\n").map(JSON.parse), stderr: readFileSync(path.join(directory, "stderr.log"), "utf8"), protocol: readFileSync(path.join(directory, "protocol.jsonl"), "utf8") };
}

test("fake host gets only its isolated state home, literal paths and explicit MCP config; raw stdio survives backpressure without payload logging", () => {
  const f = fixture();
  try {
    const payload = `${JSON.stringify({ id: 1, method: "initialize", params: { note: "payload-canary-never-log", text: "ü".repeat(700000) } })}\n`;
    const result = spawnSync(process.execPath, f.args, { env: f.env, cwd: tmpdir(), input: payload, encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0); assert.equal(result.stdout, payload);
    const capture = JSON.parse(readFileSync(path.join(f.root, "capture.json")));
    assert.equal(capture.codexHome, f.stateHome); assert.equal(capture.cwd, f.stateHome); assert.equal(capture.home, f.home);
    assert.equal(capture.ownerInherited, false); assert.equal(capture.apiInherited, false); assert.equal(capture.sessionInherited, false);
    assert.deepEqual(capture.args.slice(0, 2), ["app-server", "--stdio"]);
    const table = capture.args.find((argument) => argument.startsWith("mcp_servers="));
    assert.ok(table.includes(JSON.stringify(f.data))); assert.ok(table.includes(JSON.stringify(f.media).slice(1, -1).replaceAll('"', '\\"')));
    assert.ok(table.includes("crossposter-mcp.mjs")); assert.equal(existsSync(path.join(f.stateHome, "auth.json")), false);
    assert.equal(readFileSync(path.join(f.home, ".codex/auth.json"), "utf8"), "auth-file-canary-never-copy");
    const retained = logs(f); assert.equal(retained.lifecycle.at(-1).exitCode, 0);
    const all = JSON.stringify(retained); for (const value of ["payload-canary-never-log", "owner-password-canary", "api-key-canary", "session-canary", "auth-file-canary-never-copy"]) assert.equal(all.includes(value), false);
    for (const directory of [f.stateHome, path.join(f.stateHome, "crossposter-debug"), retained.directory, path.join(retained.directory, "codex-log"), path.join(f.stateHome, "sqlite")]) assert.equal(statSync(directory).mode & 0o777, 0o700);
    for (const name of ["lifecycle.jsonl", "stderr.log", "protocol.jsonl"]) assert.equal(statSync(path.join(retained.directory, name)).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test("missing fake executable retains first-attempt private failure logs and returns127 without stdout noise", () => {
  const f = fixture();
  try {
    f.args[f.args.length - 1] = path.join(f.root, "missing executable");
    const result = spawnSync(process.execPath, f.args, { env: f.env, encoding: "utf8", input: "", timeout: 10000 });
    assert.equal(result.status, 127); assert.equal(result.stdout, "");
    const retained = logs(f); assert.equal(retained.lifecycle.find((entry) => entry.event === "startup_failure").code, "ENOENT");
    assert.match(retained.stderr, /ENOENT/); assert.equal(retained.lifecycle.at(-1).exitCode, 127);
    assert.equal(existsSync(path.join(f.root, "capture.json")), false);
  } finally { f.close(); }
});

test("fake native startup failure preserves stderr, UTC lifecycle and exit status in separate runs", () => {
  const f = fixture("failure");
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, f.args, { env: f.env, encoding: "utf8", input: "", timeout: 10000 });
      assert.equal(result.status, 23); assert.equal(result.stdout, "");
    }
    const parent = path.join(f.stateHome, "crossposter-debug"); assert.equal(readdirSync(parent).length, 2);
    const retained = logs(f); assert.match(retained.stderr, /Synthetic native startup failure/);
    assert.equal(retained.lifecycle.at(-1).childExit, 23); assert.ok(retained.lifecycle.every((entry) => !Number.isNaN(Date.parse(entry.observedAt))));
  } finally { f.close(); }
});

test("manual console speaks to the fake host and never starts a model turn or owner decision", () => {
  const f = fixture("console");
  try {
    const result = spawnSync(process.execPath, [...f.args, "--console"], { env: f.env, encoding: "utf8", input: "tools\ncall get_status {}\nquit\n", timeout: 10000 });
    assert.equal(result.status, 0); assert.match(result.stdout, /mock-instance/); assert.match(result.stdout, /Unicode ü ✓/);
    const methods = readFileSync(path.join(f.root, "methods.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(methods.map((entry) => entry.method), ["initialize", "initialized", "thread/start", "mcpServerStatus/list", "mcpServer/tool/call"]);
    assert.equal(methods.at(-1).tool, "get_status");
    const retained = logs(f); assert.ok(retained.lifecycle.some((entry) => entry.event === "console-initialized"));
    assert.equal(retained.protocol.includes("mock-instance"), false);
  } finally { f.close(); }
});

test("SIGTERM stops the owned fake process group, awaits the host and retains signal metadata", { timeout: 15000 }, async () => {
  const f = fixture("signal"); let child, exited;
  try {
    child = spawn(process.execPath, f.args, { env: f.env, stdio: ["pipe", "pipe", "pipe"] }); exited = once(child, "exit");
    child.stdout.resume(); child.stderr.resume();
    for (let attempt = 0; attempt < 100 && !existsSync(path.join(f.root, "descendant-ready")); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(existsSync(path.join(f.root, "descendant-ready")), true);
    child.kill("SIGTERM"); const [code] = await exited; child = undefined;
    assert.equal(code, 143); assert.equal(readFileSync(path.join(f.root, "descendant-exit"), "utf8"), "stopped");
    assert.equal(logs(f).lifecycle.at(-1).requestedSignal, "SIGTERM");
  } finally { if (child?.exitCode === null) { child.kill("SIGTERM"); await exited; } f.close(); }
});

test("fake console initialization failure returns nonzero and logs no RPC error payload", () => {
  const f = fixture("console-error");
  try {
    const result = spawnSync(process.execPath, [...f.args, "--console"], { env: f.env, encoding: "utf8", input: "", timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    const retained = logs(f); assert.ok(retained.lifecycle.some((entry) => entry.event === "console_startup_failure"));
    assert.equal(JSON.stringify(retained).includes("error-payload-canary-never-log"), false);
  } finally { f.close(); }
});

test("help and invalid paths never start a host or copy existing state", () => {
  const f = fixture();
  try {
    const help = spawnSync(process.execPath, [launcher, "--help"], { env: f.env, encoding: "utf8" });
    assert.equal(help.status, 0); assert.match(help.stdout, /not Codex TUI/); assert.equal(existsSync(f.stateHome), false);
    const reserved = spawnSync(process.execPath, [...f.args, "--state-home", path.join(f.home, ".codex")], { env: f.env, encoding: "utf8" });
    assert.equal(reserved.status, 2); assert.equal(reserved.stdout, "");
    const target = path.join(f.root, "linked-home"); symlinkSync(f.home, target);
    const linked = spawnSync(process.execPath, [...f.args, "--state-home", target], { env: f.env, encoding: "utf8" });
    assert.equal(linked.status, 2); assert.equal(existsSync(path.join(f.root, "capture.json")), false);
  } finally { f.close(); }
});
