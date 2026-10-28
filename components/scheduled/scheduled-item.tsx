"use client";

import { AlertTriangle, Clock3, ExternalLink, File as FileIcon, Music2 } from "lucide-react";
import { SocialLogo } from "@/components/social-logo";
import type { PublishTarget, ScheduledPost } from "@/lib/types";
import { platformLabels } from "@/lib/platform-catalog";
import { formatDateTime } from "@/lib/scheduled/calendar";
import { formatBytes, statusLabel, resultStatusClass } from "@/lib/scheduled/presentation";
import { ScheduledItemActions, type ScheduledItemActionsProps } from "./scheduled-item-actions";

type ScheduledItemProps = ScheduledItemActionsProps & { post: ScheduledPost };

export function ScheduledItem({ post, editValue, busy, onEdit, onReschedule, onDiscard }: ScheduledItemProps) {
  const canEdit = post.status !== "publishing";
  const okCount = post.results?.filter((result) => result.ok).length || 0;
  const uncertainCount = post.results?.filter((result) => result.uncertain).length || 0;
  const postTargets: PublishTarget[] = post.targets?.length
    ? post.targets
    : post.platforms.map((platform) => ({ id: platform, platform }));
  const targetLabels = postTargets.map((target) => ({
    key: target.id,
    platform: target.platform,
    label: `${platformLabels[target.platform]}${target.profileLabel ? ` · ${target.profileLabel}` : ""}`
  }));

  return (
    <article className="scheduled-card">
      <div className="scheduled-card-body">
        <div className="scheduled-card-head">
          <div>
            <span className={`badge scheduler-status ${post.status}`}>
              {statusLabel(post)}
            </span>
            <h3>{post.title?.trim() || "Untitled post"}</h3>
            <time>{formatDateTime(post.scheduledFor)}</time>
          </div>
          {post.status === "failed" ? (
            <AlertTriangle size={22} className="scheduled-icon err" />
          ) : (
            <Clock3 size={22} className="scheduled-icon" />
          )}
        </div>

        {post.text ? <p className="scheduled-preview">{post.text}</p> : null}
        {post.linkUrl ? (
          <a className="result-link" href={post.linkUrl} target="_blank" rel="noreferrer">
            <span>{post.linkUrl}</span>
            <ExternalLink size={13} />
          </a>
        ) : null}

        <div className="history-platforms">
          {targetLabels.map((target) => (
            <span className="history-platform" key={target.key}>
              <SocialLogo platform={target.platform} size="sm" />
              <span>{target.label}</span>
            </span>
          ))}
        </div>

        {post.lastError ? (
          <p className="error-line">
            <AlertTriangle size={16} />
            {post.lastError}
          </p>
        ) : null}

        {post.results?.length ? (
          <div className="scheduled-results">
            <strong>
              Result: {okCount}/{post.results.length} ok
              {uncertainCount > 0 ? ` · ${uncertainCount} check` : ""}
            </strong>
            <div className="history-platforms">
              {post.results.map((result, index) => {
                const content = (
                  <>
                    <SocialLogo platform={result.platform} size="sm" />
                    <span>
                      {platformLabels[result.platform]}
                      {result.profileLabel ? ` · ${result.profileLabel}` : ""}
                    </span>
                    {result.url ? <ExternalLink size={13} /> : null}
                  </>
                );

                return result.url ? (
                  <a
                    className={`history-platform ${resultStatusClass(result)}`}
                    href={result.url}
                    key={result.targetId || `${result.platform}:${index}`}
                    rel="noreferrer"
                    target="_blank"
                    title={result.message}
                  >
                    {content}
                  </a>
                ) : (
                  <span
                    className={`history-platform ${resultStatusClass(result)}`}
                    key={result.targetId || `${result.platform}:${index}`}
                    title={result.message}
                  >
                    {content}
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}

        {canEdit ? (
          <ScheduledItemActions editValue={editValue} busy={busy} onEdit={onEdit} onReschedule={onReschedule} onDiscard={onDiscard} />
        ) : null}
      </div>
      {post.media ? (
        <aside className="scheduled-card-media">
          {post.media.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/media/${encodeURIComponent(post.media.id)}`}
              alt={post.media.filename}
              loading="lazy"
            />
          ) : post.media.kind === "video" ? (
            <video
              src={`/api/media/${encodeURIComponent(post.media.id)}`}
              controls
              muted
              preload="metadata"
              playsInline
            />
          ) : (
            <div className="scheduled-media-fileicon">
              {post.media.kind === "audio" ? <Music2 size={28} /> : <FileIcon size={28} />}
            </div>
          )}
          <span className="scheduled-media-caption">
            {post.media.filename} · {post.media.contentType || "file"} ·{" "}
            {formatBytes(post.media.size)}
          </span>
        </aside>
      ) : null}
    </article>
  );
}
