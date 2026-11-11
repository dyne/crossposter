# Required regression scenarios

Run the full commands in [README.md](README.md); a focused selection is useful
while editing but does not replace these gates. Keep the default IO guards and
required-test reporters enabled. Required cases must execute, with no skips or
unexpected outbound calls. A new behavior needs an observable assertion at its
owning boundary; increasing a test count is not an acceptance criterion.

| Boundary / required scenario | Representative executable tests |
| --- | --- |
| Isolation: disposable roots, independent reload, unconfigured provider/network/process calls fail even if caught | `app/harness.test.ts`, `app/component-harness.test.tsx` |
| Contracts: all eleven IDs, exhaustive registration, targets override platforms, route variants, malformed JSON/password precedence, URL/title/Unicode/byte/profile limits | `app/platform-catalog.test.ts`, `app/request-contract.test.ts`, `app/limits.test.ts`, `app/publish-route.test.ts`, `app/schedule-route.test.ts`; `*.typecheck.ts` via typecheck |
| Normalization/storage: malformed and legacy data, round trips, profile precedence, unrelated sections, media IO and failure behavior | `app/storage-normalization.test.ts`, `app/storage-adapters.test.ts`, `app/storage-facades.test.ts` |
| Publishing: no dispatch for invalid configuration, missing media, success/mixed/all-failed/uncertain results, non-Error throws, history failure after dispatch | `app/publish-service.test.ts`, `app/publish-runner.test.ts`, `app/provider-contract.test.ts` |
| Scheduling: due ordering, current-time/revision claims, results retained before removal, partial/uncertain failure, storage exceptions and running-guard release | `app/scheduling-service.test.ts`, `app/scheduler.test.ts`, `app/control-scheduling.test.ts` |
| Lifecycle/concurrency: single timer, hot reload/disable semantics, overlapping ticks, stale claims skipped, reschedule/cancel races, held operations released/settled | `app/scheduler-lifecycle.test.ts`, `app/scheduling-service.test.ts`, `app/scheduler.test.ts`, `app/schedule-item-route.test.ts` |
| Schedule routes: passive collection GET, tick GET 405/Allow: POST without effects under overdue/outage/corrupt storage, explicit POST dispatch/errors, lookup/404, one-minute tolerance, reschedule clearing errors, discard/rejected active mutations | `app/schedule-observation-route.test.ts`, `app/schedule-item-route.test.ts`, `app/schedule-route.test.ts` |
| Control cancellation: failed/pending item with removed/incomplete profile, unavailable session, absent media or invalid publication content; pure review/replay; changed queue/state conflicts | `app/control-actions.test.ts`, `control-runtime.test.mjs` |
| Independent owner approval: absent/wrong/machine credentials, bounded attempts, strict loopback host/origin, session rotation/expiry/revocation, CSRF, forged/expired/changed preparations, repeat/reversed decisions, held-IO revalidation, restart persistence and no dispatch/enqueue | `app/control-approvals.test.ts`, `control-approval-runtime.test.mjs` |
| Approved execution claims: durable independent decision, digest/deadline/dependency checks after final await, concurrent replay, held media IO, claim write failure, backend-owned delayed work, HTTP disconnect, shutdown and conservative restart recovery without replay | `app/control-execution.test.ts`, `control-execution-process.test.mjs` |
| Approved queue mutations: deterministic IDs, replay/restart, before/after intent/queue/final-journal failures, expired/past-at-commit times, raw/public revision conflicts, due versus reschedule/cancel, Berlin repeated times, readiness-independent cancellation and frozen account/media checks after authorization expiry | `app/control-scheduling.test.ts` |
| Scheduled outcome recovery: target intent/results, partial/all-failure/uncertainty, history failure and journal-backed post reads, orphaned queue/execution/dispatch/result boundaries, SIGKILL/restart, overdue never-claimed work and missing/corrupt journal | `app/control-scheduling.test.ts`, `app/scheduler.test.ts`, `control-execution-process.test.mjs` |
| Production headless scheduling: actual launcher/Next without dashboard requests, timer/ping overlap, HTTP attachment/EOF stand-ins, sole ownership, competing-backend refusal, shutdown/restart, overdue/interrupted work and environment/data `.env` disable semantics | `control-scheduler-runtime.test.mjs` |
| Approved target outcomes: sequential durable intent/results, strict explicit base/profile configuration, partial/all-failed/uncertain results, accepted writes followed by untagged Error/TypeError/non-Error rejection, completed browser session refresh versus changed pending/current bindings, interrupted pure reads, failures before/after intent/result/history, known-success retention, safe URLs and token-cache revocation | `app/control-execution.test.ts`, `control-publication-runtime.test.mjs`, `app/storage-normalization.test.ts` |
| Owner approval page: complete immutable preview, all lifecycle/auth/error states, keyboard focus, reload, double clicks, deadlines, frame protection and light/dark 100%/200% text layouts | `app/approval-page.test.tsx`, `e2e/approval-flows.spec.ts`, `e2e/approval-visual.spec.ts`, `control-approval-runtime.test.mjs` |
| Shared draft: stale/concurrent control and dashboard save/clear, empty/title-only content, attachment metadata/readback, recovery after deleted profiles/media, restored-resource and held-IO conflicts, failed/corrupt storage; serialized browser saves and conflict recovery | `app/control-draft.test.ts`, `app/composer-lifecycle.test.tsx`, `control-runtime.test.mjs`, `e2e/composer-flows.spec.ts`, `e2e/composer-media.spec.ts` |
| Control media: temporary image/video streams, MIME inference, unsupported/oversized/truncated input, abort/timeouts, read/write/link failures and cleanup, ID collision, owner loss, safe metadata, corrupt/missing data and digest-bound preparation | `app/control-media.test.ts`, `app/control-reads.test.ts`, `control-runtime.test.mjs` |
| Composer: reload/hydration ordering, draft/storage/upload errors, media replacement/removal/unmount cleanup, limits/profile/mixed-result actions | `app/composer-characterization.test.tsx`, `app/composer-lifecycle.test.tsx`, `app/composer-components.test.tsx`, `e2e/composer-flows.spec.ts` |
| Settings: load/save errors, unsaved edits, add/remove/switch profiles, secret rendering, mocked login/service/storage actions | `app/settings-state.test.tsx`, `app/settings-panels.test.tsx`, `e2e/settings-flows.spec.ts` |
| Calendar: UTC/Berlin DST and month/year/leap boundaries, failed fetch/reschedule/discard, uncertain messages and navigation | `app/scheduled-calendar.test.ts`, `app/scheduled-state.test.tsx`, `app/scheduled-components.test.tsx`, `e2e/scheduled-flows.spec.ts` |
| Presentation: composer/settings/calendar at 390×844 and 1440×900, 100%/200% font size | `e2e/*-visual.spec.ts`; compare retained original screenshots/sidecars, never silently replace baselines |
| Dependency direction: clients cannot reach Node/server modules through runtime imports; codecs/use cases cannot reach IO adapters | `architecture/import-boundaries.test.mjs` via `test:boundaries`, plus production `build` |
| Existing automation: publish verification and worker cache/history | `test_browser_publish_verification.py` via `test:browser-verification`; `../web/worker/star-history.test.mjs` via worker command |

The schedule title-only repair, retained explicit uncertainty, original
composer response-order behavior and single-process scheduler limits remain
characterized in [app/characterization.md](app/characterization.md) and the
publishing/storage/scheduling module READMEs. Do not change their assertions as a
side effect of a refactor.
