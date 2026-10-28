"use client";

import { CalendarClock, Trash2 } from "lucide-react";

export type ScheduledItemActionsProps = {
  editValue: string;
  busy: boolean;
  onEdit: (value: string) => void;
  onReschedule: () => void;
  onDiscard: () => void;
};

export function ScheduledItemActions({ editValue, busy, onEdit, onReschedule, onDiscard }: ScheduledItemActionsProps) {
  return (
    <div className="schedule-card-actions">
      <label>
        <span>Edit timing</span>
        <input
          type="datetime-local"
          value={editValue}
          onChange={(event) => onEdit(event.target.value)}
        />
      </label>
      <button
        className="secondary compact-button"
        disabled={busy}
        type="button"
        onClick={onReschedule}
      >
        <CalendarClock size={16} />
        Save timing
      </button>
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
