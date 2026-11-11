# Existing behavior captured before extraction

These tests describe the production code at the refactor's starting commit.
They preserve observable disagreements except the explicitly scoped repairs
described below. The draft lifecycle rows describe the current corrected contract.

| Behavior | Current observation | Tests |
| --- | --- | --- |
| Queue observation | Collection GET reads/projects the queue without timer startup, recovery or dispatch, even with overdue work, provider outages or corrupt storage. Tick GET rejects with 405 and `Allow: POST`. Explicit POST ticks preserve due dispatch, origin handling, guarded overlap and existing failure behavior; the launcher uses POST already. | `schedule-observation-route.test.ts`, `schedule-item-route.test.ts`, `scheduler-lifecycle.test.ts` |
| Title-only scheduling | Requests accept Hacker News, Dribbble and Pinterest with a title and empty text. Preparation work repairs the original loss of valid Dribbble/Pinterest schedules in storage, including mixed title-only selections. Other legacy normalization remains characterized separately. | `publish-route.test.ts`, `schedule-route.test.ts`, `storage-normalization.test.ts`, `control-actions.test.ts` |
| Uncertain results | A provider exception marked `uncertain: true` remains uncertain in live runner/HTTP `results`. Approved execution work now preserves that flag through history/schedule normalization, including returned `publishedPost.results`; absent/false flags keep the compatible shape. | `publish-route.test.ts`, `publish-runner.test.ts`, `storage-normalization.test.ts`, `control-execution.test.ts` |
| Duplicate-platform limits | Validation evaluates every selected account's effective text limit before deduplicating redundant messages. Premium/free X selections reject 281 characters in either order and identify the free account; rejected requests neither enqueue nor dispatch. | `schedule-route.test.ts`, `publish-route.test.ts`, `request-contract.test.ts`, `limits.test.ts` |
| Duplicate schedule platform IDs | Schedule persistence derives a unique platform summary in first-occurrence order while preserving every target's ID, profile ID, label and order. Two Bluesky accounts remain two targets and one platform through save/reload. Legacy platform-only records and history normalization retain their existing selection semantics. | `storage-normalization.test.ts`, `schedule-route.test.ts`, `publish-route.test.ts` |
| Malformed JSON | Both POST handlers reject with `SyntaxError` before returning a schema-validation response. These direct-handler tests make no claim about Next's final wire response for an uncaught exception. Publish checks missing password configuration first and can return 500 before JSON parsing. | `publish-route.test.ts`, `schedule-route.test.ts` |
| Password modes | Immediate publishing defaults to requiring a password in production unless explicitly disabled. Scheduling does not apply that password check. Payload validation precedes checking a supplied publish password. | `publish-route.test.ts`, `schedule-route.test.ts` |
| Composer hydration | Draft recovery fills only fields untouched by the user, including intentional clears and target selection. Text and the shared server revision recover independently of media; a failed media import/IndexedDB read cannot replace valid server text. Media chosen while loading survives delayed recovery. An unmounted load cannot apply results. | `composer-characterization.test.tsx`, `composer-lifecycle.test.tsx` |
| Composer saving | Debounced writes are serialized and advance from successful server revisions; response bodies never replace edits. Non-OK/409 responses stop queued and future writes until reload, retaining local edits. An initial read failure recovers browser text locally without guessing a server revision. Visible loading, saving, local-only, conflict and backup diagnostics offer text copy/download before deliberate reload. | `composer-characterization.test.tsx`, `composer-client-storage.test.ts`, `composer-lifecycle.test.tsx`, `composer-flows.spec.ts` |
| Composer conversion overlap | Compression/crop results, errors and progress belong to the current media generation and latest transformation. Selection, removal, clear or unmount abort obsolete work; late completion cannot replace current media, preview or dimensions. A stale task cannot settle a newer task's busy state, clear newer upload progress or initiate an upload of the old selection. Image/preview URLs and owned timers are disposed. | `composer-lifecycle.test.tsx`, `composer-characterization.test.tsx`, `composer-media.spec.ts` |

Other covered contracts include target precedence, optional URL normalization,
error-message precedence, profile/local/environment/default configuration
lookup, a one-minute scheduling tolerance, per-profile premium limits,
graphemes versus UTF-8 bytes, real disposable media persistence, partial and
all-failed publishes, and history-write failure after provider completion.
Provider calls are explicit in-memory fakes. No characterization test invokes
real accounts, provider browsers or external services.
