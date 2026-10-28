import { CalendarClock, X } from "lucide-react";
import {
  datetimeDatePart, datetimeTimePart, datetimeLocalValue, formatDateTime,
  mergeDateTimeParts, tomorrowMorning, type ProgressPlacement
} from "@/lib/compose/presentation";
import type { useComposerActions } from "./use-composer-actions";

type ScheduleActions = Pick<ReturnType<typeof useComposerActions>,
  "scheduledForIso" | "scheduledForInput" | "setScheduledForInput" | "setScheduleStatus" |
  "closeSchedulePanel" | "scheduleDraft" | "isScheduling"
>;
export function SchedulePopup({ placement, actions, canSchedule }: {
  placement: ProgressPlacement; actions: ScheduleActions; canSchedule: boolean;
}) {
  const { scheduledForIso, scheduledForInput, setScheduledForInput, setScheduleStatus, closeSchedulePanel, scheduleDraft, isScheduling } = actions;
  return (
      <div className={`schedule-popup schedule-popup-${placement}`}>
        <div className="schedule-popup-head">
          <div>
            <strong>Schedule draft</strong>
            <span>{scheduledForIso ? formatDateTime(scheduledForIso) : "Choose a date and time"}</span>
          </div>
          <div className="schedule-popup-actions">
            <div className="schedule-presets" aria-label="Schedule presets">
              <button
                type="button"
                onClick={() =>
                  setScheduledForInput(datetimeLocalValue(new Date(Date.now() + 30 * 60 * 1000)))
                }
              >
                30 min
              </button>
              <button
                type="button"
                onClick={() =>
                  setScheduledForInput(datetimeLocalValue(new Date(Date.now() + 2 * 60 * 60 * 1000)))
                }
              >
                2 hours
              </button>
              <button
                type="button"
                onClick={() => setScheduledForInput(datetimeLocalValue(tomorrowMorning()))}
              >
                Tomorrow 9 AM
              </button>
            </div>
            <button
              className="secondary compact-button icon-button"
              type="button"
              onClick={closeSchedulePanel}
              aria-label="Close schedule popup"
            >
              <X size={17} />
            </button>
          </div>
        </div>
        <div className="schedule-picker">
          <label>
            <span>Date</span>
            <input
              min={datetimeDatePart(datetimeLocalValue(new Date()))}
              onChange={(event) => {
                setScheduledForInput((current) =>
                  mergeDateTimeParts(current, "date", event.target.value)
                );
                setScheduleStatus("");
              }}
              type="date"
              value={datetimeDatePart(scheduledForInput)}
            />
          </label>
          <label>
            <span>Time</span>
            <input
              onChange={(event) => {
                setScheduledForInput((current) =>
                  mergeDateTimeParts(current, "time", event.target.value)
                );
                setScheduleStatus("");
              }}
              type="time"
              value={datetimeTimePart(scheduledForInput)}
            />
          </label>
          <button
            className="primary compact-button"
            disabled={!canSchedule}
            onClick={() => void scheduleDraft(placement)}
            type="button"
          >
            <CalendarClock size={17} />
            {isScheduling ? "Scheduling..." : "Confirm schedule"}
          </button>
        </div>
      </div>
    );

}
