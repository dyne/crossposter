# Maintainer map

Crossposter remains one local-first Next application with synchronous local JSON
storage. Feature modules separate policies from IO without adding services,
transactions or queues. Keep the existing route adapters and exported facades
when moving code; consumers should not need a migration.

## Ownership and dependency direction

| Concern | Owning modules | Representative regression |
| --- | --- | --- |
| Public platform/profile/result types and request rules | `lib/types.ts`, `lib/platform-catalog.ts`, `lib/platform-limits.ts`, `lib/config-spec.ts`, `lib/publishing/contracts.ts` | [request contracts](tests/app/request-contract.test.ts), [platform type assertions](tests/app/platform-catalog.typecheck.ts) |
| Publishing use case and provider contract | `lib/publishing/service.ts`, `lib/publishing/provider.ts`; production wiring in `lib/publish-runner.ts` and `lib/providers/index.ts` | [service failures/results](tests/app/publish-service.test.ts), [adapter contracts](tests/app/provider-contract.test.ts) |
| Queue policy, tick, timer and route queries | `lib/scheduling/`; production wiring in `lib/scheduler.ts`, adapters in `app/api/scheduled/` | [tick/interleavings](tests/app/scheduling-service.test.ts), [lifecycle](tests/app/scheduler-lifecycle.test.ts), [item routes](tests/app/schedule-item-route.test.ts) |
| Persisted-data normalization and IO | `lib/storage/*codec*.ts` plus `codec-helpers.ts`; config/media stores and IO adapters in `lib/storage/`; facades `lib/local-config.ts`, `lib/media-store.ts` | [legacy normalization](tests/app/storage-normalization.test.ts), [adapter behavior](tests/app/storage-adapters.test.ts) |
| Composer | `app/page.tsx` composes `components/composer/`; draft/media/actions hooks own their async resources; browser helpers/clients in `lib/compose/` | [lifecycle/order](tests/app/composer-lifecycle.test.tsx), [page flows](tests/app/composer-components.test.tsx) |
| Settings | `app/settings/settings-client.tsx` composes `components/settings/`; configuration/profile state in `use-settings-config.ts`, other actions in their panel hooks; DTO/client/metadata in `lib/settings/` | [profile state](tests/app/settings-state.test.tsx), [mocked panels](tests/app/settings-panels.test.tsx) |
| Scheduled calendar | `app/scheduled/page.tsx` composes `components/scheduled/`; calendar math/presentation in `lib/scheduled/` | [date rules](tests/app/scheduled-calendar.test.ts), [state/errors](tests/app/scheduled-state.test.tsx) |

Browser entries depend on browser-safe types, rules, clients and views. They do
not import server configuration, Node, provider implementations or filesystem
stores at runtime. Type-only imports are erased. Publishing/scheduling use cases
accept narrow injected effects; production facades connect them to adapters.
Normalization functions accept unknown data and explicit default ID/time
callbacks, with no IO. Avoid a generic repository layer or moving every helper
into shared code. `npm run test:boundaries` traces runtime dependencies and
`npm run build` retains Next's production server-only checks.

See the [publishing](lib/publishing/README.md), [storage](lib/storage/README.md)
and [scheduling](lib/scheduling/README.md) notes for exact failure ordering and
compatibility limits. Browser clients own HTTP transport; route adapters retain
request/status behavior and invoke the server facades.

## Adding a provider or configuration field

1. Add a stable ID/label to `lib/platform-catalog.ts`. Extend descriptive
   metadata in `lib/compose/channels.ts` and `lib/settings/provider-guides.ts`,
   and title/text/media policy in `lib/platform-limits.ts` and
   `lib/compose/media-policy.ts` where needed. Preserve existing IDs.
2. Declare fields in `lib/config-spec.ts` with the existing environment name,
   default, secret rendering, help and `requiredFor`/`showFor` rules. Update its
   exhaustive `requiredConfigByPlatform` initializer for a new platform.
   `ProviderProfile` in `lib/types.ts` stores field values in a string map;
   adding a field does not require a second profile DTO or a new persisted format.
3. Implement `lib/providers/<id>.ts` using `Provider`/`ProviderContext`, then
   register it in `lib/providers/index.ts` (`satisfies ProviderRegistry` catches
   missing/extra registrations). Pass `ctx.target?.profileId` to every config
   lookup through `lib/env.ts`. Explicit profiles use their own values/defaults,
   never another profile's local/environment credentials. Without an explicit
   profile the existing precedence is active profile, local, environment, default.
4. Test public request limits, profile save/reload and legacy normalization.
   Add intercepted HTTP/subprocess adapter cases and run the adapter through
   `createPublishService` with in-memory effects. Assert success, rejection,
   uncertain outcomes, target annotations and history. No runner branch,
   live account, provider browser or real subprocess is needed.

Use [provider contract tests](tests/app/provider-contract.test.ts),
[registration type assertions](tests/app/provider-contract.typecheck.ts),
[profile precedence](tests/app/config.test.ts) and
[settings state](tests/app/settings-state.test.tsx) as concrete examples.
For a field on an existing provider, start at step 2 and preserve its environment
name/default behavior; update `.env.example` placeholders and setup copy when
applicable. Document unofficial integrations where users configure them.

## Test and package workflow

[CONTRIBUTING.md](CONTRIBUTING.md) lists all commands;
[tests/README.md](tests/README.md) explains the harness and measurement, and
[tests/SCENARIOS.md](tests/SCENARIOS.md) maps required behavior to executable tests.
Use the smallest relevant tests during edits, then run all regression gates.
Maintain the independent 85% statement / 80% branch critical-file thresholds.
Coverage includes unimported production app/lib/components files; browser
execution is a separate check, and lower UI/provider coverage remains visible.

Unit `setup.ts` removes inherited configuration, selects disposable roots before
collection, disables scheduler startup and rejects unconfigured outbound IO.
For modules capturing paths, call `useDataRoot()` then dynamically import them.
Prefer injected stores/providers and fake clocks; do not weaken production
`server-only` guards. Browser tests run a production server with temporary app/
data roots, no personal env/config, intercepted API requests and a server IO
preload guard. They never invoke real login, service installation or publishing.
See [isolation tests](tests/app/harness.test.ts) and
[browser fixtures](tests/e2e/fixtures.ts). Release held operations in `finally`,
await settlement and clean timers/object URLs even when an assertion fails.

`package.json` includes app/components/lib recursively. After adding modules,
inspect `npm pack --dry-run --json`, create a local tarball with `npm pack
--pack-destination <temporary-directory>`, and extract/build it with the locked
dependencies available. Check every extracted module against the source bytes
and keep tests, personal data and generated build/evidence out of the package.
This audit builds local files; it does not publish or deploy. Test sources and
the worker/static marketing tree are intentionally absent from the runtime pack.

## Debugging uncertain outcomes and existing limits

Trace a failure through route response → publishing service → adapter result →
history/storage, using synthetic input and intercepted IO. Capture the target/
profile, error category and whether external completion was known; redact
credentials/media paths in shared reports. A provider `Error` with
`uncertain: true` remains uncertain in live results. Do not blindly retry:
check the account first. History-write failure can occur after a provider has
posted, and persistence currently drops the uncertainty boolean while retaining
warning text. [Runner](tests/app/publish-runner.test.ts) and
[route](tests/app/publish-route.test.ts) tests distinguish those boundaries.

The scheduler has one in-process running guard, a 30-second timer and sequential
due-post processing. Any successful target removes the item, including partial
success; all-failed/uncertain attempts remain failed for user review. There are
no automatic retries, cross-process locks or exactly-once guarantees. The disable
flag prevents starting a timer, not explicit ticks; collection GET still ticks.
A due snapshot can dispatch a later entry another actor has rescheduled or
already set publishing. JSON/media writes have no transaction/rollback guarantee.
See [controlled interleavings](tests/app/scheduler.test.ts) before changing this.

Other preserved disagreements include title-only Dribbble/Pinterest schedules
accepted by request validation then dropped by storage (Hacker News survives),
first-target limits for duplicate platforms, malformed JSON rejection order,
and original composer hydration/conversion completion ordering. The full table
and regression links are in [characterization.md](tests/app/characterization.md).
Calendar display uses browser-local days and UTC wire timestamps; test Berlin
DST and UTC explicitly rather than substituting local-time parsing.

Treat these as characterized contracts, not fixes delivered by extraction. A
behavior change needs its own decision and regression. Screenshot captures also
need comparison with retained originals: keep failed PNGs/sidecars and report
unexplained raster differences instead of changing baselines or tolerances.
