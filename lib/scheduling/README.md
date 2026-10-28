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
rejections remain intact. Collection GET still awaits a tick before returning
the list. PATCH clears errors/results when rescheduling, retaining attempts and
history linkage; PATCH/DELETE continue to reject publishing/published entries.

A tick snapshots due `scheduled` records once, oldest scheduled time first.
Each attempt reads the latest record through the synchronous update operation.
Missing records and records that no longer return `publishing` are skipped.
The explicit claim result distinguishes a transition to `publishing` from a
record already in that state. For compatibility, both results still dispatch.
The current claim does not check the scheduled time again.

Any successful target removes the record, including partial success with other
failed or uncertain targets. With no success, the record becomes `failed`,
attempts increments once and results/history ID are retained when available.
Unknown outcomes carry the existing warning to check the account before
rescheduling. There are no automatic retries. The storage codec still drops
the persisted `uncertain` flag while preserving the warning text.

Publisher errors become failed attempts. Removal or result-write errors enter
the same failure handler; if that failure write also throws, the tick rejects
and later due records are not processed. Listing/claim errors also reject.
The shared running flag is always released in `finally`. Storage failures after
a successful external publish cannot roll back that publish.

## Existing claim and consistency limits

The process guard prevents overlapping ticks that share the same state. It is
not a cross-process lock, and the JSON update supplies no ownership token or
exactly-once delivery guarantee. A due snapshot can become stale while the tick
awaits an earlier publisher:

- If another actor sets a later due entry to `publishing`, the unchanged entry
  is returned and this tick also dispatches it. A separate actor may already
  have dispatched the same post.
- If another actor reschedules a later entry into the future while leaving it
  `scheduled`, this tick still transitions and dispatches it from its snapshot.
- Removal or a change to `failed` skips that entry.

`tests/app/scheduler.test.ts` reproduces all four interleavings with a held first
publisher, a bounded wait, explicit state preconditions, and release/settlement
in `finally`. These cases passed against the scheduler before extraction.
They document existing behavior; distributed coordination and changed claim
eligibility require a separate behavior decision. Injected-service tests in
`scheduling-service.test.ts` also reproduce duplicate dispatch with two independent
running guards sharing a store: the first tick holds its earlier publisher, the
second tick claims the later entry and holds its publisher, then the first tick
resumes and dispatches that already-publishing entry too. This models independent
process guards; it does not establish filesystem transaction guarantees. Both
held operations are released and settled, with zero in-flight publishers left.
The same suite covers failure boundaries without account IO.

`scheduler-lifecycle.test.ts` exercises fake-timer startup, hot reload, disable
semantics, overlap, failure reentry and cleanup. `schedule-item-route.test.ts`
tests item actions, the one-minute tolerance, GET-triggered publishing and both
tick methods against temporary storage and fixture publishers/media. Its item
and tick cases passed against the routes before the shared-query extraction.
