import { CalendarClock, CheckCircle2, Radio, Send } from "lucide-react";
import { ProgressBox } from "./progress-box";
import { SchedulePopup } from "./schedule-popup";
import type { useComposerActions } from "./use-composer-actions";

type Actions = Pick<ReturnType<typeof useComposerActions>,
  "publish" | "toggleSchedulePanel" | "clearDraft" | "publishButtonLabel" | "topActionProgress" |
  "cancelProgressAction" | "schedulePanelPlacement" | "scheduleStatus" | "scheduleStatusPlacement" |
  "scheduledForIso" | "scheduledForInput" | "setScheduledForInput" | "setScheduleStatus" |
  "closeSchedulePanel" | "scheduleDraft" | "isScheduling"
>;
export function ComposeToolbar({ actions, postLength, canPublish, canOpenSchedule, canSchedule }: {
  actions: Actions; postLength: number; canPublish: boolean; canOpenSchedule: boolean; canSchedule: boolean;
}) {
  const { publish, toggleSchedulePanel, clearDraft, publishButtonLabel, topActionProgress, cancelProgressAction, schedulePanelPlacement, scheduleStatus, scheduleStatusPlacement } = actions;
  return (          <div className="compose-sticky">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Publish now</p>
              <h2 id="composeTitle">
                <Radio size={20} />
                Compose
              </h2>
            </div>
            <div className="compose-head-actions">
              <span className="counter">
                {postLength} chars
              </span>
              <button
                className="primary compact-button"
                disabled={!canPublish}
                onClick={() => void publish("top")}
              >
                <Send size={16} />
                {publishButtonLabel}
              </button>
              <button
                className="secondary compact-button"
                disabled={!canOpenSchedule}
                onClick={() => toggleSchedulePanel("top")}
                type="button"
              >
                <CalendarClock size={16} />
                Schedule draft
              </button>
              <button
                className="secondary compact-button"
                type="button"
                onClick={() => void clearDraft()}
              >
                Clear draft
              </button>
              {topActionProgress ? (
                <ProgressBox
                  className="head-progress"
                  onCancel={cancelProgressAction}
                  progress={topActionProgress}
                />
              ) : null}
            </div>
          </div>

          {schedulePanelPlacement === "top" ? <SchedulePopup placement="top" actions={actions} canSchedule={canSchedule} /> : null}
          {scheduleStatus && scheduleStatusPlacement === "top" ? (
            <p className="schedule-status schedule-status-top" role="status">
              <CheckCircle2 size={16} />
              {scheduleStatus}
            </p>
          ) : null}
          </div>);
}
