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
| Local control, immutable preparation and replay | `lib/control/`; authenticated adapters in `app/api/mcp/v1/`; projections share the existing rules and normalized publishing content | [preparation and pure reads](tests/app/control-actions.test.ts), [ownership/durability](tests/app/control-storage.test.ts) |
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

## Shared draft edits

`lib/control/draft-service.ts` implements revision-aware save/clear for the one
composer draft. It resolves target IDs and stored media metadata on the server,
then rechecks ownership, configuration, draft and media after asynchronous IO.
`lib/storage/draft-service.ts` owns the synchronous final replacement shared by
the dashboard and control routes. The backend assigns monotonically advancing
update times, including when two writes occur within one millisecond.

The dashboard adds `revision` to its existing draft/history response and sends
`expectedRevision` when saving (`If-Match` when clearing through DELETE).
Its storage token and the control projection token are opaque, adapter-specific
values; use the revision returned by that adapter. Control additionally binds
actual attached bytes. A control-enabled backend refuses unversioned dashboard
draft changes. Without control setup, old unversioned callers retain legacy
compatibility. The browser serializes saves and stops after a failure/conflict;
it retains editor text locally and asks the owner to reload. Reload respects a
newer server save/clear and restores IndexedDB-only media only for the matching
server revision (or the existing initial/legacy migration).

An incumbent draft can retain a deleted profile or media file. Control draft
reads preserve its safe references and return a recovery revision binding the
observed missing-resource state, so it can be cleared or replaced. Restoring or
changing those resources invalidates that token. Missing bytes are never treated
as byte-verified; new attachments/targets and publication preparation still use
strict validation. Corrupt/unreadable configuration, metadata, or lost ownership
remain errors. Reads and mutations recheck their snapshot after media IO.

## Control media transfer

`POST /api/mcp/v1/media` accepts a raw binary stream after the existing machine
authentication. The bridge supplies a percent-encoded basename in
`X-Crossposter-Filename`, exact positive byte count in `X-Crossposter-Media-Size`,
and MIME in `Content-Type`. If supplied, HTTP Content-Length must agree. No
filesystem path is accepted as a stored-media location. The public MCP tool's
`localPath` remains a bridge input; it is never forwarded as backend authority.

`media-service.ts` reuses the incumbent filename, extension and MIME inference
rules, streams with a byte/time ceiling, hashes actual chunks and inspects at
most the first MiB for best-effort image dimensions. Unsupported generic files
are rejected. Provider-specific MIME, dimensions and limits remain preparation
rules. The legacy multipart dashboard upload keeps its existing behavior.

The media adapter stages bytes/metadata privately and links each final name
exclusively, preserving any preexisting ID. Returned metadata comes from the
strict stored-byte lookup, includes a SHA256 digest and omits paths. Ordinary
interruption/read/write failure removes owned staging/partial files. Ownership
loss or abrupt process death may retain private unreferenced staging; cleanup
never bypasses ownership or deletes another upload. No media ID is returned
until complete storage and readback verification. This is not a transaction
with a provider or a new crash-durability guarantee for media storage.

`CROSSPOSTER_MCP_UPLOAD_MAX_BYTES` defaults to 512 MiB and cannot exceed the
incumbent 256 GiB store ceiling; `CROSSPOSTER_MCP_UPLOAD_TIMEOUT_MS` defaults to
900000 and may only lower that deadline. `CROSSPOSTER_MCP_MEDIA_ROOTS` is a JSON
array of up to sixteen explicit absolute roots, default `[]`. The pure
`media-settings.ts` parser is available for the later bridge; realpath/symlink
authorization remains at that bridge boundary. Backend uploads never open these
caller-local paths and perform no remote downloads or provider requests.

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

When `.poster-control.json` is configured, `lib/control/backend-mutation.ts`
checks the setup, sole backend claim, configuration and action journal before
production mutations. The guard is shared by the optional dashboard's storage,
media, publishing and scheduling paths. The canonical data root has one durable
`.poster-owner.json` claim; another live backend is refused. Claims lost or
replaced during operation fail closed. Control reads remain pure and do not
acquire ownership or initialize storage. Without control setup and its retained
artifacts, the legacy behavior below remains in force.

`lib/control/action-store.ts` retains immutable payloads, replay keys and terminal
action/post/schedule identities in a versioned private journal. JSON replacement
writes a private temporary file, flushes it, renames it and flushes the directory.
A durable initialization marker prevents a disappeared journal from becoming an
empty replay store after restart. See the [storage notes](lib/storage/README.md)
for failure and stale-owner recovery rules. Preparation and execution authority
are separate from this persistence boundary.

Readers and durable writers share the same 64 MiB serialized UTF-8 ceiling;
overflow is rejected before replacing readable state. Accepted `scheduled` /
`rescheduled` actions can later record dispatch and final outcomes under their
existing immutable identity. Final outcomes remain protected from replay.

`action-service.ts` implements preparation and pure action lookup through narrow
injected effects. `read-projections.ts` shares account, content, draft/schedule
revision and media projections with the read API. Requests normalize through the
existing URL/publishing helpers, then validate every explicit target separately.
`account-binding.ts` freezes effective profile/base configuration and local
session state privately; a base target never follows active-profile selection.
Public snapshot revisions contain public identity/action data, not credentials.
No provider authentication is claimed. Publication/rescheduling configuration,
session, media or relevant draft/queue changes make preparatory actions conflicting.
Cancellation instead binds the retained queue snapshot and cancellable state;
missing credentials, session or media cannot prevent stopping failed/pending work.
Its safe preview keeps unverified references without reading live media or sessions.
Queue changes conflict even when public redaction hides them, while a live profile
label change alone does not change the retained queue identity. Expiry is derived
without updating the journal. `CROSSPOSTER_TIMEZONE` selects the IANA display zone
(default `Europe/Berlin`); offset-bearing future instants are stored in UTC.

`owner-auth.ts` separately authenticates the configured local admin password.
Opaque random in-memory sessions and their CSRF secrets are independent of the
machine token; sessions expire after fifteen minutes and are revoked by password
changes or backend restart. Exact loopback origin/host checks protect the browser
adapters under `app/api/approvals/`; machine authentication headers are refused.
Five failed logins close a fifteen-minute attempt window. MCP has no owner login
or decision operation. Configure the password locally as described in the README.

`action-service.ts` revalidates the frozen action before an owner decision, then
rechecks browser authority, deadline and journal revision after asynchronous IO.
Its verified snapshot returns a synchronous dependency assertion, invoked after
the final await before writing: account/session bindings, media file/metadata
identity, relevant draft and queue revisions are checked again. Cancellation
continues to bind only the retained queue snapshot and cancellable state.
The synchronous journal CAS retains a private immutable `ownerDecision` binding
the action ID, digest, preparation revision, expiry, choice and decision time.
Approved/rejected states require this record, which survives restart and stays
out of public action DTOs. Approval never calls a provider, scheduler or enqueue.
Commit independently verifies that retained authorization.

`execution-service.ts` now supplies that claim boundary and a backend-owned task
registry. It checks the retained independent decision, digest, deadline and
dependency snapshot, rechecks synchronously after the final await, then saves
`executing` before scheduling work. Concurrent commits replay the same claim;
provider work does not inherit the HTTP request or its cancellation signal.
Shutdown blocks new claims/further dispatch and tracks already running work.
Interrupted claims are conservatively terminalized without automatic replay;
dispatching intent becomes uncertain, while never-dispatched targets stay distinct.
The commit adapter accepts only the path action ID and body `expectedDigest`.
The production runner uses the incumbent publishing service with sequential
per-target hooks. Each hook revalidates identity/media/ownership, flushes intent,
then invokes the existing provider with an exact scoped base/profile config.
Base never follows the active profile; scoped missing values cannot fall back.
Results and safe URLs are flushed before the next target. Raw provider details
never enter the action journal or its compatible history.
`queue-service.ts` commits approved schedule/reschedule/cancel actions using a
durable queue intent, a deterministic schedule ID and an immutable authorization
binding on the queue item. A retry reconciles an already-written queue entry
before replacing anything. Untouched intents revalidate approval, future time
and dependencies before applying; already accepted entries retain authorization
beyond the preparation deadline. Pure reads explain unapplied expired intents
without changing files; owned recovery persists their expired state. Changed
queue bytes conflict, while exact accepted replacements finalize beyond expiry.
Reschedule binds the private retained queue
snapshot as well as its public revision. Cancellation never reads live account
or media readiness and only removes the local queue entry. Scheduled dispatch
uses the same per-target approved publisher and checks frozen account/media
bindings; later edits to the singleton draft cannot change an accepted job.
An approved dispatch that throws without a definitive returned result is uncertain,
including untagged transport/response-body errors and non-Error rejections: remote
acceptance may already have happened. Explicit unsuccessful results stay failed.
The publishing lifecycle supplies this classification without changing providers
or the legacy dashboard's exception semantics.
Preparation, approval and claim validate every target binding. During execution,
account/session checks follow retained outcomes and cover pending/current targets.
A completed browser provider's own session refresh does not invalidate an untouched
target; its original binding and result remain immutable. Pending/current account,
session, media, draft and ownership changes still stop further dispatch.

The stable `action-<id>` post ID is assigned with the claim. Control post reads
link to authoritative journal outcomes even if legacy history writing fails.
Known successes survive a later failure; retained dispatching intent becomes
uncertain, and never-dispatched targets remain distinct. Restart GETs project
interrupted work conservatively without modifying files. The next authenticated
commit persists recovery and returns that same action; it never resumes targets.
SIGTERM/SIGINT stop further claims/dispatch and track in-flight work during the
backend's grace period. Forced exit leaves durable intent for reconciliation.
Rotating machine material under a cached execution context fails closed without
creating a second worker. Restart the backend after offline rotation; existing
preparations bound to the old material need a new preview and approval.

`app/approvals/[id]` renders a focused owner review through browser-only adapters.
Its client keeps the session's CSRF value in memory, clears submitted passwords,
guards overlapping decisions and aborts superseded/unmounted reads. The complete
immutable preview precedes explicit Approve/Reject controls. Visible lifecycle
states distinguish approval, later commit, accepted schedules and recorded
publication outcomes. Only approval routes receive DENY/frame-ancestors headers;
the composer and settings retain their existing presentation and behavior.

Trace a failure through route response → publishing service → adapter result →
history/storage, using synthetic input and intercepted IO. Capture the target/
profile, error category and whether external completion was known; redact
credentials/media paths in shared reports. A provider `Error` with
`uncertain: true` remains uncertain in live results. Do not blindly retry:
check the account first. History-write failure can occur after a provider has
posted. Normalization preserves explicit uncertainty in history and queue results;
the control journal additionally retains dispatch evidence. [Runner](tests/app/publish-runner.test.ts) and
[route](tests/app/publish-route.test.ts) tests distinguish those boundaries.

The scheduler has one in-process running guard, a 30-second timer and sequential
due-post processing. Recovery runs inside that guard. Each claim rechecks the
current scheduled state, due time and complete queue revision; stale publishing
or rescheduled snapshots do not dispatch. Results are saved before queue removal,
and successful/partial items leave only with retained history or an authoritative
approved-action record. Failed/uncertain targets never retry automatically.
Interrupted approved dispatch uses the per-target journal: known results survive,
dispatching intent becomes uncertain, and never-dispatched targets stay distinct.
Orphaned legacy publishing entries become failed with conservatively matched
results. Overdue entries never claimed remain eligible for catch-up. Post reads
also use scheduled action IDs when compatible history is unavailable.
There is no external exactly-once guarantee. Cross-process ownership applies
only to control-enabled operation. The disable flag prevents starting a timer,
not explicit ticks; collection GET still ticks. JSON/media writes have no
transaction/rollback guarantee with a provider. See the controlled interleavings
in [scheduler tests](tests/app/scheduler.test.ts).

The incumbent launcher starts scheduling without a dashboard request: its
five-second warmup and thirty-second pings reach the backend tick, which starts
the shared thirty-second backend timer. Build first, then run a separate
persistent loopback process with
`CROSSPOSTER_RUN_MODE=production node bin/crossposter.mjs --host 127.0.0.1 --no-open --no-update --data-dir /absolute/data`.
Client attachment/disconnection does not own that process. No service installation
is implicit. `POSTER_DISABLE_SCHEDULER=true`, from the environment or data `.env`,
stops automatic launcher and backend ticks; an explicit tick remains available.
SIGTERM/SIGINT stop the backend timer while tracked execution settles. Restart
uses the same durable root claim and conservative queue recovery.

Valid title-only Dribbble/Pinterest schedules now survive storage, including
mixed selections of title-only platforms. Other preserved disagreements include
first-target limits for duplicate platforms on legacy routes, malformed JSON rejection order,
and original composer hydration/conversion completion ordering. The full table
and regression links are in [characterization.md](tests/app/characterization.md).
Calendar display uses browser-local days and UTC wire timestamps; test Berlin
DST and UTC explicitly rather than substituting local-time parsing.

Treat these as characterized contracts, not fixes delivered by extraction. A
behavior change needs its own decision and regression. Screenshot captures also
need comparison with retained originals: keep failed PNGs/sidecars and report
unexplained raster differences instead of changing baselines or tolerances.
