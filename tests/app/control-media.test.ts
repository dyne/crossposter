import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as io from "node:fs/promises";
import path from "node:path";
import { useDataRoot as selectDataRoot } from "./support/sandbox";
import { imageFile } from "./support/fixtures";
import { releaseBackendOwners } from "@/lib/control/backend-ownership";

afterEach(() => releaseBackendOwners());
const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function fixture() {
  const root = selectDataRoot(); const origin = "http://127.0.0.1:2004";
  const { controlInstanceId } = await import("@/lib/control/auth");
  const rootBinding = digest(fs.realpathSync(root)); const backendId = randomUUID(); const token = "ab".repeat(32);
  const credential = { version: 1, rootBinding, backendId, token, origin, instanceId: controlInstanceId(rootBinding, backendId) };
  fs.writeFileSync(path.join(root, ".poster-control.json"), JSON.stringify(credential), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "poster.config.local.json"), JSON.stringify({ values: { BLUESKY_IDENTIFIER: "fixture.example", BLUESKY_APP_PASSWORD: "private-fixture-token" } }));
  const routes = await import("@/app/api/mcp/v1/media/route");
  const detail = await import("@/app/api/mcp/v1/media/[mediaId]/route");
  const headers = { authorization: `Bearer ${token}`, "x-crossposter-instance": credential.instanceId };
  function request(bytes: Uint8Array | ReadableStream<Uint8Array>, filename = "fixture.png", type = "image/png", size = bytes instanceof Uint8Array ? bytes.length : 1, extra: Record<string,string> = {}) {
    const init: RequestInit & { duplex: string } = { method: "POST", duplex: "half", body: bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes,
      headers: { ...headers, "x-crossposter-filename": encodeURIComponent(filename), "x-crossposter-media-size": String(size), "content-type": type, ...extra } };
    return new Request(`${origin}/api/mcp/v1/media`, init);
  }
  const get = (id: string) => detail.GET(new Request(`${origin}/api/mcp/v1/media/${id}`, { headers }), { params: Promise.resolve({ mediaId:id }) });
  const files = () => fs.existsSync(path.join(root,".poster-uploads")) ? fs.readdirSync(path.join(root,".poster-uploads")).sort() : [];
  return { root, origin, headers, routes, request, get, files };
}
async function png() { return new Uint8Array(await imageFile().arrayBuffer()); }

describe("bounded authenticated control media streaming", () => {
  it.each(["image", "video"])("streams a temporary %s fixture and returns only stable safe metadata", async (kind) => {
    const f = await fixture(); const bytes = kind === "image" ? await png() : new Uint8Array([0,0,0,20,102,116,121,112,105,115,111,109]);
    const filename = kind === "image" ? "fixture.png" : "clip.mp4";
    const fixturePath = path.join(f.root,filename); fs.writeFileSync(fixturePath,bytes);
    const source = fs.readFileSync(fixturePath); let offset=0;
    const stream = new ReadableStream<Uint8Array>({ pull(target) { if (offset===source.length) target.close(); else target.enqueue(new Uint8Array(source.subarray(offset,++offset))); } });
    const response = await f.routes.POST(f.request(stream,filename,`${kind}/${kind==="image"?"png":"mp4"}`,bytes.length));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json(); const media = body.data;
    expect(media).toEqual({id:expect.any(String),filename,contentType:`${kind}/${kind==="image"?"png":"mp4"}`,size:bytes.length,kind,url:`/api/media/${media.id}`,digest:digest(bytes)});
    expect(await (await f.get(media.id)).json()).toEqual(body);
    const filenameOnDisk = path.join(f.root,".poster-uploads",media.id);
    expect(fs.readFileSync(filenameOnDisk)).toEqual(Buffer.from(bytes));
    expect(JSON.parse(fs.readFileSync(`${filenameOnDisk}.json`,"utf8")).digest).toBe(digest(bytes));
    expect(fs.statSync(filenameOnDisk).mode&0o777).toBe(0o600);
    expect(JSON.stringify(body)).not.toContain(f.root); expect(media).not.toHaveProperty("path");
    expect(f.files()).toEqual([media.id,`${media.id}.json`].sort());
  });

  it.each(["", "application/octet-stream"])("infers MIME from extension for a %s upload", async (type) => {
    const f = await fixture(); const response = await f.routes.POST(f.request(await png(),"photo.png",type));
    expect(response.status).toBe(200); expect((await response.json()).data).toMatchObject({contentType:"image/png",kind:"image"});
  });

  it.each(["text/plain", "application/octet-stream"])("rejects unsupported %s data without media artifacts", async (type) => {
    const f = await fixture(); expect((await f.routes.POST(f.request(new Uint8Array([1,2,3]),"unknown.bin",type))).status).toBe(400);
    expect(f.files()).toEqual([]);
  });

  it.each(["declared", "overflow", "truncated", "empty"])("rejects %s upload bounds and removes partial storage", async (kind) => {
    const f = await fixture(); vi.stubEnv("CROSSPOSTER_MCP_UPLOAD_MAX_BYTES","3");
    const bytes = new Uint8Array([1,2,3]); const size = kind==="declared"?4:kind==="overflow"?2:kind==="truncated"?3:0;
    const body = kind==="truncated"?bytes.subarray(0,2):bytes;
    expect((await f.routes.POST(f.request(body,"fixture.png","image/png",size))).status).toBe(400);
    expect(f.files()).toEqual([]);
  });

  it("rejects invalid authority, paths, length and configuration before consuming bytes", async () => {
    const f = await fixture(); const cancel=vi.fn();
    const unread = () => new ReadableStream<Uint8Array>({cancel});
    expect((await f.routes.POST(f.request(unread(),"fixture.png","image/png",1,{authorization:"Bearer wrong"}))).status).toBe(401);
    for (const name of ["/private/file.png","../file.png","folder\\file.png"]) expect((await f.routes.POST(f.request(new Uint8Array([1]),name))).status).toBe(400);
    expect((await f.routes.POST(f.request(new Uint8Array([1]),"fixture.png","image/png",1,{"content-length":"2"}))).status).toBe(400);
    vi.stubEnv("CROSSPOSTER_MCP_UPLOAD_MAX_BYTES","unlimited");
    expect((await f.routes.POST(f.request(new Uint8Array([1])))).status).toBe(500); expect(f.files()).toEqual([]);
  });

  it("cleans stream read failures and redacts caller errors", async () => {
    const f = await fixture();
    const body = new ReadableStream<Uint8Array>({pull(target){target.error(new Error(`/private/${f.root}/source failure`));}});
    const response = await f.routes.POST(f.request(body)); expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(f.root); expect(f.files()).toEqual([]);
  });

  it.each(["abort", "timeout"])("cancels and cleans a stalled %s upload", async (mode) => {
    const f = await fixture(); const canceled=vi.fn(); let entered=false;
    const body = new ReadableStream<Uint8Array>({pull(){entered=true;},cancel:canceled});
    const controller = new AbortController();
    if(mode==="timeout") vi.stubEnv("CROSSPOSTER_MCP_UPLOAD_TIMEOUT_MS","25");
    const request = f.request(body); const controlled = new Request(request,{signal:controller.signal});
    const operation = f.routes.POST(controlled);
    try {
      await vi.waitFor(()=>expect(entered).toBe(true)); if(mode==="abort") controller.abort();
      const response = await operation; expect(response.status).toBe(400); expect(canceled).toHaveBeenCalled(); expect(f.files()).toEqual([]);
    } finally {controller.abort();await Promise.allSettled([operation]);}
  });

  it.each(["metadata", "link"])("cleans %s failures while preserving preexisting media", async (boundary) => {
    const f=await fixture(); const first = (await (await f.routes.POST(f.request(await png()))).json()).data;
    const previous = f.files(); const original=io.writeFile;
    if(boundary==="metadata") vi.spyOn(io,"writeFile").mockImplementation(async (...args:Parameters<typeof io.writeFile>)=>{
      if(String(args[0]).endsWith("metadata.json")) throw new Error("injected metadata failure");
      return original(...args);
    });
    else vi.spyOn(io,"link").mockRejectedValueOnce(new Error("injected final link failure"));
    const failed = await f.routes.POST(f.request(await png())); expect(failed.status).toBe(503); expect(f.files()).toEqual(previous);
    expect((await f.get(first.id)).status).toBe(200);
  });

  it("settles disk-write failures and removes the private partial stream",async()=>{
    const f=await fixture(); const original=fs.createWriteStream;
    vi.spyOn(fs,"createWriteStream").mockImplementation((...args:Parameters<typeof fs.createWriteStream>)=>{
      const stream=original(...args);stream.once("open",()=>stream.destroy(new Error("injected disk error")));return stream;
    });
    expect((await f.routes.POST(f.request(await png()))).status).toBe(503);expect(f.files()).toEqual([]);
  });

  it("does not overwrite existing bytes/metadata when generated IDs collide",async()=>{
    const f=await fixture();const {createMediaStore}=await import("@/lib/storage/media-service");const {createMediaStorage}=await import("@/lib/storage/media-storage");
    const store=createMediaStore(createMediaStorage(f.root),()=>"00000000-0000-0000-0000-000000000000");
    const bytes=await png();const upload=()=>store.saveStreamedMedia({filename:"fixture.png",contentType:"image/png",size:bytes.length,stream:new Blob([new Uint8Array(bytes)]).stream(),maxBytes:1024,timeoutMs:1000},f.origin);
    const saved=await upload();const before=fs.readFileSync(saved.path);const metadata=fs.readFileSync(`${saved.path}.json`);
    await expect(upload()).rejects.toThrow();expect(fs.readFileSync(saved.path)).toEqual(before);expect(fs.readFileSync(`${saved.path}.json`)).toEqual(metadata);
    expect(f.files()).toEqual([saved.id,`${saved.id}.json`].sort());
  });

  it("fails closed after ownership loss during a held upload and leaves no usable metadata",async()=>{
    const f=await fixture();let target!:ReadableStreamDefaultController<Uint8Array>;const bytes=await png();
    const body=new ReadableStream<Uint8Array>({start(value){target=value;value.enqueue(bytes.subarray(0,1));}});
    const operation=f.routes.POST(f.request(body,"fixture.png","image/png",bytes.length));
    try{
      await vi.waitFor(()=>expect(f.files().some(name=>name.startsWith(".incoming-"))).toBe(true));
      fs.unlinkSync(path.join(f.root,".poster-owner.json"));target.enqueue(bytes.subarray(1));target.close();
      const response=await operation;expect(response.status).toBe(409);expect((await response.json()).error.code).toBe("ownership_conflict");
      expect(f.files().every(name=>name.startsWith(".incoming-"))).toBe(true);
      expect(()=>releaseBackendOwners()).toThrow("Another backend");
    }finally{try{target.close();}catch{}await Promise.allSettled([operation]);}
  });

  it("reports metadata lookup stream errors without changing stored files",async()=>{
    const f=await fixture();const media=(await(await f.routes.POST(f.request(await png()))).json()).data;
    const files=f.files();const original=fs.createReadStream;
    vi.spyOn(fs,"createReadStream").mockImplementation((...args:Parameters<typeof fs.createReadStream>)=>{
      const stream=original(...args);stream.once("open",()=>stream.destroy(new Error("private read failure")));return stream;
    });
    const response=await f.get(media.id);expect(response.status).toBe(503);expect(await response.text()).not.toContain("private read failure");expect(f.files()).toEqual(files);
  });

  it("detects missing media, corrupt metadata and actual-byte digest changes without provider calls", async () => {
    const f=await fixture(); const media=(await (await f.routes.POST(f.request(await png()))).json()).data;
    const file=path.join(f.root,".poster-uploads",media.id); const metadata=`${file}.json`; const raw=fs.readFileSync(metadata,"utf8");
    fs.writeFileSync(metadata,"{broken");expect((await f.get(media.id)).status).toBe(500);
    fs.writeFileSync(metadata,raw);const changed=fs.readFileSync(file);changed[changed.length-1]^=1;fs.writeFileSync(file,changed);
    expect((await f.get(media.id)).status).toBe(500);fs.unlinkSync(file);expect((await f.get(media.id)).status).toBe(404);
    const {providers}=await import("@/lib/providers");for(const provider of Object.values(providers))expect(provider).not.toHaveBeenCalled();
  });

  it("binds streamed upload bytes into strict preparation and rejects digest mismatch after byte changes", async () => {
    const f=await fixture(); const media=(await (await f.routes.POST(f.request(await png()))).json()).data;
    const {POST}=await import("@/app/api/mcp/v1/actions/route");
    const response=await POST(new Request(`${f.origin}/api/mcp/v1/actions`,{method:"POST",headers:{...f.headers,"content-type":"application/json"},body:JSON.stringify({mode:"publish",requestKey:"streamed-image",content:{title:"",text:"Fixture",linkUrl:"",mediaId:media.id},targetIds:["bluesky:base"]})}));
    expect(response.status).toBe(200);const action=(await response.json()).data;expect(action.payload.media.digest).toBe(media.digest);
    const file=path.join(f.root,".poster-uploads",media.id);const bytes=fs.readFileSync(file);bytes[bytes.length-1]^=1;fs.writeFileSync(file,bytes);
    const {GET}=await import("@/app/api/mcp/v1/actions/[actionId]/route");
    const current=await GET(new Request(`${f.origin}/api/mcp/v1/actions/${action.id}`,{headers:f.headers}),{params:Promise.resolve({actionId:action.id})});
    expect(current.status).toBe(500);expect((await current.json()).error.code).toBe("storage_corrupt");
  });
});

describe("explicit future bridge media roots",()=>{
  it("has no implicit roots and parses bounded absolute roots and transfer settings",async()=>{
    const {controlMediaSettings}=await import("@/lib/control/media-settings");
    expect(controlMediaSettings(()=>undefined).localRoots).toEqual([]);
    const env:Record<string,string>={CROSSPOSTER_MCP_MEDIA_ROOTS:'["/fixtures/media","/fixtures/media"]',CROSSPOSTER_MCP_UPLOAD_MAX_BYTES:"123",CROSSPOSTER_MCP_UPLOAD_TIMEOUT_MS:"456"};
    expect(controlMediaSettings(name=>env[name])).toEqual({localRoots:["/fixtures/media"],maxBytes:123,timeoutMs:456});
    for(const roots of ['["relative"]','[1]','"/path"','broken']) expect(()=>controlMediaSettings(name=>name==="CROSSPOSTER_MCP_MEDIA_ROOTS"?roots:undefined)).toThrow("Invalid media configuration");
  });
});
