# Existing behavior captured before extraction

These tests describe the production code at the refactor's starting commit.
They preserve observable disagreements rather than deciding a new contract.

| Behavior | Current observation | Tests |
| --- | --- | --- |
| Title-only scheduling | Publish and schedule request validation accept Hacker News, Dribbble and Pinterest with a title and empty text. Stored schedule normalization preserves only Hacker News. Dribbble/Pinterest POST returns 200 and a `scheduledPost`, but `scheduledPosts` and a subsequent store read are empty. | `publish-route.test.ts`, `schedule-route.test.ts` |
| Uncertain results | A provider exception marked `uncertain: true` remains uncertain in live runner/HTTP `results`. Configuration normalization drops that property from history and scheduled result records; even the returned `publishedPost.results` lacks it. Tests assert the live warning and existing history loss separately. | `publish-route.test.ts`, `publish-runner.test.ts` |
| Duplicate-platform limits | Validation evaluates the first target of each platform. For two X profiles, premium then free permits 281 characters; reversing the order rejects it using the free profile label. | `schedule-route.test.ts`, `limits.test.ts` |
| Duplicate schedule platform IDs | The schedule route initially deduplicates platform IDs, but persistence derives them again from targets without deduplication. Two Bluesky targets produce two Bluesky entries in the saved/returned schedule's `platforms`. Immediate history retains one platform entry and both targets. | `schedule-route.test.ts`, `publish-route.test.ts` |
| Malformed JSON | Both POST handlers reject with `SyntaxError` before returning a schema-validation response. These direct-handler tests make no claim about Next's final wire response for an uncaught exception. Publish checks missing password configuration first and can return 500 before JSON parsing. | `publish-route.test.ts`, `schedule-route.test.ts` |
| Password modes | Immediate publishing defaults to requiring a password in production unless explicitly disabled. Scheduling does not apply that password check. Payload validation precedes checking a supplied publish password. | `publish-route.test.ts`, `schedule-route.test.ts` |

Other covered contracts include target precedence, optional URL normalization,
error-message precedence, profile/local/environment/default configuration
lookup, a one-minute scheduling tolerance, per-profile premium limits,
graphemes versus UTF-8 bytes, real disposable media persistence, partial and
all-failed publishes, and history-write failure after provider completion.
Provider calls are explicit in-memory fakes. No characterization test invokes
real accounts, provider browsers or external services.
