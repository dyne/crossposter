import { AlertTriangle, Crop, File as FileIcon, ImageIcon, Music2, Upload, Video, X } from "lucide-react";
import type { Platform } from "@/lib/types";
import { fileKind, type ProgressState, type VideoCompressionQuality } from "@/lib/compose/media-conversion";
import {
  mediaPreflightIssues, maxManualVideoTargetSize, videoTargetBytesForPlatforms,
  imageTargetBytesForPlatforms, type MediaPreflightTarget
} from "@/lib/compose/media-policy";
import { formatBytes } from "@/lib/compose/presentation";
import type { useComposerMedia } from "./use-composer-media";
import { ProgressBox } from "./progress-box";

type MediaEditorState = Pick<ReturnType<typeof useComposerMedia>,
  | "mediaFile"
  | "mediaInputKey"
  | "mediaInputRef"
  | "cropCanvasRef"
  | "mediaPreviewUrl"
  | "mediaDimensions"
  | "imageQuality"
  | "setImageQuality"
  | "estimatedImageSize"
  | "isEstimatingImageSize"
  | "videoTargetMb"
  | "setVideoTargetMb"
  | "videoQuality"
  | "setVideoQuality"
  | "isDribbbleCropOpen"
  | "setIsDribbbleCropOpen"
  | "isDraggingDribbbleCrop"
  | "setDribbbleCropX"
  | "setDribbbleCropY"
  | "dribbbleCropZoom"
  | "setDribbbleCropZoom"
  | "isCompressingMedia"
  | "isCroppingMedia"
  | "isDraggingMedia"
  | "clearMedia"
  | "selectMedia"
  | "openMediaFilePicker"
  | "pasteMedia"
  | "dragMedia"
  | "leaveMediaDrop"
  | "dropMedia"
  | "cropSelectedMediaForDribbble"
  | "startDribbbleCropDrag"
  | "moveDribbbleCropDrag"
  | "stopDribbbleCropDrag"
  | "compressSelectedMedia"
>;
type Props = {
  media: MediaEditorState; selectedPlatforms: Platform[];
  selectedLimitTargets: MediaPreflightTarget[]; progress: ProgressState | null;
};

export function MediaEditor({ media, selectedPlatforms, selectedLimitTargets, progress }: Props) {
  const { mediaFile, mediaInputKey, mediaInputRef, cropCanvasRef, mediaPreviewUrl, mediaDimensions, imageQuality, setImageQuality, estimatedImageSize, isEstimatingImageSize, videoTargetMb, setVideoTargetMb, videoQuality, setVideoQuality, isDribbbleCropOpen, setIsDribbbleCropOpen, isDraggingDribbbleCrop, setDribbbleCropX, setDribbbleCropY, dribbbleCropZoom, setDribbbleCropZoom, isCompressingMedia, isCroppingMedia, isDraggingMedia, clearMedia, selectMedia, openMediaFilePicker, pasteMedia, dragMedia, leaveMediaDrop, dropMedia, cropSelectedMediaForDribbble, startDribbbleCropDrag, moveDribbbleCropDrag, stopDribbbleCropDrag } = media;
  const compressSelectedMedia = () => media.compressSelectedMedia(selectedPlatforms);
  const preflightIssues = mediaPreflightIssues(selectedLimitTargets, mediaFile, mediaDimensions);
  const selectedMediaKind = fileKind(mediaFile);
  const SelectedMediaIcon =
    selectedMediaKind === "image"
      ? ImageIcon
      : selectedMediaKind === "video"
        ? Video
        : selectedMediaKind === "audio"
          ? Music2
          : FileIcon;
  const compressionKind = preflightIssues.find((issue) => issue.compress)?.compress;
  const cropKind = preflightIssues.find((issue) => issue.crop)?.crop;
  const canCompressMedia = Boolean(compressionKind && mediaFile && !isCroppingMedia);
  const canCropDribbbleMedia = Boolean(cropKind === "dribbble" && mediaFile && !isCompressingMedia);
  const maxManualVideoTargetMb = Math.round(maxManualVideoTargetSize / 1024 / 1024);
  const videoPlatformTargetBytes = mediaFile
    ? videoTargetBytesForPlatforms(
        selectedPlatforms,
        mediaFile,
        Math.round(videoTargetMb * 1024 * 1024)
      )
    : Math.round(videoTargetMb * 1024 * 1024);
  const videoPlatformTargetMb = Math.max(1, Math.round(videoPlatformTargetBytes / 1024 / 1024));
  const imagePlatformTargetBytes =
    mediaFile && selectedMediaKind === "image"
      ? imageTargetBytesForPlatforms(selectedPlatforms, mediaFile)
      : undefined;
  const mediaWarnings = mediaFile
    ? selectedPlatforms.flatMap((platform) => {
        if (platform === "devto") {
          return [
            {
              id: "devto-media-ignored",
              message: "Dev.to ignores local media; the article will publish without this file."
            }
          ];
        }

        if (platform === "nostr") {
          return [
            {
              id: "nostr-media-ignored",
              message: "Nostr ignores local media; paste public media links into the post text."
            }
          ];
        }

        if (platform === "hackernews") {
          return [
            {
              id: "hackernews-media-ignored",
              message: "Hacker News ignores local media; use the Link field or post text instead."
            }
          ];
        }

        if (platform === "instagram") {
          if (selectedMediaKind === "video") {
            return [
              {
                id: "instagram-video-reel",
                message:
                  "Instagram posts videos as a 9:16 reel — use a 1080x1920 (9:16) video so nothing is cropped (max 300 MB)."
              }
            ];
          }
          if (selectedMediaKind === "image") {
            const dims = mediaDimensions;
            const isSquare =
              dims && Math.abs(dims.width - dims.height) <= Math.max(dims.width, dims.height) * 0.02;
            if (dims && !isSquare) {
              return [
                {
                  id: "instagram-image-square",
                  message: `Instagram posts photos as 1:1 square — your ${dims.width}x${dims.height} image will be cropped to a square. Use a 1080x1080 image so nothing is cut.`
                }
              ];
            }
            return [
              {
                id: "instagram-image-square-ok",
                message: "Instagram posts photos as a 1:1 square (best at 1080x1080, max 8 MB)."
              }
            ];
          }
        }

        return [];
      })
    : [];

  const compressionProgress = isCompressingMedia || isCroppingMedia ? progress : null;
  return (            <div className="field">
              <label className="field-label" htmlFor="mediaFile">
                Media file
              </label>
              <div
                className={`media-picker ${mediaFile ? "has-file" : ""} ${
                  isDraggingMedia ? "is-dragging" : ""
                }`}
                onDragEnter={dragMedia}
                onDragOver={dragMedia}
                onDragLeave={leaveMediaDrop}
                onDrop={dropMedia}
                onPaste={pasteMedia}
              >
                <div className="media-preview" aria-label="Drop or paste media file" tabIndex={0}>
                  {mediaFile && mediaPreviewUrl && selectedMediaKind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={mediaPreviewUrl} alt={mediaFile.name} />
                  ) : null}
                  {mediaFile && mediaPreviewUrl && selectedMediaKind === "video" ? (
                    <video src={mediaPreviewUrl} controls />
                  ) : null}
                  {mediaFile && mediaPreviewUrl && selectedMediaKind === "audio" ? (
                    <div className="media-empty media-audio">
                      <Music2 size={24} />
                      <audio src={mediaPreviewUrl} controls />
                    </div>
                  ) : null}
                  {mediaFile && selectedMediaKind === "file" ? (
                    <div className="media-empty">
                      <FileIcon size={28} />
                      <span>{mediaFile.name}</span>
                    </div>
                  ) : null}
                  {!mediaFile ? (
                    <div className="media-empty">
                      <Upload size={28} />
                      <span>Drop or paste a file</span>
                    </div>
                  ) : null}
                </div>
                <input
                  ref={mediaInputRef}
                  key={mediaInputKey}
                  className="sr-only"
                  id="mediaFile"
                  type="file"
                  onChange={selectMedia}
                />
                <div className="media-controls">
                  <button
                    className="secondary compact-button media-choose-button"
                    type="button"
                    onClick={openMediaFilePicker}
                  >
                    <Upload size={17} />
                    Choose file
                  </button>
                  {mediaFile ? (
                    <>
                      <button className="secondary icon-button" type="button" onClick={clearMedia}>
                        <X size={18} />
                        <span className="sr-only">Remove media file</span>
                      </button>
                      <div className="media-meta">
                        <span>
                          <SelectedMediaIcon size={16} />
                          {mediaFile.name}
                        </span>
                        <span>
                          {mediaFile.type || "file"} · {formatBytes(mediaFile.size)}
                          {selectedMediaKind === "image" && mediaDimensions
                            ? ` · ${mediaDimensions.width}x${mediaDimensions.height}`
                            : ""}
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
              <span className="field-hint">
                Paste an image from the clipboard, drag and drop a file, or choose one manually.
              </span>
              {mediaWarnings.length > 0 ? (
                <div className="preflight-list warning-list" role="status">
                  {mediaWarnings.map((warning) => (
                    <p className="preflight-item warning-item" key={warning.id}>
                      <AlertTriangle size={16} />
                      <span>{warning.message}</span>
                    </p>
                  ))}
                </div>
              ) : null}
              {canCropDribbbleMedia ? (
                <div className="crop-panel">
                  <div className="compression-heading">
                    <div>
                      <strong>Dribbble crop</strong>
                      <span>Output will replace the selected media as an 800x600 JPG.</span>
                    </div>
                    <button
                      className="secondary compact-button"
                      onClick={() => setIsDribbbleCropOpen((current) => !current)}
                      type="button"
                    >
                      <Crop size={16} />
                      {isDribbbleCropOpen ? "Hide cropper" : "Crop for Dribbble"}
                    </button>
                  </div>
                  {isDribbbleCropOpen ? (
                    <div className="cropper-grid">
                      <canvas
                        aria-label="Drag Dribbble crop preview"
                        className={`crop-preview ${isDraggingDribbbleCrop ? "is-dragging" : ""}`}
                        height="600"
                        onPointerCancel={stopDribbbleCropDrag}
                        onPointerDown={startDribbbleCropDrag}
                        onPointerMove={moveDribbbleCropDrag}
                        onPointerUp={stopDribbbleCropDrag}
                        ref={cropCanvasRef}
                        width="800"
                      />
                      <div className="crop-controls">
                        <label>
                          <span>Zoom</span>
                          <input
                            className="quality-slider"
                            max="3"
                            min="1"
                            onChange={(event) => setDribbbleCropZoom(Number(event.target.value))}
                            step="0.05"
                            style={
                              { "--value": `${((dribbbleCropZoom - 1) / 2) * 100}%` } as React.CSSProperties
                            }
                            type="range"
                            value={dribbbleCropZoom}
                          />
                          <small>{dribbbleCropZoom.toFixed(2)}x</small>
                        </label>
                        <div className="crop-actions">
                          <button
                            className="secondary compact-button"
                            onClick={() => {
                              setDribbbleCropX(50);
                              setDribbbleCropY(50);
                              setDribbbleCropZoom(1);
                            }}
                            type="button"
                          >
                            Center
                          </button>
                          <button
                            className="secondary compact-button"
                            disabled={isCroppingMedia}
                            onClick={() => void cropSelectedMediaForDribbble()}
                            type="button"
                          >
                            <Crop size={16} />
                            {isCroppingMedia ? "Cropping..." : "Apply crop"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {canCompressMedia ? (
                <div className="compression-panel">
                  <div className="compression-heading">
                    <div>
                      <strong>Compress / convert</strong>
                      {compressionKind === "image" && imagePlatformTargetBytes ? (
                        <span>Target size up to {formatBytes(imagePlatformTargetBytes)}.</span>
                      ) : compressionKind === "video" ? (
                        <span>Output MP4 up to {formatBytes(videoPlatformTargetBytes)}.</span>
                      ) : null}
                    </div>
                    <button
                      className="secondary compact-button"
                      disabled={isCompressingMedia}
                      onClick={() => void compressSelectedMedia()}
                      type="button"
                    >
                      {isCompressingMedia
                        ? "Compressing..."
                        : compressionKind === "video"
                          ? "Compress video"
                          : "Compress image"}
                    </button>
                  </div>
                  {compressionKind === "image" ? (
                    <div className="compression-grid compression-grid-single">
                      <label>
                        <span>Quality</span>
                        <input
                          className="quality-slider"
                          max="100"
                          min="1"
                          onChange={(event) => setImageQuality(Number(event.target.value))}
                          style={{ "--value": `${imageQuality}%` } as React.CSSProperties}
                          type="range"
                          value={imageQuality}
                        />
                        <small>
                          {imageQuality}% ·{" "}
                          {isEstimatingImageSize
                            ? "calculating..."
                            : estimatedImageSize
                              ? formatBytes(estimatedImageSize)
                              : "size unavailable"}
                        </small>
                      </label>
                    </div>
                  ) : null}
                  {compressionKind === "video" ? (
                    <div className="compression-grid">
                      <label>
                        <span>Target size</span>
                        <input
                          className="quality-slider"
                          max={maxManualVideoTargetMb}
                          min="1"
                          onChange={(event) =>
                            setVideoTargetMb(
                              Math.max(
                                1,
                                Math.min(
                                  maxManualVideoTargetMb,
                                  Number(event.target.value) || 1
                                )
                              )
                            )
                          }
                          style={{ "--value": `${(videoTargetMb / maxManualVideoTargetMb) * 100}%` } as React.CSSProperties}
                          type="range"
                          value={videoTargetMb}
                        />
                        <small>{videoTargetMb} MB requested · using {videoPlatformTargetMb} MB</small>
                      </label>
                      <label>
                        <span>Video quality</span>
                        <select
                          onChange={(event) => setVideoQuality(event.target.value as VideoCompressionQuality)}
                          value={videoQuality}
                        >
                          <option value="high">Higher quality</option>
                          <option value="balanced">Balanced</option>
                          <option value="small">Smaller file</option>
                        </select>
                      </label>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {preflightIssues.length > 0 ? (
                <div className="preflight-list" role="alert">
                  {preflightIssues.map((issue) => (
                    <p className="preflight-item" key={issue.id}>
                      <AlertTriangle size={16} />
                      <span>{issue.message}</span>
                    </p>
                  ))}
                </div>
              ) : null}
              {compressionProgress ? (
                <ProgressBox className="media-progress" progress={compressionProgress} />
              ) : null}
            </div>

);
}
