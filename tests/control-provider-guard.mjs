// Fixture-only preload: retain all outbound/process denials, then allow exactly
// one intercepted provider endpoint. No network transport is used by this fake.
import "./e2e/server-guard.cjs";
import fs from "node:fs";
import path from "node:path";
const root = process.env.CROSSPOSTER_DATA_DIR;
globalThis.fetch = async (url, options) => {
  if (url !== "https://dev.to/api/articles" || options?.method !== "POST") throw new Error("Unexpected execution-test provider IO");
  const name = { "runtime-base-canary": "base", "runtime-profile-canary": "profile" }[options.headers["api-key"]];
  if (!name) throw new Error("Unexpected execution-test provider identity");
  const body = JSON.parse(options.body).article;
  fs.appendFileSync(path.join(root, "fixture-provider-calls.jsonl"), JSON.stringify({ name, title: body.title, ...(name === "profile" ? { accepted: true } : {}) }) + "\n");
  if (name === "base") {
    while (!fs.existsSync(path.join(root, "fixture-provider-release"))) await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({ url: "https://dev.to/fixture/published?v=retained&token=private" });
  }
  // The fake remote accepted the POST, but its success response body disconnects.
  // This reaches the incumbent provider's assertOk/text path as an untagged
  // TypeError, after acceptance rather than as a definitive rejection result.
  return new Response(new ReadableStream({ start(controller) {
    controller.error(new TypeError("runtime-profile-canary accepted fixture response interrupted"));
  } }), { status: 200, headers: { "content-type": "application/json" } });
};
