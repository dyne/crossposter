"use client";

import { CalendarClock, Clock3 } from "lucide-react";
import type { ScheduledPost } from "@/lib/types";
import { formatSelectedDate } from "@/lib/scheduled/calendar";
import { ScheduledItem } from "./scheduled-item";

type ScheduledListProps = {
  selectedDateKey: string;
  selectedDatePosts: ScheduledPost[];
  totalPosts: number;
  isLoading: boolean;
  edits: Record<string, string>;
  busyId: string;
  onEdit: (id: string, value: string) => void;
  onReschedule: (post: ScheduledPost) => void;
  onDiscard: (post: ScheduledPost) => void;
};

export function ScheduledList({ selectedDateKey, selectedDatePosts, totalPosts, isLoading, edits, busyId, onEdit, onReschedule, onDiscard }: ScheduledListProps) {
  return (
    <>
      <div className="scheduler-date-heading">
        <div>
          <span>Selected date</span>
          <h3>{formatSelectedDate(selectedDateKey)}</h3>
        </div>
        <strong>{selectedDatePosts.length}</strong>
      </div>

      <div className="scheduler-list">
        {isLoading ? (
          <div className="publish-empty">
            <Clock3 size={24} />
            <strong>Loading scheduled posts</strong>
            <span>Checking the local queue.</span>
          </div>
        ) : null}

        {!isLoading && totalPosts === 0 ? (
          <div className="publish-empty">
            <CalendarClock size={24} />
            <strong>No scheduled posts</strong>
            <span>Use Schedule draft on the Dashboard to add one.</span>
          </div>
        ) : null}

        {!isLoading && totalPosts > 0 && selectedDatePosts.length === 0 ? (
          <div className="publish-empty">
            <CalendarClock size={24} />
            <strong>No posts on this date</strong>
            <span>{formatSelectedDate(selectedDateKey)}</span>
          </div>
        ) : null}

        {selectedDatePosts.map((post) => (
          <ScheduledItem key={post.id} post={post} editValue={edits[post.id] || ""} busy={busyId === post.id}
            onEdit={(value) => onEdit(post.id, value)} onReschedule={() => onReschedule(post)} onDiscard={() => onDiscard(post)} />
        ))}
      </div>
    </>
  );
}
