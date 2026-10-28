import { X } from "lucide-react";
import type { ProgressState } from "@/lib/compose/media-conversion";

export function ProgressBox({
  progress,
  className = "",
  onCancel
}: {
  progress: ProgressState;
  className?: string;
  onCancel?: () => void;
}) {
  return (
    <div className={`progress-box ${className}`.trim()} role="status" aria-live="polite">
      <div className="progress-copy">
        <strong>{progress.label}</strong>
        <span>{Math.round(progress.value)}%</span>
        {onCancel ? (
          <button className="progress-cancel" type="button" onClick={onCancel}>
            <X size={14} />
            Cancel
          </button>
        ) : null}
      </div>
      <div className="progress-track">
        <span style={{ width: `${Math.max(3, Math.min(100, progress.value))}%` }} />
      </div>
    </div>
  );
}
