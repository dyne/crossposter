import type { PublishResult } from "@/lib/types";
import { inspectBeforeNewAttempt, publicationRows } from "@/lib/publication-outcomes";
import { PublicationOutcomes } from "@/components/publication-outcomes";

export function PublishResults({ results }: { results: PublishResult[] }) {
  const rows = publicationRows(results);
  return rows.length ? <div className="result-list" aria-label="Latest publish result">
    <p className="result-section-label">Latest result</p>
    <PublicationOutcomes rows={rows} />
    {rows.some((row) => row.state !== "Published") ? <p className="outcome-guidance">{inspectBeforeNewAttempt}</p> : null}
  </div> : null;
}
