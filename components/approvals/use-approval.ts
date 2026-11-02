"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlAction } from "@/lib/control/contracts";
import { approvalClient, ApprovalError, type OwnerSession } from "@/lib/approvals/client";

type Activity = "loading" | "signin" | "decision" | "signout";
type Result = { session?: OwnerSession | null; action?: ControlAction | null };
export function useApproval(id: string) {
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [action, setAction] = useState<ControlAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity | null>("loading");
  const [now, setNow] = useState(() => Date.now());
  const [focusVersion, setFocusVersion] = useState(0);
  const generation = useRef({ value: 0 }); const pending = useRef<AbortController | null>(null); const busy = useRef(false);
  const perform = useCallback(async (kind: Activity, task: (signal: AbortSignal) => Promise<Result>) => {
    if (busy.current) return;
    busy.current = true; const version = ++generation.current.value; const controller = new AbortController(); pending.current = controller;
    setActivity(kind); setError(null);
    try {
      const result = await task(controller.signal);
      if (version !== generation.current.value) return;
      if ("session" in result) setSession(result.session ?? null);
      if ("action" in result) setAction(result.action ?? null);
      setNow(Date.now());
      if (kind === "decision" || kind === "signin") setFocusVersion((value) => value + 1);
    } catch (failure) {
      if (version !== generation.current.value || (failure instanceof Error && failure.name === "AbortError")) return;
      const code = failure instanceof ApprovalError ? failure.code : "backend_unavailable";
      if (code === "approval_required" || code === "approval_setup_required") { setSession(null); setAction(null); }
      setError(kind === "loading" && code === "approval_required" ? null : code);
    } finally {
      if (version === generation.current.value) { busy.current = false; pending.current = null; setActivity(null); }
    }
  }, []);
  const refresh = useCallback(() => perform("loading", async (signal) => {
    const current = await approvalClient.session(signal);
    return { session: current, action: await approvalClient.action(id, signal) };
  }), [id, perform]);
  useEffect(() => {
    const counter = generation.current;
    setSession(null); setAction(null); void refresh();
    return () => { counter.value++; pending.current?.abort(); pending.current = null; busy.current = false; };
  }, [refresh]);
  useEffect(() => {
    const deadlines = [session?.expiresAt, action && ["prepared", "approved"].includes(action.state) ? action.expiresAt : null,
      action && ["prepared", "approved"].includes(action.state) && (action.payload.mode === "schedule" || action.payload.mode === "reschedule") ? action.payload.scheduledFor : null]
      .filter((value): value is string => Boolean(value)).map(Date.parse).filter((value) => value > now);
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(...deadlines) - now + 1);
    return () => window.clearTimeout(timer);
  }, [session, action, now]);
  const authenticated = Boolean(session && Date.parse(session.expiresAt) > now);
  const signin = (password: string) => perform("signin", async (signal) => {
    const current = await approvalClient.login(password, signal);
    return { session: current, action: await approvalClient.action(id, signal) };
  });
  const signout = () => session && perform("signout", async (signal) => { await approvalClient.logout(session, signal); return { session: null, action: null }; });
  const decide = (choice: "approve" | "reject") => {
    if (!action || !session || !authenticated || action.state !== "prepared" || error) return;
    return perform("decision", async (signal) => ({ action: await approvalClient.decide(id, {
      decision: choice, expectedDigest: action.payloadDigest, expectedRevision: action.revision, expiresAt: action.expiresAt
    }, session, signal) }));
  };
  return { action, error, activity, authenticated, now, focusVersion, signin, signout, decide, refresh };
}
