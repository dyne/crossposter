"use client";

import { AlertTriangle, Clock3, ExternalLink, File as FileIcon, Music2 } from "lucide-react";
import { SocialLogo } from "@/components/social-logo";
import type { PublishTarget } from "@/lib/types";
import { platformLabels } from "@/lib/platform-catalog";
import { formatDateTime } from "@/lib/scheduled/calendar";
import { formatBytes, statusLabel } from "@/lib/scheduled/presentation";
import { ScheduledItemActions, type ScheduledItemActionsProps } from "./scheduled-item-actions";
import { neverAttemptedSchedule } from "@/lib/scheduling/reschedule-policy";
import { inspectBeforeNewAttempt, outcomeSummary, publicationRows, type ScheduleView } from "@/lib/publication-outcomes";
import { PublicationOutcomes } from "@/components/publication-outcomes";

type ScheduledItemProps = ScheduledItemActionsProps & { post: ScheduleView };

export function ScheduledItem({ post, editValue, busy, onEdit, onReschedule, onDiscard }: ScheduledItemProps) {
  const canEdit = post.status !== "publishing" && post.status !== "published";
  const canReschedule = !post.authorization && neverAttemptedSchedule(post);
  const postTargets: PublishTarget[] = post.targets?.length
    ? post.targets
    : post.platforms.map((platform) => ({ id: platform, platform }));
  const targetLabels = postTargets.map((target) => ({
    key: target.id,
    platform: target.platform,
    label: `${platformLabels[target.platform]}${target.profileLabel ? ` · ${target.profileLabel}` : ""}`
  }));
  const rows = publicationRows(post.results ?? [], postTargets, post.outcomes, canReschedule);

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

        {post.lastError && post.lastError.length > 200 ? <details className="outcome-details schedule-error">
          <summary>Schedule error details</summary>
          <p>{post.lastError}</p>
        </details> : post.lastError ? (
          <p className="error-line">
            <AlertTriangle size={16} />
            <span>{post.lastError}</span>
          </p>
        ) : null}

        {rows.length ? (
          <div className="scheduled-results">
            <strong>{outcomeSummary(rows)}</strong>
            <PublicationOutcomes rows={rows} />
          </div>
        ) : null}

        {!canReschedule && canEdit ? <div className="outcome-guidance">
          <p>{post.authorization ? "This schedule has frozen approval. Changing its time requires a new reschedule preparation and owner approval." : "Timing changes are unavailable because this record does not prove that every account was never dispatched."}</p>
          <p>{inspectBeforeNewAttempt}</p>
          <p>Discard removes this local queue entry only. It does not remove a post from a remote account.</p>
        </div> : null}

        {canEdit ? (
          <ScheduledItemActions editValue={editValue} busy={busy} canReschedule={canReschedule} onEdit={onEdit} onReschedule={onReschedule} onDiscard={onDiscard} />
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
