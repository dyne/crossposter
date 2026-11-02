"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, type FormEvent } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { platformLabels } from "@/lib/platform-catalog";
import type { ControlAction } from "@/lib/control/contracts";
import { approvalMessage } from "@/lib/approvals/client";
import { useApproval } from "./use-approval";
import styles from "./approval.module.css";

const states: Record<ControlAction["state"], [string, string]> = {
  prepared: ["Ready for your decision", "Approval permits a later MCP commit. It does not publish or enqueue this action."],
  approved: ["Approved for later commit", "Your approval is recorded. MCP must still commit before expiry. Approval is not evidence of publication."],
  rejected: ["Rejected", "This action cannot be committed. Request a new preparation if you want to proceed."],
  expired: ["Preparation expired", "This action can no longer be approved or committed. Request a new preparation and review it again."],
  conflicting: ["Preparation changed", "An account, draft, media or queue condition changed. Request a new preparation and review it again."],
  executing: ["Commit in progress", "The backend is executing this action. Refresh to inspect its recorded outcomes before another attempt."],
  scheduled: ["Schedule accepted", "The backend saved this schedule. It must remain running at the scheduled time. This is not a publication result."],
  rescheduled: ["Schedule updated", "The backend saved the new time. It must remain running at the scheduled time. This is not a publication result."],
  canceled: ["Schedule canceled", "The retained queue item was canceled. This does not delete a published post."],
  succeeded: ["Publication completed", "The backend reports success. Inspect the recorded target outcomes below."],
  partial: ["Partially completed", "Some targets did not succeed. Inspect every outcome before preparing another attempt."],
  failed: ["Commit failed", "Inspect the recorded outcomes before preparing another attempt."],
  uncertain: ["Outcome uncertain", "Check the selected accounts before another attempt. A missing confirmation does not establish that nothing was published."]
};
const modes = { publish: "Publish", schedule: "Schedule", reschedule: "Reschedule", cancel: "Cancel scheduled post" };
export function approvalState(action: ControlAction, now: number, error: string | null): ControlAction["state"] {
  if (error === "action_conflict" || error === "revision_conflict") return "conflicting";
  if (error === "approval_expired") return "expired";
  if (["prepared", "approved"].includes(action.state) && (now >= Date.parse(action.expiresAt)
    || ((action.payload.mode === "schedule" || action.payload.mode === "reschedule") && now >= Date.parse(action.payload.scheduledFor)))) return "expired";
  return action.state;
}
function Preview({ action }: { action: ControlAction }) {
  const { payload } = action;
  return <>
    <section className={styles.facts} aria-label="Action details">
      <div><h3>Mode</h3><p>{modes[payload.mode]}</p>{payload.mode === "publish" && <small>Publish when MCP commits this action.</small>}
        {"scheduleId" in payload && <><h3>Schedule ID</h3><code>{payload.scheduleId}</code></>}</div>
      <div><h3>Selected accounts</h3><ul className={styles.targets}>{payload.targets.map((target) => <li key={target.id}>
        <strong>{target.label}</strong><span>{platformLabels[target.platform]}</span><code>{target.id}</code>
      </li>)}</ul></div>
      {"scheduledFor" in payload && <div><h3>Schedule in UTC</h3><time dateTime={payload.scheduledFor}>{payload.scheduledFor}</time>
        <h3>Local schedule · {action.timezone}</h3><p>{action.scheduledLocal}</p></div>}
      <div><h3>Preparation expires (UTC)</h3><time dateTime={action.expiresAt}>{action.expiresAt}</time><small>Approval and the later commit must happen before expiry.</small></div>
    </section>
    <section className={styles.section} aria-labelledby="approval-content"><h2 id="approval-content">Exact content</h2>
      <h3>Title</h3><p className={styles.exact}>{payload.content.title || <span className={styles.muted}>No title</span>}</p>
      <h3>Post</h3><p className={styles.exact}>{payload.content.text || <span className={styles.muted}>No post text</span>}</p>
      <h3>Link</h3>{payload.content.linkUrl ? <a className={styles.link} href={payload.content.linkUrl} target="_blank" rel="noreferrer">{payload.content.linkUrl}</a> : <p className={styles.muted}>No link</p>}
    </section>
    <section className={styles.section} aria-labelledby="approval-media"><h2 id="approval-media">Media</h2>
      {payload.media ? <>
        {payload.media.kind === "image" && <Image className={styles.media} src={payload.media.url} alt={`Prepared media: ${payload.media.filename}`} width={720} height={480} unoptimized />}
        {payload.media.kind === "video" && <video className={styles.media} controls preload="metadata" src={payload.media.url} aria-label={`Prepared media: ${payload.media.filename}`} />}
        {payload.media.kind === "audio" && <audio controls preload="metadata" src={payload.media.url} aria-label={`Prepared media: ${payload.media.filename}`} />}
        <p>{payload.media.filename} · {payload.media.contentType} · {payload.media.size.toLocaleString("en-GB")} bytes</p>
        <h3>Media ID</h3><code>{payload.media.id}</code><h3>Byte digest</h3><code>{payload.media.digest}</code>
      </> : payload.content.mediaId ? <><p>Retained media reference: <code>{payload.content.mediaId}</code></p><p className={styles.muted}>No preview is available. Cancellation does not verify live media.</p></> : <p className={styles.muted}>No media attached</p>}
    </section>
    {action.warnings.length > 0 && <section className={styles.section} aria-labelledby="approval-warnings"><h2 id="approval-warnings">Review notes</h2><ul className={styles.warnings}>{action.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></section>}
    {!["prepared", "approved", "rejected", "expired", "conflicting"].includes(action.state) && <section className={styles.section} aria-labelledby="approval-outcomes"><h2 id="approval-outcomes">Recorded outcomes</h2>
      <ul className={styles.targets}>{action.outcomes.map((outcome) => <li key={outcome.target.id}><strong>{outcome.target.label} · {outcome.state.replaceAll("_", " ")}</strong><p>{outcome.message}</p>{outcome.url && <a href={outcome.url} target="_blank" rel="noreferrer">Open recorded result</a>}</li>)}</ul>
    </section>}
    <section className={styles.section} aria-label="Preparation identity"><h3>Action ID</h3><code>{action.id}</code><h3>Payload digest</h3><code>{action.payloadDigest}</code><h3>Action revision</h3><code>{action.revision}</code></section>
  </>;
}
export function ApprovalPage({ actionId }: { actionId: string }) {
  const owner = useApproval(actionId); const statusHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (owner.focusVersion) statusHeading.current?.focus(); }, [owner.focusVersion]);
  function signin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const password = String(new FormData(form).get("password") || ""); form.reset(); void owner.signin(password);
  }
  const action = owner.authenticated ? owner.action : null;
  const state = action ? approvalState(action, owner.now, owner.error) : null;
  const canDecide = state === "prepared" && !owner.activity && !owner.error;
  const showSignin = !owner.error || owner.error === "approval_required" || owner.error === "forbidden";
  const [heading, explanation] = state ? states[state] : ["Sign in to review", "Enter your local owner password directly in this browser. An approval URL alone cannot authorize an action."];
  const introduction = owner.error === "approval_setup_required" ? "Owner approval requires a password configured locally outside MCP. This page cannot configure it."
    : !action && owner.error && !showSignin ? "The saved action could not be loaded safely. Restore the local backend or request a new preparation." : explanation;
  return <main className={`workspace ${styles.page}`}>
    <a className={styles.skip} href="#approval-review">Skip to action</a>
    <header className={`masthead ${styles.header}`}><Link href="/" className={styles.brand} aria-label="Crossposter dashboard"><Image alt="" src="/assets/logo-crossposter.png" width={42} height={42} /><strong>Crossposter</strong></Link>
      <div className={styles.headerActions}><ThemeToggle />{owner.authenticated && <button className={styles.secondary} type="button" disabled={Boolean(owner.activity)} onClick={() => { void owner.signout(); }}>Sign out</button>}</div>
    </header>
    <h1>Review prepared action</h1><p className={styles.intro}>Inspect the complete preparation before allowing a later MCP commit.</p>
    <article id="approval-review" className={styles.review} aria-busy={Boolean(owner.activity)}>
      {owner.activity === "loading" && !action ? <div className={styles.section} role="status"><h2>Loading owner approval…</h2><p>Checking your local session and saved action.</p></div> : <>
        <div className={`${styles.status} ${state === "approved" || state === "succeeded" ? styles.success : ""}`} role="status" aria-live="polite"><h2 ref={statusHeading} tabIndex={-1}>{owner.error === "approval_setup_required" ? "Owner approval is not configured" : !action && owner.error && !showSignin ? "Action unavailable" : heading}</h2><p>{introduction}</p></div>
        {owner.error && <div className={styles.error} role="alert">{approvalMessage(owner.error)}</div>}
        {!owner.authenticated ? <section className={styles.section}>
          {showSignin && <form className={styles.login} method="post" action="/api/approvals/session" onSubmit={signin}><label htmlFor="owner-password">Local owner password</label><input id="owner-password" name="password" type="password" autoComplete="current-password" required maxLength={1024} disabled={Boolean(owner.activity)} />
            <button className={styles.primary} disabled={Boolean(owner.activity)} type="submit">{owner.activity === "signin" ? "Signing in…" : "Sign in to review"}</button><p className={styles.muted}>Use your locally configured owner password. Your MCP machine token cannot sign in.</p></form>}
          <button className={styles.secondary} type="button" disabled={Boolean(owner.activity)} onClick={() => { void owner.refresh(); }}>Reload approval</button>
        </section> : action && <>
          <Preview action={action} />
          <footer className={styles.decision}><p>{state === "prepared" ? "Approve only if this entire preparation matches your intent." : explanation}</p>
            <div className={styles.buttons}><button className={styles.primary} disabled={!canDecide} type="button" onClick={() => { void owner.decide("approve"); }}>{owner.activity === "decision" ? "Recording decision…" : "Approve"}</button>
              <button className={styles.reject} disabled={!canDecide} type="button" onClick={() => { void owner.decide("reject"); }}>Reject</button>
              <button className={styles.secondary} disabled={Boolean(owner.activity)} type="button" onClick={() => { void owner.refresh(); }}>Refresh status</button></div>
            <p className={styles.muted}>This page records permission only. Publication requires a later MCP commit and a recorded backend result.</p>
          </footer>
        </>}
      </>}
    </article>
  </main>;
}
