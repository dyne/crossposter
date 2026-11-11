"use client";

import { CalendarClock, Trash2 } from "lucide-react";

export type ScheduledItemActionsProps = {
  editValue: string;
  busy: boolean;
  onEdit: (value: string) => void;
  onReschedule: () => void;
  onDiscard: () => void;
};

export function ScheduledItemActions({ editValue, busy, canReschedule = true, onEdit, onReschedule, onDiscard }: ScheduledItemActionsProps & { canReschedule?: boolean }) {
  return (
    <div className="schedule-card-actions">
      {canReschedule ? (
        <>
          <div className="schedule-timing-field">
          <label>
            <span>Edit timing</span>
            <input
              type="datetime-local"
              value={editValue}
              onChange={(event) => onEdit(event.target.value)}
            />
          </label>
          <p className="schedule-edit-value">{editValue ? editValue.replace("T", " at ") : "Choose a date and time"}</p>
          </div>
          <button
            className="secondary compact-button"
            disabled={busy}
            type="button"
            onClick={onReschedule}
          >
            <CalendarClock size={16} />
            Save timing
          </button>
        </>
      ) : null}
      <button
        className="danger-button compact-button"
        disabled={busy}
        type="button"
        onClick={onDiscard}
      >
        <Trash2 size={16} />
        Discard
      </button>
    </div>
  );
}
