# Publishing orchestration

`service.ts` exposes `createPublishService` with explicit provider, configuration,
media, history, clock and ID dependencies. It imports no concrete provider or
storage implementation. `lib/publish-runner.ts` wires the production dependencies
and retains the `runPublish`, `PublishRunInput` and `PublishRunResult` exports used
by both the immediate publish route and scheduler. Both runtime modules retain
the server-only guard; request contracts remain browser-safe in `contracts.ts`.

The service applies the existing title/text limits before media lookup or
dispatch. Explicit targets take precedence over platform defaults. Configuration
issues fail only their target; valid targets dispatch concurrently with
`Promise.all`, and results remain in target order. There are no automatic retries.
Each provider receives its target/profile, the shared normalized content and the
same publish time. History receives every outcome after dispatch completes,
including all-failed attempts, and only public media fields.

Provider exceptions become failed results. An `Error` carrying `uncertain: true`
keeps that warning; other thrown values use `Unknown error`. Live results are
returned separately from the history writer's returned post, which preserves the
existing storage normalization (including its loss of stored uncertainty).
Media/config lookup errors and history-write errors reject the operation. A
history-write failure can occur after publishing has completed; this boundary
adds no transaction, rollback or retry guarantee.

`tests/app/publish-service.test.ts` exercises this use case with injected memory
edges. `publish-runner.test.ts` and the publish/schedule route tests retain
coverage of the production wiring and existing public behavior.

## Adding a provider

`provider.ts` exports `Provider = (context: ProviderContext) =>
Promise<PublishResult>` and the exhaustive `ProviderRegistry`. These types are
also re-exported from `lib/providers/index.ts`. Adapters consume the existing
`ProviderContext` in `lib/types.ts`: trimmed content, selected target/profile,
all targets, publish time and optional media (including its private local path).
Use `ctx.target?.profileId` for every configuration lookup through `lib/env.ts`;
an explicitly selected profile must not silently use another account's values.
Return the platform, `ok`, a user-facing message and an optional published URL.
Target/profile annotations may be returned by the adapter; the service fills
missing annotations and always enforces the dispatched platform.

The extension locations are:

| Responsibility | Location |
| --- | --- |
| Stable platform ID and label | `lib/platform-catalog.ts`: `platformIds` and exhaustive `platformLabels`; these supply the shared `Platform` type and request/storage identity checks. |
| Adapter registration | Add `lib/providers/<platform>.ts`, then import and register it in `lib/providers/index.ts`. `satisfies ProviderRegistry` rejects missing/extra registrations. The runner needs no platform branch. |
| Configuration/profile fields | `lib/config-spec.ts`: `configFields` names, labels/help, defaults, `secret`, `requiredFor`/`showFor`, and exhaustive `requiredConfigByPlatform` initializer. Keep environment names and profile precedence explicit. |
| Content/media limits | `lib/platform-limits.ts`: title/text limits and counting rules; enforce adapter-specific MIME, dimensions and upload constraints in the adapter before external IO. |
| Composer/settings metadata | `lib/compose/channels.ts`: `channels` supplies labels and composer/media hints; `lib/compose/media-policy.ts` owns browser media eligibility. `lib/settings/provider-guides.ts`: `platforms` and optional `setupGuides` expose profile configuration. These UI lists remain separate from the shared ID/label catalog. |
| Request/storage regression fixtures | `tests/app/platform-catalog.test.ts`, `request-contract.test.ts`, route tests and storage tests; preserve existing persisted IDs/formats and validation precedence. |
| Adapter/registration contract tests | `tests/app/provider-contract.test.ts` and `provider-contract.typecheck.ts`; run `npm run test:unit -- tests/app/provider-contract.test.ts` and `npm run typecheck`. |

Test a provider through `createPublishService` using an in-memory registry and
temporary profile configuration. Intercept HTTP or subprocess IO with explicit
one-shot fixtures; leave setup's default IO denials enabled. Assert the request
or command arguments, success/rejection mapping, target annotations and history.
Never call a live account, process or provider browser from these tests.

The representative Dev.to fixtures exercise real HTTP-adapter code with fake
`fetch`; X fixtures exercise the real subprocess-output parser with a fake
`execFile` callback. They cover success, rejection and unknown outcomes without
launching Python. An HTTP transport exception currently becomes an ordinary
failed result without an uncertainty flag. The X helper preserves explicit JSON
`uncertain: true` on rejection; its existing zero-exit, malformed-output fallback
is success without a URL. These fixtures retain those mappings rather than
introducing a new outcome policy. When an adapter cannot confirm a publish,
use the established `Error` with `uncertain: true` contract and test it through
the service. Users must check the account before retrying an uncertain outcome;
the service never retries automatically.
