// Fixture-only preload for the actual launcher and its production Next child.
// Real provider IO is denied. Timer durations alone are shortened so the real
// launcher/backend callbacks can overlap without a thirty-second test delay.
import fs from "node:fs";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const data = process.env.CROSSPOSTER_DATA_DIR;
const app = process.env.CROSSPOSTER_APP_ROOT;
const role = process.argv[1]?.endsWith("crossposter.mjs") ? "launcher" : "backend";
const record = (event) => fs.appendFileSync(path.join(data, "fixture-scheduler-events.jsonl"), JSON.stringify({ pid: process.pid, role, at: Date.now(), ...event }) + "\n");
const intervals = new Map(); let sequence = 0;
const realInterval = globalThis.setInterval, realClear = globalThis.clearInterval, realTimeout = globalThis.setTimeout;
globalThis.setInterval = (callback, delay, ...args) => {
  const scheduler = delay === 30000 && (role === "launcher" || new Error().stack.includes(".next/server/"));
  if (!scheduler) return realInterval(callback, delay, ...args);
  const id = ++sequence; const timer = realInterval(() => { record({ event: "interval-fired", id }); callback(...args); }, 120);
  intervals.set(timer, id); record({ event: "interval-started", id }); return timer;
};
globalThis.clearInterval = (timer) => {
  if (intervals.has(timer)) { record({ event: "interval-stopped", id: intervals.get(timer) }); intervals.delete(timer); }
  return realClear(timer);
};
if (role === "launcher") globalThis.setTimeout = (callback, delay, ...args) => realTimeout(callback, delay === 5000 ? 80 : delay, ...args);
process.on("exit", () => record({ event: "exit", activeIntervals: intervals.size }));

if (role === "launcher") {
  const processes = require("node:child_process"); const spawn = processes.spawn;
  processes.spawn = (command, args, options) => {
    if (command !== path.join(app, "node_modules/.bin/next") || args[0] !== "start" || args[2] !== "127.0.0.1"
      || options.cwd !== app || options.env.CROSSPOSTER_DATA_DIR !== data) {
      record({ event: "denied-process" }); throw new Error("Unexpected scheduler fixture launcher process");
    }
    const child = spawn(command, args, options); record({ event: "backend-spawned", childPid: child.pid }); return child;
  };
  for (const name of ["exec", "execSync", "execFile", "execFileSync", "fork", "spawnSync"]) processes[name] = () => {
    record({ event: "denied-process" }); throw new Error("Unexpected scheduler fixture launcher process");
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    const method = options?.method ?? "GET";
    if (url.origin !== process.env.CROSSPOSTER_SCHEDULER_FIXTURE_ORIGIN
      || !(url.pathname === "/api/health" && method === "GET" || url.pathname === "/api/scheduled/tick" && method === "POST")) {
      record({ event: "denied-fetch" }); throw new Error("Unexpected scheduler fixture launcher network");
    }
    record({ event: "ping", method, route: url.pathname }); return fetch(input, options);
  };
  syncBuiltinESMExports();
} else {
  await import("./e2e/server-guard.cjs");
  const server = require("node:http").Server.prototype; const emit = server.emit;
  server.emit = function (event, ...args) {
    if (event === "request") record({ event: "request", method: args[0].method, route: new URL(args[0].url, "http://fixture.invalid").pathname });
    return emit.call(this, event, ...args);
  };
  globalThis.fetch = async (input, options) => {
    if (input !== "https://dev.to/api/articles" || options?.method !== "POST" || options.headers["api-key"] !== "scheduler-fixture-api-key") {
      record({ event: "denied-provider" }); throw new Error("Unexpected scheduler fixture provider IO");
    }
    const article = JSON.parse(options.body).article;
    record({ event: "provider-entered", title: article.title });
    while (!fs.existsSync(path.join(data, "fixture-scheduler-release"))) await new Promise((resolve) => realTimeout(resolve, 20));
    record({ event: "provider-returned" }); return Response.json({ url: "https://dev.to/fixture/headless" });
  };
}
