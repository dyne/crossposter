"use client";

import { useEffect, useMemo, useState } from "react";
import type { ScheduledPost } from "@/lib/types";
import { datetimeLocalValue, datetimeLocalToIso, isQueuePost, sortScheduledPosts } from "@/lib/scheduled/calendar";
import { apiError } from "@/lib/scheduled/presentation";

type ScheduledResponse = {
  scheduledPosts?: ScheduledPost[];
  scheduledPost?: ScheduledPost;
  error?: unknown;
};

export function useScheduledPosts() {
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState("");

  async function loadScheduled(showStatus = false) {
    try {
      const response = await fetch("/api/scheduled", { cache: "no-store" });
      const body = (await response.json()) as ScheduledResponse;

      if (!response.ok) {
        setStatus(apiError(body.error));
        return;
      }

      const nextPosts = (body.scheduledPosts || []).filter(isQueuePost);

      setPosts(nextPosts);
      // Refresh seeds new rows but preserves every existing local edit.
      setEdits((current) => ({
        ...Object.fromEntries(nextPosts.map((post) => [post.id, datetimeLocalValue(post.scheduledFor)])),
        ...current
      }));

      if (showStatus) {
        setStatus("Scheduler refreshed.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load scheduled posts.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadScheduled();
    const timer = window.setInterval(() => {
      void loadScheduled();
    }, 30_000);

    return () => window.clearInterval(timer);
  }, []);

  const counts = useMemo(
    () => ({
      scheduled: posts.filter((post) => post.status === "scheduled").length,
      publishing: posts.filter((post) => post.status === "publishing").length,
      failed: posts.filter((post) => post.status === "failed").length
    }),
    [posts]
  );

  const sortedPosts = useMemo(() => sortScheduledPosts(posts), [posts]);

  async function reschedule(post: ScheduledPost) {
    const scheduledFor = datetimeLocalToIso(edits[post.id] || "");

    if (!scheduledFor) {
      setStatus("Choose a valid scheduled time.");
      return;
    }

    setBusyId(post.id);
    setStatus("");

    try {
      const response = await fetch(`/api/scheduled/${encodeURIComponent(post.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduledFor })
      });
      const body = (await response.json()) as ScheduledResponse;

      if (!response.ok) {
        setStatus(apiError(body.error));
        return;
      }

      setPosts((body.scheduledPosts || []).filter(isQueuePost));
      setStatus("Schedule timing updated.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not reschedule post.");
    } finally {
      setBusyId("");
    }
  }

  async function discard(post: ScheduledPost) {
    setBusyId(post.id);
    setStatus("");

    try {
      const response = await fetch(`/api/scheduled/${encodeURIComponent(post.id)}`, {
        method: "DELETE"
      });
      const body = (await response.json()) as ScheduledResponse;

      if (!response.ok) {
        setStatus(apiError(body.error));
        return;
      }

      setPosts((body.scheduledPosts || []).filter(isQueuePost));
      setStatus("Scheduled post discarded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not discard post.");
    } finally {
      setBusyId("");
    }
  }

  return { edits, setEdits, status, isLoading, busyId, counts, sortedPosts, loadScheduled, reschedule, discard };
}
