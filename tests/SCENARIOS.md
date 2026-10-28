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
| Scheduling: due ordering, attempts/statuses, partial-success removal, uncertain failure, storage exceptions and running-guard release | `app/scheduling-service.test.ts`, `app/scheduler.test.ts` |
| Lifecycle/concurrency: single timer, hot reload/disable semantics, overlapping ticks, existing stale-claim behavior, held operations released/settled | `app/scheduler-lifecycle.test.ts`, `app/scheduling-service.test.ts`, `app/scheduler.test.ts` |
| Schedule routes: GET tick, lookup/404, one-minute tolerance, reschedule clearing errors, discard/rejected active mutations | `app/schedule-item-route.test.ts`, `app/schedule-route.test.ts` |
| Composer: reload/hydration ordering, draft/storage/upload errors, media replacement/removal/unmount cleanup, limits/profile/mixed-result actions | `app/composer-characterization.test.tsx`, `app/composer-lifecycle.test.tsx`, `app/composer-components.test.tsx`, `e2e/composer-flows.spec.ts` |
| Settings: load/save errors, unsaved edits, add/remove/switch profiles, secret rendering, mocked login/service/storage actions | `app/settings-state.test.tsx`, `app/settings-panels.test.tsx`, `e2e/settings-flows.spec.ts` |
| Calendar: UTC/Berlin DST and month/year/leap boundaries, failed fetch/reschedule/discard, uncertain messages and navigation | `app/scheduled-calendar.test.ts`, `app/scheduled-state.test.tsx`, `app/scheduled-components.test.tsx`, `e2e/scheduled-flows.spec.ts` |
| Presentation: composer/settings/calendar at 390×844 and 1440×900, 100%/200% font size | `e2e/*-visual.spec.ts`; compare retained original screenshots/sidecars, never silently replace baselines |
| Dependency direction: clients cannot reach Node/server modules through runtime imports; codecs/use cases cannot reach IO adapters | `architecture/import-boundaries.test.mjs` via `test:boundaries`, plus production `build` |
| Existing automation: publish verification and worker cache/history | `test_browser_publish_verification.py` via `test:browser-verification`; `../web/worker/star-history.test.mjs` via worker command |

The schedule title-only disagreement, loss of persisted uncertainty, original
composer response-order behavior and single-process scheduler limits remain
characterized in [app/characterization.md](app/characterization.md) and the
publishing/storage/scheduling module READMEs. Do not change their assertions as a
side effect of a refactor.
