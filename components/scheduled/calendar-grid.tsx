"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatMonth, weekdayLabels, type calendarDaysForMonth } from "@/lib/scheduled/calendar";

type CalendarDay = ReturnType<typeof calendarDaysForMonth>[number];
type CalendarGridProps = {
  visibleMonth: Date;
  calendarDays: CalendarDay[];
  onChangeMonth: (amount: number) => void;
  onToday: () => void;
  onSelectDay: (day: CalendarDay) => void;
};

export function CalendarGrid({ visibleMonth, calendarDays, onChangeMonth, onToday, onSelectDay }: CalendarGridProps) {
  return (
    <section className="scheduler-calendar" aria-label="Scheduled posts calendar">
      <div className="scheduler-calendar-bar">
        <div>
          <span>Month</span>
          <strong>{formatMonth(visibleMonth)}</strong>
        </div>
        <div className="scheduler-calendar-controls">
          <button
            aria-label="Previous month"
            className="secondary compact-button scheduler-month-button"
            type="button"
            onClick={() => onChangeMonth(-1)}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            className="secondary compact-button"
            type="button"
            onClick={onToday}
          >
            Today
          </button>
          <button
            aria-label="Next month"
            className="secondary compact-button scheduler-month-button"
            type="button"
            onClick={() => onChangeMonth(1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </div>

      <div className="scheduler-weekdays" aria-hidden="true">
        {weekdayLabels.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="scheduler-calendar-grid">
        {calendarDays.map((day) => {
          const failedCount = day.posts.filter((post) => post.status === "failed").length;
          const publishingCount = day.posts.filter((post) => post.status === "publishing").length;
          const scheduledCount = day.posts.filter((post) => post.status === "scheduled").length;
          const countLabel = day.posts.length === 1 ? "1 post" : `${day.posts.length} posts`;

          return (
            <button
              aria-label={`${day.date.toLocaleDateString("en-US")}: ${countLabel}`}
              className={[
                "scheduler-day",
                day.isCurrentMonth ? "" : "is-muted",
                day.isSelected ? "is-selected" : "",
                day.isToday ? "is-today" : "",
                day.posts.length ? "has-posts" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              key={day.key}
              type="button"
              onClick={() => onSelectDay(day)}
            >
              <span className="scheduler-day-top">
                <span className="scheduler-day-number">{day.date.getDate()}</span>
                {day.posts.length ? (
                  <span className="scheduler-day-count">{day.posts.length}</span>
                ) : null}
              </span>
              <span className="scheduler-day-markers" aria-hidden="true">
                {scheduledCount ? <span className="scheduler-day-dot" /> : null}
                {publishingCount ? <span className="scheduler-day-dot publishing" /> : null}
                {failedCount ? <span className="scheduler-day-dot failed" /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
