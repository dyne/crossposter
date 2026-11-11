import { ExternalLink } from "lucide-react";
import type { OutcomeRow } from "@/lib/publication-outcomes";

export function PublicationOutcomes({ rows }: { rows: OutcomeRow[] }) {
  return <ul className="outcome-list">
    {rows.map((row) => <li className="outcome-row" key={row.key}>
      <div className="outcome-head">
        <strong>{row.label}</strong>
        <span className={`badge ${row.state === "Published" ? "ok" : row.state === "Failed" ? "err" : row.state === "Outcome unknown" ? "unknown" : "not-sent"}`}>{row.state}</span>
      </div>
      {row.message.length > 200 ? <details className="outcome-details">
        <summary>Details for {row.label}</summary>
        <p>{row.message}</p>
      </details> : <p>{row.message}</p>}
      {row.url ? <a className="result-link" href={row.url} target="_blank" rel="noreferrer"><span>{row.state === "Published" ? "Open post on" : "Inspect retained link for"} {row.label}</span><ExternalLink size={14} /></a> : null}
    </li>)}
  </ul>;
}
