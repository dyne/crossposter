import { composeClient, type UploadedMedia } from "./client";

export function fileKind(file: File | null): UploadedMedia["kind"] {
  if (!file) {
    return "file";
  }

  if (file.type.startsWith("image/")) {
    return "image";
  }

  if (file.type.startsWith("video/")) {
    return "video";
  }

  if (file.type.startsWith("audio/")) {
    return "audio";
  }

  return "file";
}

export type MediaDimensions = {
  width: number;
  height: number;
};

export type DribbbleCropOptions = {
  x: number;
  y: number;
  zoom: number;
};

export type DribbbleCropMetrics = {
  sourceWidth: number;
  sourceHeight: number;
  maxX: number;
  maxY: number;
};

export type VideoCompressionQuality = "high" | "balanced" | "small";

export type ProgressState = {
  label: string;
  value: number;
};

export function imageFileName(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  const basename = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;

  return `${basename}-compressed.jpg`;
}

export function dribbbleCropFileName(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  const basename = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;

  return `${basename}-dribbble-800x600.jpg`;
}

export function videoFileName(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  const basename = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;

  return `${basename}-compressed.mp4`;
}

export function loadImage(file: File, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Image loading aborted", "AbortError")); return; }
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    function cleanup() {
      settled = true;
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", abort);
      URL.revokeObjectURL(objectUrl);
    }
    function abort() {
      if (settled) return;
      cleanup();
      reject(new DOMException("Image loading aborted", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });

    image.onload = () => {
      if (settled) return;
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error("Could not read this image for compression"));
    };
    image.src = objectUrl;
  });
}

export async function readImageDimensions(file: File, signal?: AbortSignal): Promise<MediaDimensions> {
  const image = await loadImage(file, signal);

  return {
    width: image.naturalWidth,
    height: image.naturalHeight
  };
}

export function clampCropPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function clampCropZoom(value: number): number {
  return Math.max(1, Math.min(3, value));
}

export function dribbbleCropMetrics(
  imageWidth: number,
  imageHeight: number,
  zoomValue: number
): DribbbleCropMetrics {
  const aspect = 4 / 3;
  const zoom = clampCropZoom(zoomValue);
  let sourceWidth = imageWidth;
  let sourceHeight = sourceWidth / aspect;

  if (sourceHeight > imageHeight) {
    sourceHeight = imageHeight;
    sourceWidth = sourceHeight * aspect;
  }

  sourceWidth /= zoom;
  sourceHeight /= zoom;

  const maxX = Math.max(0, imageWidth - sourceWidth);
  const maxY = Math.max(0, imageHeight - sourceHeight);

  return {
    sourceWidth,
    sourceHeight,
    maxX,
    maxY
  };
}

export function dribbbleCropRect(image: HTMLImageElement, options: DribbbleCropOptions) {
  const metrics = dribbbleCropMetrics(
    image.naturalWidth,
    image.naturalHeight,
    options.zoom
  );

  return {
    x: metrics.maxX * (clampCropPercent(options.x) / 100),
    y: metrics.maxY * (clampCropPercent(options.y) / 100),
    width: metrics.sourceWidth,
    height: metrics.sourceHeight
  };
}

export function drawDribbbleCrop(
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  options: DribbbleCropOptions
) {
  const context = canvas.getContext("2d");

  canvas.width = 800;
  canvas.height = 600;

  if (!context) {
    throw new Error("Image crop is not available in this browser");
  }

  const rect = dribbbleCropRect(image, options);

  context.fillStyle = "#101510";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    image,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
}

export async function cropImageForDribbble(
  file: File,
  options: DribbbleCropOptions,
  signal?: AbortSignal
): Promise<File> {
  const image = await loadImage(file, signal);
  const canvas = document.createElement("canvas");

  drawDribbbleCrop(image, canvas, options);

  const blob = await canvasToBlob(canvas, 0.92);

  return new File([blob], dribbbleCropFileName(file.name), {
    type: "image/jpeg",
    lastModified: Date.now()
  });
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Image compression failed"));
          return;
        }

        resolve(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

export async function compressImageMedia(
  file: File,
  options: {
    quality: number;
  },
  signal?: AbortSignal
): Promise<File> {
  const image = await loadImage(file, signal);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  if (!context) {
    throw new Error("Image compression is not available in this browser");
  }

  context.drawImage(image, 0, 0);

  const blob = await canvasToBlob(canvas, Math.min(1, Math.max(0.01, options.quality / 100)));

  return new File([blob], imageFileName(file.name), {
    type: "image/jpeg",
    lastModified: Date.now()
  });
}

export async function estimateCompressedImageSize(
  file: File,
  quality: number,
  signal?: AbortSignal
): Promise<number> {
  const image = await loadImage(file, signal);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  if (!context) {
    throw new Error("Image compression is not available in this browser");
  }

  context.drawImage(image, 0, 0);

  return (await canvasToBlob(canvas, Math.min(1, Math.max(0.01, quality / 100)))).size;
}

export async function compressVideoMedia(
  file: File,
  options: {
    targetBytes: number;
    quality: VideoCompressionQuality;
  },
  onProgress: (progress: ProgressState) => void,
  signal?: AbortSignal
): Promise<File> {
  const formData = new FormData();

  onProgress({ label: "Preparing video", value: 8 });
  formData.set("file", file);
  formData.set("targetBytes", String(options.targetBytes));
  formData.set("quality", options.quality);
  onProgress({ label: "Uploading to local compressor", value: 22 });

  const response = await composeClient.compressVideo(formData, signal);
  onProgress({ label: "Local FFmpeg compression finished", value: 82 });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };

    throw new Error(body.error || "Video compression failed");
  }

  onProgress({ label: "Receiving compressed video", value: 92 });
  const blob = await response.blob();
  const filename = response.headers.get("x-compressed-filename") || videoFileName(file.name);

  return new File([blob], filename, {
    type: response.headers.get("content-type") || "video/mp4",
    lastModified: Date.now()
  });
}


