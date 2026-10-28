import { ExternalLink } from "lucide-react";
import { isPlatform, platformLabels } from "@/lib/platform-catalog";
import type { PublishResult } from "@/lib/types";

export function PublishResults({ results }: { results: PublishResult[] }) {
  return <>{results.length > 0 ? (
              <div className="result-list" aria-label="Latest publish result">
                <p className="result-section-label">Latest result</p>
                {results.map((result, index) => {
                  const channelLabel =
                    isPlatform(result.platform) ? platformLabels[result.platform] : result.platform;
                  const resultLabel =
                    result.profileLabel && result.profileLabel !== channelLabel
                      ? `${channelLabel} · ${result.profileLabel}`
                      : channelLabel;

                  return (
                  <div className="result" key={result.targetId || `${result.platform}:${index}`}>
                    <div className="result-head">
                      <strong>{resultLabel}</strong>
                      <span
                        className={`badge ${result.ok ? "ok" : result.uncertain ? "unknown" : "err"}`}
                      >
                        {result.ok ? "ok" : result.uncertain ? "check" : "error"}
                      </span>
                    </div>
                    <p>{result.message}</p>
                    {result.url ? (
                      <a className="result-link" href={result.url} target="_blank" rel="noreferrer">
                        <span>{result.url}</span>
                        <ExternalLink size={14} />
                      </a>
                    ) : null}
                  </div>
                  );
                })}
              </div>
            ) : null}</>;
}
