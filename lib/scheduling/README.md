# Scheduled queue processing

`policy.ts` selects and orders due records and builds publishing/failure
transitions without IO. `service.ts` runs one sequential tick with an injected
queue store, publisher, clock and shared running state. `lib/scheduler.ts` wires
the local JSON store and existing publishing facade, retaining the public
`runScheduledTick` and `ensureSchedulerStarted` entry points, global process guard,
30-second unref'd timer and `POSTER_DISABLE_SCHEDULER=true` timer switch.

`lifecycle.ts` owns the shared global state and timer start/stop operations.
Repeated starts and module reloads reuse the existing timer and its first request
URL. The disable flag prevents starting a timer; it does not prevent an explicit
tick or cancel an existing timer. `stopSchedulerTimer(state)` stops future ticks
and clears the handle without releasing an active tick's running guard or
canceling its publish. Tests must release and await any active operation before
discarding state. Isolated states can exercise timer behavior without touching
the production global.

`queries.ts` supplies the collection/item routes' visible queue ordering and
lookup. Lists include `scheduled`, `publishing` and `failed`, newest creation
time first; item lookup also sees hidden statuses so the existing mutation
rejections remain intact. Collection GET only reads and projects the queue; it
does not start a timer, recover interrupted work or dispatch overdue records.
Tick GET returns 405 with `Allow: POST`; explicit POST ticks retain the guarded
dispatch path, including when automatic timers are disabled. The launcher already
uses POST for its warmup and periodic pings. PATCH clears errors/results when rescheduling, retaining attempts and
history linkage; PATCH/DELETE continue to reject publishing/published entries.
PATCH also rechecks the current queue revision after reading its request body,
so a concurrently claimed, removed or changed entry cannot be overwritten.

A tick snapshots due `scheduled` records once, oldest scheduled time first.
Each attempt reads the latest record through the synchronous update operation.
The claim requires the current record to remain `scheduled`, due at the current
clock and identical to that snapshot's complete internal revision. Missing,
publishing, changed or newly future records are skipped. The running guard
covers recovery as well as dispatch, including timer/ping overlap.

Every returned result is saved in the queue before removal. An item with a
successful target leaves only when the publisher returns a retained history
record, including the approved action-backed equivalent. Otherwise it stays
failed with complete results. Partial and uncertain target outcomes remain
inspectable in history or the action journal after removal/restart. There are
no automatic retries of successful, failed or uncertain dispatched targets.
The storage codec preserves explicit uncertainty.

Publisher errors become failed attempts. Removal or result-write errors retain
returned results in the fallback failure write, without counting the same
attempt twice. If that write also throws, the tick rejects and later due records
are not processed. Listing/claim errors also reject.
The shared running flag is always released in `finally`. Storage failures after
a successful external publish cannot roll back that publish.

## Approved dispatch and recovery

Approved queue entries carry their immutable action ID/digest. They use the
existing approved publisher's sequential per-target intent/result journal and
strict explicit-profile configuration; they never fall back to legacy publish.
The data-root owner protects control-enabled writes. Each provider call still
rechecks account/media/queue identity after its final await. A later draft edit
cannot change an accepted job, and its approval deadline does not expire it.

Recovery never starts a provider. Interrupted dispatching intent becomes
uncertain; known results and never-dispatched targets retain their distinction.
A queue claim which stopped before any action/provider claim becomes failed
without resumption. Complete terminal journal results are reconciled into the
queue before local cleanup, even if history writing failed. Control post reads
also expose scheduled action post IDs directly from the journal.

Without an action journal, orphaned legacy `publishing` entries become failed;
only uniquely matched known results remain definitive and missing/ambiguous
results become uncertain. Overdue `scheduled` entries which never claimed work
remain eligible for catch-up. Missing/corrupt control journals fail closed before
queue claims. The process guard and local journal provide no external
exactly-once guarantee or transaction with a provider.

`scheduler.test.ts` and `scheduling-service.test.ts` now reject the original
duplicate-publishing and stale-time reproductions. Held publishers prove current
status/time/revision checks with one or independent guards; every gate is released
and settled in `finally`. `control-scheduling.test.ts` covers retained journal
boundaries, partial/uncertain outcomes, history failure, pure post reads,
overdue catch-up and interrupted recovery using fake providers and real files.

`scheduler-lifecycle.test.ts` exercises fake-timer startup, hot reload, disable
semantics, overlap, failure reentry and cleanup. `schedule-item-route.test.ts`
tests item actions, the one-minute tolerance and explicit POST dispatch against
temporary storage and fixture publishers/media. `schedule-observation-route.test.ts`
checks passive collection/tick GETs under overdue work, provider outages and
corrupt/unavailable storage, plus POST error propagation and timer startup.
