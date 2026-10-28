"use client";

import { useMemo, useState } from "react";
import NextImage from "next/image";
import Link from "next/link";
import { CalendarClock, RefreshCw, Send } from "lucide-react";
import { ProjectLinks } from "@/components/project-links";
import { ThemeToggle } from "@/components/theme-toggle";
import { useScheduledPosts } from "@/components/scheduled/use-scheduled-posts";
import {
  addMonths, startOfMonth, dateKey, groupPostsByDate, calendarDaysForMonth
} from "@/lib/scheduled/calendar";
import { CalendarGrid } from "@/components/scheduled/calendar-grid";
import { ScheduledList } from "@/components/scheduled/scheduled-list";

export default function ScheduledPage() {
  const { edits, setEdits, status, isLoading, busyId, counts, sortedPosts, loadScheduled, reschedule, discard } = useScheduledPosts();
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDateKey, setSelectedDateKey] = useState(() => dateKey(new Date()));

  const postsByDate = useMemo(() => groupPostsByDate(sortedPosts), [sortedPosts]);
  const calendarDays = useMemo(
    () => calendarDaysForMonth(visibleMonth, selectedDateKey, postsByDate, new Date()),
    [postsByDate, selectedDateKey, visibleMonth]
  );
  const selectedDatePosts = postsByDate.get(selectedDateKey) || [];

  return (
    <main className="workspace">
      <header className="masthead">
        <div className="brand-lockup">
          <NextImage
            alt=""
            className="mark"
            height="46"
            src="/assets/logo-crossposter.png"
            width="46"
          />
          <div className="brand-copy">
            <h1>Scheduler</h1>
            <ProjectLinks />
          </div>
        </div>
        <div className="masthead-actions">
          <nav className="top-tabs" aria-label="Primary sections">
            <Link className="top-tab" href="/">
              Dashboard
            </Link>
            <span className="top-tab is-active" aria-current="page">
              Scheduler
            </span>
            <Link className="top-tab" href="/settings">
              Settings
            </Link>
            <Link className="top-tab" href="/settings/storage">
              Storage
            </Link>
            <Link className="top-tab" href="/settings/socials">
              Socials
            </Link>
          </nav>
          <ThemeToggle />
          <button
            className="secondary compact-button masthead-action-slot"
            type="button"
            onClick={() => void loadScheduled(true)}
          >
            <RefreshCw size={17} />
            Refresh
          </button>
        </div>
      </header>

      <section className="scheduler-grid">
        <section className="info-panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Scheduled posts</p>
              <h2>
                <CalendarClock size={20} />
                Queue
              </h2>
            </div>
            <div className="scheduler-counts" aria-label="Scheduler counts">
              <span>{counts.scheduled} scheduled</span>
              <span>{counts.publishing} publishing</span>
              <span>{counts.failed} failed</span>
            </div>
          </div>

          <CalendarGrid
            visibleMonth={visibleMonth}
            calendarDays={calendarDays}
            onChangeMonth={(amount) => setVisibleMonth((current) => addMonths(current, amount))}
            onToday={() => {
              const today = new Date();
              setVisibleMonth(startOfMonth(today));
              setSelectedDateKey(dateKey(today));
            }}
            onSelectDay={(day) => {
              setSelectedDateKey(day.key);
              if (!day.isCurrentMonth) setVisibleMonth(startOfMonth(day.date));
            }}
          />
          <ScheduledList
            selectedDateKey={selectedDateKey}
            selectedDatePosts={selectedDatePosts}
            totalPosts={sortedPosts.length}
            isLoading={isLoading}
            edits={edits}
            busyId={busyId}
            onEdit={(id, value) => setEdits((current) => ({ ...current, [id]: value }))}
            onReschedule={(post) => void reschedule(post)}
            onDiscard={(post) => void discard(post)}
          />
        </section>

        <aside className="info-panel scheduler-help">
          <div className="panel-heading compact">
            <h2>
              <Send size={18} />
              Runtime
            </h2>
          </div>
          <div className="config-panel">
            <p className="hint">
              Scheduled posts publish from this running Crossposter server. Keep the local service,
              Render service, or VPS process online at the scheduled time.
            </p>
            <p className="hint">
              Media uploads happen when you click Schedule draft. The scheduler then reuses that
              saved local upload when the post becomes due.
            </p>
          </div>
        </aside>
      </section>

      {status ? (
        <p className="floating-status" role="status" aria-live="polite">
          {status}
        </p>
      ) : null}
    </main>
  );
}
