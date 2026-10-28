"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Platform } from "@/lib/types";
import { composeClient, type UploadedMedia } from "@/lib/compose/client";
import { saveStoredDraftMedia } from "@/lib/compose/draft-storage";
import {
  fileKind, loadImage, readImageDimensions, drawDribbbleCrop, estimateCompressedImageSize,
  compressImageMedia, compressVideoMedia, cropImageForDribbble, dribbbleCropMetrics,
  clampCropPercent, type MediaDimensions, type VideoCompressionQuality, type ProgressState
} from "@/lib/compose/media-conversion";

type Options = {
  onEdit: () => void;
  onReplace: () => void;
  setError: Dispatch<SetStateAction<string>>;
  setProgress: Dispatch<SetStateAction<ProgressState | null>>;
  videoTargetBytes: (platforms: Platform[], file: File, requested: number) => number;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Draft media operation failed";

export function useComposerMedia({
  onEdit, onReplace, setError, setProgress, videoTargetBytes: videoTargetBytesForPlatforms
}: Options) {
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaInputKey, setMediaInputKey] = useState(0);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startCropX: number;
    startCropY: number;
  } | null>(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState("");
  const [mediaDimensions, setMediaDimensions] = useState<MediaDimensions | null>(null);
  const [imageQuality, setImageQuality] = useState(78);
  const [estimatedImageSize, setEstimatedImageSize] = useState<number | null>(null);
  const [isEstimatingImageSize, setIsEstimatingImageSize] = useState(false);
  const [videoTargetMb, setVideoTargetMb] = useState(490);
  const [videoQuality, setVideoQuality] = useState<VideoCompressionQuality>("balanced");
  const [isDribbbleCropOpen, setIsDribbbleCropOpen] = useState(false);
  const [isDraggingDribbbleCrop, setIsDraggingDribbbleCrop] = useState(false);
  const [dribbbleCropX, setDribbbleCropX] = useState(50);
  const [dribbbleCropY, setDribbbleCropY] = useState(50);
  const [dribbbleCropZoom, setDribbbleCropZoom] = useState(1);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  const [isCompressingMedia, setIsCompressingMedia] = useState(false);
  const [isCroppingMedia, setIsCroppingMedia] = useState(false);
  const [isDraggingMedia, setIsDraggingMedia] = useState(false);

  const [mediaHydrated, setMediaHydrated] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const mounted = useRef(true);
  const progressTimers = useRef<Set<number>>(new Set());
  const conversionTasks = useRef<Set<AbortController>>(new Set());

  useEffect(() => {
    mounted.current = true;
    const timers = progressTimers.current;
    const tasks = conversionTasks.current;
    return () => {
      mounted.current = false;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      for (const task of tasks) task.abort();
      tasks.clear();
    };
  }, []);

  const hydrateMedia = useCallback((file: File | null) => {
    if (file) {
      setMediaFile(file);
      setMediaInputKey((current) => current + 1);
    }
    setMediaHydrated(true);
  }, []);

  function clearProgressLater() {
    if (!mounted.current) return;
    const timer = window.setTimeout(() => {
      progressTimers.current.delete(timer);
      setProgress(null);
    }, 500);
    progressTimers.current.add(timer);
  }


  useEffect(() => {
    if (!mediaFile) {
      setMediaPreviewUrl("");
      setEstimatedImageSize(null);
      setMediaDimensions(null);
      return;
    }

    const objectUrl = URL.createObjectURL(mediaFile);

    setMediaPreviewUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [mediaFile]);

  useEffect(() => {
    let active = true;

    if (!mediaFile || fileKind(mediaFile) !== "image") {
      setMediaDimensions(null);
      return;
    }

    const controller = new AbortController();
    readImageDimensions(mediaFile, controller.signal)
      .then((dimensions) => {
        if (active) {
          setMediaDimensions(dimensions);
        }
      })
      .catch(() => {
        if (active) {
          setMediaDimensions(null);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [mediaFile]);

  useEffect(() => {
    let active = true;
    const canvas = cropCanvasRef.current;

    if (!isDribbbleCropOpen || !mediaFile || fileKind(mediaFile) !== "image" || !canvas) {
      return;
    }

    const controller = new AbortController();
    loadImage(mediaFile, controller.signal)
      .then((image) => {
        if (active) {
          drawDribbbleCrop(image, canvas, {
            x: dribbbleCropX,
            y: dribbbleCropY,
            zoom: dribbbleCropZoom
          });
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
      controller.abort();
    };
  }, [dribbbleCropX, dribbbleCropY, dribbbleCropZoom, isDribbbleCropOpen, mediaFile]);

  useEffect(() => {
    let active = true;

    if (!mediaFile || fileKind(mediaFile) !== "image") {
      setEstimatedImageSize(null);
      setIsEstimatingImageSize(false);
      return;
    }

    setIsEstimatingImageSize(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      estimateCompressedImageSize(mediaFile, imageQuality, controller.signal)
        .then((size) => {
          if (active) {
            setEstimatedImageSize(size);
          }
        })
        .catch(() => {
          if (active) {
            setEstimatedImageSize(null);
          }
        })
        .finally(() => {
          if (active) {
            setIsEstimatingImageSize(false);
          }
        });
    }, 120);

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [imageQuality, mediaFile]);


  useEffect(() => {
    if (!mediaHydrated) return;
    let active = true;
    void saveStoredDraftMedia(mediaFile).then(() => {
      if (active) setStorageError("");
    }).catch((error: unknown) => {
      if (active) setStorageError(errorMessage(error));
    });
    return () => { active = false; };
  }, [mediaFile, mediaHydrated]);

  function setDraftMedia(file: File | null) {
    onEdit();
    setMediaFile(file);
    setMediaDimensions(null);
    setIsDribbbleCropOpen(false);
    setDribbbleCropX(50);
    setDribbbleCropY(50);
    setDribbbleCropZoom(1);
    onReplace();
  }

  function selectMedia(event: React.ChangeEvent<HTMLInputElement>) {
    setDraftMedia(event.target.files?.[0] || null);
  }

  function openMediaFilePicker() {
    mediaInputRef.current?.click();
  }

  function pickClipboardFile(items: DataTransferItemList): File | null {
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();

        if (file) {
          return file;
        }
      }
    }

    return null;
  }

  function pasteMedia(event: React.ClipboardEvent<HTMLDivElement>) {
    const file = pickClipboardFile(event.clipboardData.items);

    if (!file) {
      return;
    }

    event.preventDefault();
    setDraftMedia(file);
  }

  function dragMedia(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingMedia(true);
  }

  function leaveMediaDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDraggingMedia(false);
    }
  }

  function dropMedia(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingMedia(false);
    setDraftMedia(event.dataTransfer.files[0] || null);
  }

  async function clearMedia() {
    onEdit();
    setMediaFile(null);
    setMediaInputKey((current) => current + 1);
    await saveStoredDraftMedia(null).catch((error: unknown) => { if (mounted.current) setStorageError(errorMessage(error)); });
  }


  async function compressSelectedMedia(selectedPlatforms: Platform[]) {
    if (!mediaFile) {
      return;
    }

    const mediaKind = fileKind(mediaFile);
    const compression = mediaKind === "video" ? "video" : mediaKind === "image" ? "image" : undefined;

    if (!compression) {
      return;
    }

    setError("");
    setIsCompressingMedia(true);
    setProgress({
      label: compression === "video" ? "Starting video compression" : "Starting image compression",
      value: 5
    });
    const controller = new AbortController();
    conversionTasks.current.add(controller);
    const reportProgress = (value: ProgressState) => { if (mounted.current) setProgress(value); };

    try {
      const compressed = compression === "video"
        ? await compressVideoMedia(
            mediaFile,
            {
              targetBytes: videoTargetBytesForPlatforms(
                selectedPlatforms,
                mediaFile,
                Math.round(videoTargetMb * 1024 * 1024)
              ),
              quality: videoQuality
            },
            reportProgress,
            controller.signal
          )
        : await (async () => {
            setProgress({ label: "Reading image", value: 25 });
            const image = await compressImageMedia(mediaFile, {
              quality: imageQuality
            }, controller.signal);

            reportProgress({ label: "Encoding compressed image", value: 82 });
            return image;
          })();

      if (!mounted.current) return;
      setProgress({ label: "Replacing selected media", value: 96 });
      setDraftMedia(compressed);
      setProgress({ label: "Compression complete", value: 100 });
    } catch (compressionError) {
      if (!mounted.current) return;
      setError(
        compressionError instanceof Error ? compressionError.message : "Media compression failed"
      );
    } finally {
      conversionTasks.current.delete(controller);
      if (mounted.current) setIsCompressingMedia(false);
      clearProgressLater();
    }
  }

  async function cropSelectedMediaForDribbble() {
    if (!mediaFile || fileKind(mediaFile) !== "image") {
      return;
    }

    setError("");
    setIsCroppingMedia(true);
    setProgress({ label: "Cropping image for Dribbble", value: 12 });
    const controller = new AbortController();
    conversionTasks.current.add(controller);

    try {
      const cropped = await cropImageForDribbble(mediaFile, {
        x: dribbbleCropX,
        y: dribbbleCropY,
        zoom: dribbbleCropZoom
      }, controller.signal);

      if (!mounted.current) return;
      setProgress({ label: "Replacing selected media", value: 82 });
      setDraftMedia(cropped);
      setMediaDimensions({ width: 800, height: 600 });
      setProgress({ label: "Dribbble crop complete", value: 100 });
    } catch (cropError) {
      if (!mounted.current) return;
      setError(cropError instanceof Error ? cropError.message : "Dribbble image crop failed");
    } finally {
      conversionTasks.current.delete(controller);
      if (mounted.current) setIsCroppingMedia(false);
      clearProgressLater();
    }
  }

  function startDribbbleCropDrag(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!mediaDimensions) {
      return;
    }

    cropDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCropX: dribbbleCropX,
      startCropY: dribbbleCropY
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDraggingDribbbleCrop(true);
  }

  function moveDribbbleCropDrag(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = cropDragRef.current;

    if (!drag || !mediaDimensions) {
      return;
    }

    event.preventDefault();

    const rect = event.currentTarget.getBoundingClientRect();
    const metrics = dribbbleCropMetrics(
      mediaDimensions.width,
      mediaDimensions.height,
      dribbbleCropZoom
    );

    if (metrics.maxX > 0 && rect.width > 0) {
      const startSourceX = metrics.maxX * (drag.startCropX / 100);
      const deltaSourceX = (event.clientX - drag.startClientX) * (metrics.sourceWidth / rect.width);
      const nextSourceX = Math.max(0, Math.min(metrics.maxX, startSourceX - deltaSourceX));

      setDribbbleCropX(clampCropPercent((nextSourceX / metrics.maxX) * 100));
    }

    if (metrics.maxY > 0 && rect.height > 0) {
      const startSourceY = metrics.maxY * (drag.startCropY / 100);
      const deltaSourceY = (event.clientY - drag.startClientY) * (metrics.sourceHeight / rect.height);
      const nextSourceY = Math.max(0, Math.min(metrics.maxY, startSourceY - deltaSourceY));

      setDribbbleCropY(clampCropPercent((nextSourceY / metrics.maxY) * 100));
    }
  }

  function stopDribbbleCropDrag(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = cropDragRef.current;

    if (drag?.pointerId === event.pointerId) {
      cropDragRef.current = null;
      setIsDraggingDribbbleCrop(false);

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  }

  async function mediaDimensionsForPreflight(file: File | null): Promise<MediaDimensions | null> {
    if (!file || fileKind(file) !== "image") {
      return null;
    }

    if (mediaDimensions) {
      return mediaDimensions;
    }

    const controller = new AbortController();
    conversionTasks.current.add(controller);
    try {
      const dimensions = await readImageDimensions(file, controller.signal);
      if (mounted.current) setMediaDimensions(dimensions);
      return dimensions;
    } finally {
      conversionTasks.current.delete(controller);
    }
  }


  async function uploadSelectedMedia(signal: AbortSignal): Promise<UploadedMedia | undefined> {
    if (!mediaFile) return undefined;
    setIsUploadingMedia(true);
    setUploadError("");
    setProgress({ label: "Uploading media locally", value: 15 });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    conversionTasks.current.add(controller);
    try {
      const media = await composeClient.upload(mediaFile, controller.signal);
      if (mounted.current) setProgress({ label: "Media ready", value: 35 });
      return media;
    } catch (error) {
      if (mounted.current) setUploadError(errorMessage(error));
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      conversionTasks.current.delete(controller);
      if (mounted.current) setIsUploadingMedia(false);
    }
  }

  return {
    mediaFile, mediaInputKey, mediaInputRef, cropCanvasRef, mediaPreviewUrl,
    mediaDimensions, imageQuality, setImageQuality, estimatedImageSize, isEstimatingImageSize,
    videoTargetMb, setVideoTargetMb, videoQuality, setVideoQuality,
    isDribbbleCropOpen, setIsDribbbleCropOpen, isDraggingDribbbleCrop,
    dribbbleCropX, setDribbbleCropX, dribbbleCropY, setDribbbleCropY, dribbbleCropZoom, setDribbbleCropZoom,
    isUploadingMedia, isCompressingMedia, isCroppingMedia, isDraggingMedia,
    hydrateMedia, clearMedia, setDraftMedia, selectMedia, openMediaFilePicker,
    pasteMedia, dragMedia, leaveMediaDrop, dropMedia, compressSelectedMedia, cropSelectedMediaForDribbble,
    startDribbbleCropDrag, moveDribbbleCropDrag, stopDribbbleCropDrag, mediaDimensionsForPreflight, uploadSelectedMedia,
    storageError, uploadError, isLoadingMedia: !mediaHydrated, clearProgressLater
  };
}

