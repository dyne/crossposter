import { ExternalLink, Music2, File as FileIcon } from "lucide-react";
import { formatBytes, formatDateTime } from "@/lib/compose/presentation";
import { inspectBeforeNewAttempt, outcomeSummary, publicationRows, type PublicationView } from "@/lib/publication-outcomes";
import { PublicationOutcomes } from "@/components/publication-outcomes";

export function PublishedHistory({ publishedPosts }: { publishedPosts: PublicationView[] }) {
  return <>{publishedPosts.length > 0 ? (
              <div className="result-list" aria-label="Published posts">
                {publishedPosts.map((post) => {
                  const rows = publicationRows(post.results, post.targets, post.outcomes);
                  const preview = post.text.trim();
                  const heading = post.title?.trim();

                  return (
                    <article className="result history-result" key={post.id}>
                      <div className="result-head history-head">
                        <div>
                          {heading ? <strong>{heading}</strong> : null}
                          <time className="history-time">{formatDateTime(post.createdAt)}</time>
                        </div>
                        <span className="outcome-summary">{outcomeSummary(rows)}</span>
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
                      <PublicationOutcomes rows={rows} />
                      {rows.some((row) => row.state !== "Published" && row.state !== "Not sent") ? <p className="outcome-guidance">{inspectBeforeNewAttempt}</p> : null}
                    </article>
                  );
                })}
              </div>
            ) : null}</>;
}
