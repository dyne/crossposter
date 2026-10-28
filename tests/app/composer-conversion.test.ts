// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:fixture-image");
    static revokeObjectURL = vi.fn();
  });
});

describe("composer media conversion contracts", () => {
  it.each([
    [1200, 600, 1, { sourceWidth: 800, sourceHeight: 600, maxX: 400, maxY: 0 }],
    [600, 1200, 1, { sourceWidth: 600, sourceHeight: 450, maxX: 0, maxY: 750 }],
    [1200, 600, 2, { sourceWidth: 400, sourceHeight: 300, maxX: 800, maxY: 300 }],
    [1200, 600, -1, { sourceWidth: 800, sourceHeight: 600, maxX: 400, maxY: 0 }]
  ])("computes 4:3 source crop for %sx%s zoom%s", async (width, height, zoom, expected) => {
    const { dribbbleCropMetrics } = await import("@/lib/compose/media-conversion");
    expect(dribbbleCropMetrics(width, height, zoom)).toEqual(expected);
  });

  it("clamps crop position/zoom and keeps established output filenames", async () => {
    const { dribbbleCropRect, clampCropPercent, clampCropZoom, imageFileName, videoFileName, dribbbleCropFileName } = await import("@/lib/compose/media-conversion");
    expect(clampCropPercent(-1)).toBe(0);
    expect(clampCropPercent(101)).toBe(100);
    expect(clampCropZoom(4)).toBe(3);
    expect(dribbbleCropRect({ naturalWidth: 1200, naturalHeight: 600 } as HTMLImageElement, { x: 101, y: -1, zoom: 1 })).toEqual({ x: 400, y: 0, width: 800, height: 600 });
    expect(imageFileName("fixture.source.PNG")).toBe("fixture.source-compressed.jpg");
    expect(videoFileName("fixture")).toBe("fixture-compressed.mp4");
    expect(dribbbleCropFileName(".fixture")).toBe(".fixture-dribbble-800x600.jpg");
  });

  it("releases a failed image URL and exposes the existing read error", async () => {
    vi.stubGlobal("Image", class {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      set src(_url: string) { queueMicrotask(() => this.onerror?.()); }
    });
    const { loadImage } = await import("@/lib/compose/media-conversion");
    await expect(loadImage(new File(["fixture"], "broken.png"))).rejects.toThrow("Could not read this image for compression");
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:fixture-image");
  });

  it("retains canvas errors and JPEG encoding quality", async () => {
    const { canvasToBlob, drawDribbbleCrop } = await import("@/lib/compose/media-conversion");
    const canvas = document.createElement("canvas");
    const encode = vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(null));
    await expect(canvasToBlob(canvas, 0.92)).rejects.toThrow("Image compression failed");
    expect(encode).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.92);
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    expect(() => drawDribbbleCrop({ naturalWidth: 1200, naturalHeight: 600 } as HTMLImageElement, canvas, { x: 50, y: 50, zoom: 1 })).toThrow("Image crop is not available in this browser");
  });

  it("sends video options through the local boundary and respects filename/content-type headers", async () => {
    const file = new File(["fixture-video"], "fixture.webm", { type: "video/webm" });
    const request = vi.fn(async () => new Response("fixture-mp4", { headers: { "x-compressed-filename": "local-fixture.mp4", "content-type": "video/mp4" } }));
    vi.stubGlobal("fetch", request);
    const { compressVideoMedia } = await import("@/lib/compose/media-conversion");
    const progress = vi.fn();
    const result = await compressVideoMedia(file, { targetBytes: 12345, quality: "small" }, progress);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/media/compress-video");
    const data = init.body as FormData;
    expect(data.get("file")).toBe(file);
    expect(data.get("targetBytes")).toBe("12345");
    expect(data.get("quality")).toBe("small");
    expect(result.name).toBe("local-fixture.mp4");
    expect(result.type).toBe("video/mp4");
    expect(progress.mock.calls.map(([value]) => value.value)).toEqual([8, 22, 82, 92]);
  });

  it.each([true, false])("retains video compression HTTP errors (JSON:%s)", async (validJson) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(validJson ? JSON.stringify({ error: "Fixture compressor failed" }) : "not-json", { status: 500 })));
    const { compressVideoMedia } = await import("@/lib/compose/media-conversion");
    await expect(compressVideoMedia(new File(["fixture"], "fixture.webm"), { targetBytes: 10, quality: "balanced" }, vi.fn())).rejects.toThrow(validJson ? "Fixture compressor failed" : "Video compression failed");
  });
});
