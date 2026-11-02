import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const repository = fileURLToPath(new URL("..", import.meta.url));
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-owner-process-"));
  const data = path.join(root, "data"); mkdirSync(data);
  // Compile the actual owner and its leaf dependencies, without Next's
  // server-only marker. Children execute production ownership code and real fs.
  for (const [source, name] of [["lib/control/backend-ownership.ts", "owner"], ["lib/control/errors.ts", "errors"], ["lib/storage/durable-json.ts", "durable-json"], ["lib/storage/json-limits.ts", "json-limits"]]) {
    const compiled = ts.transpileModule(readFileSync(path.join(repository, source), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }).outputText.replace('import "server-only";', "").replace('"./errors"', '"./errors.mjs"').replace('"../storage/durable-json"', '"./durable-json.mjs"').replace('"./json-limits"', '"./json-limits.mjs"');
    writeFileSync(path.join(root, `${name}.mjs`), compiled);
  }
  const program = `import { backendOwner, releaseBackendOwners } from ${JSON.stringify(pathToFileURL(path.join(root, "owner.mjs")).href)};
    process.on("message", (operation) => {
      try {
        if (operation === "acquire") backendOwner(process.argv[1]);
        if (operation === "assert") backendOwner(process.argv[1]).assert();
        if (operation === "release") releaseBackendOwners();
        if (operation === "exit") process.exit(0);
        process.send({ ok: true });
      } catch (error) { process.send({ ok: false, code: error.code }); }
    });`;
  const children = [];
  function child(selected = data) {
    const processChild = spawn(process.execPath, ["--input-type=module", "-e", program, selected], {
      env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    processChild.stderr.resume(); children.push(processChild); return processChild;
  }
  async function dispose() {
    await Promise.all(children.map(async (processChild) => {
      if (processChild.exitCode !== null || processChild.signalCode !== null) return;
      const exited = once(processChild, "exit"); processChild.kill("SIGKILL"); await exited;
    }));
    rmSync(root, { recursive: true, force: true });
  }
  return { root, data, child, dispose };
}
async function request(child, operation) {
  let timer;
  const result = new Promise((resolve, reject) => {
    const message = (result) => { cleanup(); resolve(result); };
    const exit = () => { cleanup(); reject(new Error("Owned fixture child exited unexpectedly")); };
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); };
    child.once("message", message); child.once("exit", exit);
    timer = setTimeout(() => { cleanup(); reject(new Error("Owned fixture child did not answer")); }, 5000);
    child.send(operation);
  });
  return result;
}

test("simultaneous processes and symlink-equivalent roots elect exactly one backend owner", { timeout: 20000 }, async () => {
  const f = fixture();
  try {
    const alias = path.join(f.root, "alias"); symlinkSync(f.data, alias);
    const children = Array.from({ length: 6 }, (_, i) => f.child(i % 2 ? alias : f.data));
    const results = await Promise.all(children.map((child) => request(child, "acquire")));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.code === "ownership_conflict").length, 5);
    const winner = children[results.findIndex((result) => result.ok)];
    assert.deepEqual(await request(winner, "release"), { ok: true });
    assert.equal(existsSync(path.join(f.data, ".poster-owner.json")), false);
    assert.deepEqual(await request(f.child(alias), "acquire"), { ok: true });
  } finally { await f.dispose(); }
});

test("an abruptly stopped owned child is recoverable, while a live/reused PID is never reclaimed", { timeout: 20000 }, async () => {
  const f = fixture();
  try {
    const child = f.child(); assert.deepEqual(await request(child, "acquire"), { ok: true });
    const filename = path.join(f.data, ".poster-owner.json");
    const claim = JSON.parse(readFileSync(filename, "utf8"));
    assert.equal(claim.pid, child.pid);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    assert.equal(existsSync(filename), true);
    // This synthetic reused PID is this test's live parent, not an unrelated
    // process. A liveness probe has signal 0 and never sends a terminating signal.
    writeFileSync(filename, JSON.stringify({ ...claim, pid: process.pid }), { mode: 0o600 });
    assert.deepEqual(await request(f.child(), "acquire"), { ok: false, code: "ownership_conflict" });
    assert.equal(JSON.parse(readFileSync(filename, "utf8")).pid, process.pid);
    writeFileSync(filename, JSON.stringify(claim), { mode: 0o600 });
    assert.deepEqual(await request(f.child(), "acquire"), { ok: true });
  } finally { await f.dispose(); }
});

test("normal process exit releases ownership and restart acquires a fresh claim", { timeout: 20000 }, async () => {
  const f = fixture();
  try {
    const first = f.child(); assert.deepEqual(await request(first, "acquire"), { ok: true });
    const exited = once(first, "exit"); first.send("exit"); await exited;
    assert.equal(existsSync(path.join(f.data, ".poster-owner.json")), false);
    assert.deepEqual(await request(f.child(), "acquire"), { ok: true });
  } finally { await f.dispose(); }
});
