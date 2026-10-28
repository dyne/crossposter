import { ExternalLink, Music2, File as FileIcon } from "lucide-react";
import { SocialLogo } from "@/components/social-logo";
import { isPlatform, platformLabels } from "@/lib/platform-catalog";
import { formatBytes, formatDateTime } from "@/lib/compose/presentation";
import type { PublishedPost } from "@/lib/types";

export function PublishedHistory({ publishedPosts }: { publishedPosts: PublishedPost[] }) {
  return <>{publishedPosts.length > 0 ? (
              <div className="result-list" aria-label="Published posts">
                {publishedPosts.map((post) => {
                  const okCount = post.results.filter((result) => result.ok).length;
                  const uncertainCount = post.results.filter((result) => result.uncertain).length;
                  const preview = post.text.trim();
                  const heading = post.title?.trim();

                  return (
                    <article className="result history-result" key={post.id}>
                      <div className="result-head history-head">
                        <div>
                          {heading ? <strong>{heading}</strong> : null}
                          <time className="history-time">{formatDateTime(post.createdAt)}</time>
                        </div>
                        <span
                          className={`badge ${okCount > 0 ? "ok" : uncertainCount > 0 ? "unknown" : "err"}`}
                        >
                          {okCount}/{post.results.length} ok
                          {uncertainCount > 0 ? ` · ${uncertainCount} check` : ""}
                        </span>
                      </div>
                      {preview ? <p className="history-preview">{preview}</p> : null}
                      {post.linkUrl ? (
                        <a className="result-link" href={post.linkUrl} target="_blank" rel="noreferrer">
                          <span>{post.linkUrl}</span>
                          <ExternalLink size={13} />
                        </a>
                      ) : null}
                      {post.media ? (
                        <div className="history-media">
                          {post.media.kind === "image" ? (
                            // eslint-disable-next-line @next/next/no-img-element -- local upload URLs are generated at runtime.
                            <img src={post.media.url} alt={post.media.filename} />
                          ) : null}
                          {post.media.kind === "video" ? (
                            <video controls preload="metadata" src={post.media.url} />
                          ) : null}
                          {post.media.kind === "audio" ? (
                            <div className="history-audio">
                              <Music2 size={18} />
                              <audio controls src={post.media.url} />
                            </div>
                          ) : null}
                          {post.media.kind === "file" ? (
                            <div className="history-file">
                              <FileIcon size={18} />
                              <span>{post.media.filename}</span>
                            </div>
                          ) : null}
                          <span>
                            {post.media.filename} · {post.media.contentType || "file"} ·{" "}
                            {formatBytes(post.media.size)}
                          </span>
                        </div>
                      ) : null}
                      <div className="history-platforms">
                        {post.results.map((result, index) => {
                          
                          const className = `history-platform ${
                            result.ok ? "ok" : result.uncertain ? "unknown" : "err"
                          }`;
                          const channelLabel = isPlatform(result.platform) ? platformLabels[result.platform] : result.platform;
                          const label =
                            result.profileLabel && result.profileLabel !== channelLabel
                              ? `${channelLabel} · ${result.profileLabel}`
                              : channelLabel;
                          const content = (
                            <>
                              <SocialLogo platform={result.platform} size="sm" />
                              <span>{label}</span>
                              {result.url ? <ExternalLink size={13} /> : null}
                            </>
                          );

                          return result.url ? (
                            <a
                              className={className}
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
                              className={className}
                              key={result.targetId || `${result.platform}:${index}`}
                              title={result.message}
                            >
                              {content}
                            </span>
                          );
                        })}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}</>;
}
