# Running the regression checks

Use Node **22.22.2 or later** in the Node 22 line (or Node 24.15 or later), npm
and Python 3. The Python verification and worker tests need no extra packages.

```bash
npm ci
npm run test:boundaries
npm run test:unit
npm run test:coverage
npm run test:browser-verification
npm --prefix web run test:worker
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
npm run test:control-runtime
npm run test:e2e
npm run test:mcp
npm run test:mcp-package
```

On a fresh Linux CI host, use `npx playwright install --with-deps chromium` to
install browser system dependencies too. The pull-request workflow runs these
checks on Node 22, with read-only repository permissions and no publishing or
account credentials. After building and installing Chromium, it runs the
control-runtime, e2e, MCP and actual-package gates sequentially in the same
20-minute job. Each added runtime/MCP/package step has a five-minute limit.
Failed commands fail the job; subsequent gates run only if preceding steps
succeed. The artifact upload runs even after failure. Coverage, browser JSON
results, failure traces/screenshots, visual captures, runtime/MCP command logs
and the package audit are retained for seven days as `test-evidence`.
Command logs live in `output/ci/`, outside Playwright's cleaned `test-results/`
directory; package step logs/manifests and the tarball live under
`test-results/mcp-package/`. Visual captures live under `output/playwright/`.
The separate tag-triggered release workflow retains its existing authorization.

Coverage includes **all** production TypeScript/TSX under `app/`, `lib/` and
`components/`, including unimported files and route-page orchestration. It does
not measure the CLI, Python scripts or static marketing site. Vitest's unit
coverage does not include browser execution; browser smoke is a separate gate.
An unimported page/API adapter therefore contributes zero even if browser tests
exercise it. No whole-product coverage threshold is claimed.

`vitest.config.mts` explicitly gates each executable critical module at **85%
statements and 80% branches**, independently: publishing service/facade;
scheduling policy/service/lifecycle/queries/facade; shared request contracts,
platform catalog/limits/config specification; and all four normalization codec
modules. Per-file gates prevent aggregate masking. Type-only contracts have no
executable statements and are checked by `typecheck`. Storage IO, providers,
composer, settings, calendar and other routes are still measured and reported
separately; they are not silently excluded or represented by critical coverage.

`test:boundaries` parses current production imports with TypeScript, including
runtime re-exports, `require` and literal dynamic imports. It traces client
entries/browser-safe libraries to reject Node, `server-only`, providers and
server storage; it also keeps codecs and publishing/scheduling use cases apart
from concrete IO adapters. Type-only imports are erased and allowed. Unresolved
local/computed runtime imports fail these protected boundaries. Fixture tests
prove that violations are rejected. This source check complements Next's
production server/client guard; it does not inspect third-party package internals.
See the [required scenario checklist](SCENARIOS.md) for the behavior gates.

If the default npm/browser caches are read-only, use writable caches for the
installation and run:

```bash
npm ci --cache /tmp/crossposter-npm-cache
PLAYWRIGHT_BROWSERS_PATH=/tmp/crossposter-playwright-browsers npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/tmp/crossposter-playwright-browsers npm run test:control-runtime
PLAYWRIGHT_BROWSERS_PATH=/tmp/crossposter-playwright-browsers npm run test:e2e
```

The cache override must be identical at installation and at both browser-using
gates. An installed system Chrome alone does not satisfy Playwright's pinned
Chromium/headless-shell lookup. Build first, including when using the cache
commands above; do not skip a failed browser launch.

Run the runtime, e2e, MCP and package gates sequentially. Control/MCP fixtures
allocate loopback ports; e2e owns port 4173 and refuses an existing server.
The runtime/MCP suites use the checkout's production `.next` output, so
`npm run build` must finish before either starts. `test:mcp` rebuilds its bridge
itself. `test:mcp-package` packs the actual tarball, extracts it, supplies the
checkout lockfile (npm excludes it from the package), runs a fresh locked
development install and production build, then exercises both executables.
It needs `tar`, writable temporary storage and the locked npm dependencies
available from cache or the registry; its single test has a 180-second deadline
and each package build/install subprocess has a 100-second deadline.

Package evidence defaults to `test-results/mcp-package/audit-*` and includes
the tarball, byte manifest and timestamped command logs even on failure.
Set `CROSSPOSTER_TEST_EVIDENCE_DIR` to a writable retained directory to relocate
it. Capture each gate's stdout/stderr and exit code outside the disposable
fixture roots. Fixtures stop/await their owned children and remove their
temporary data in cleanup; retained evidence is deliberately separate.
No personal configuration, account login or provider credentials are needed.

Unit/component tests use the isolation helpers described in
[app/README.md](app/README.md). They exercise real TypeScript route, runner,
configuration and media modules with disposable roots and intercepted IO.
[Characterization notes](app/characterization.md) record existing disagreements
and the deliberately scoped Dribbble/Pinterest title-only persistence repair.

The Chromium smoke tests exercise draft editing/reload, theme persistence,
mocked publishing with an uncertain result, and schedule controls/navigation.
Composer media tests also exercise legacy IndexedDB migration, reload/removal,
and server-staged media imported through the current origin.
Every browser API call uses an explicit fixture. Unexpected API, outbound HTTP
or WebSocket requests fail the test. The Next production server uses a fresh
temporary application/data directory with no personal `.env` or configuration;
only build output/assets/dependencies are linked from the checkout. A test-only
preload denies server outbound network and subprocess calls. Scheduler timers
are disabled. Browser contexts and temporary server directories are disposable.

Run `npm run build` before `test:e2e`. Port 4173 must be free; the suite refuses
to reuse an existing server. No real account, profile cookies or provider browser
is needed. The tests never post to an external service.

Both runners fail with zero matched tests and when every collected test is
skipped. The default configurations also reject focused-only tests. When adding
CLI reporters, retain `tests/app/support/require-tests.ts` (Vitest) or
`tests/e2e/require-tests.ts` (Playwright) alongside them. Example unit evidence:

```bash
npm run test:unit -- --reporter=default --reporter=./tests/app/support/require-tests.ts --reporter=json --outputFile.json=test-results/unit.json
```

Composer lifecycle unit tests cover storage/upload failures, delayed responses,
media replacement/removal, and disposal of pending image/upload tasks and timers.
`composer-characterization.test.tsx` was first run against the original page
before extracting crop/conversion and persistence behavior.
`composer-components.test.tsx` exercises profile selection, limits, loading and
failure states, mixed/uncertain output and history through the composed page.
`composer-flows.spec.ts` adds keyboard editing, selection, upload/publish,
history reload/clear and scheduling with the same isolated browser fixtures.
Browser compose tests wait for the default profile checkbox to become selected
before editing; profile labels alone can appear before draft/media hydration.
The known pre-hydration overwrite remains a separate unit characterization.

The route composes views in `components/composer/`. Draft persistence, media
resources and publish/schedule actions each have an owning hook. Browser-safe
channel metadata, media policy, validation and presentation live in `lib/compose/`
and reuse the shared platform catalog/limits. No composer module imports server
configuration or provider implementations.

For local composer visual evidence, run the fixture matrix after building:

```bash
COMPOSER_VISUAL_PHASE=after PLAYWRIGHT_BROWSERS_PATH=/tmp/crossposter-playwright-browsers npm run test:e2e -- tests/e2e/composer-visual.spec.ts
```

This writes twelve full-page PNGs and metadata sidecars under the ignored
`output/playwright/composer-after/`: composer, media preview and uncertain
results at 390x844 and 1440x900, each at 100%/200% font size. Scaling multiplies
each HTML element's original computed font size; it does not change browser zoom,
viewport or device scale. Date, content, API responses and media are fixtures.
The screenshots are review artifacts; compare them with the retained baseline
for the same source/matrix. Capturing alone does not assert visual equivalence.
Set `COMPOSER_VISUAL_THEME=light` or `dark` and a distinct phase directory to
capture the same composer/media/results matrix in either existing theme.

The control-runtime gate also launches the existing Chromium against a disposable
production backend. It enters a synthetic owner password through the actual
approval page, checks machine-token refusal and protected cookies, records a
decision, restarts the backend and verifies sign-in plus durable approval. Use
the same `PLAYWRIGHT_BROWSERS_PATH` override as the e2e suite when necessary.
No real owner password, account or provider publication is involved.

`control-execution-process.test.mjs` compiles the actual execution, journal and
ownership modules into a disposable fake backend. It checks HTTP disconnect,
long simulated provider work and abrupt process restart before/after dispatching
intent using actual retained files. This establishes worker-process behavior;
it does not exercise Next's production provider adapter or any live account.
The same fixture compiles the approved queue service, accepts a scheduled job,
and kills its worker before dispatch or after durable intent. Restart retains
the schedule ID/authorization and distinguishes never-dispatched from uncertain
outcomes without provider replay. Production timer/launcher verification remains
a separate backend-runtime boundary.
`control-publication-runtime.test.mjs` additionally exercises the actual Next
commit/worker/read adapters and incumbent Dev.to provider with a fixture-only
preload. Only its exact outbound endpoint is intercepted in memory; all other
network/process IO remains denied. It covers strict base/profile values, HTTP
disconnect, post-acceptance response-body ambiguity/history, restart, SIGKILL/SIGTERM uncertainty and
machine-token rotation. No provider network connection is opened.

`control-scheduler-runtime.test.mjs` launches the actual packaged CLI and Next
production backend with disposable data and intercepted Dev.to IO. It checks
startup without dashboard requests, overlapping launcher/backend ticks, one
owner with multiple HTTP attachments, attachment EOF, competing-backend refusal,
normal shutdown, restart/overdue catch-up, interrupted dispatch, and scheduler
disable from the environment/data `.env`. The attachment processes are HTTP
stand-ins; they make no MCP stdio or Codex/Gestalt acceptance claim. A fixture-only
preload shortens the five-second warmup to 80 ms and thirty-second intervals to 120 ms
while executing the actual callbacks. All held providers and owned processes
are released/awaited, fixture ports close, and no user service is installed.

`approval-flows.spec.ts` covers keyboard sign-in/decision, errors, reload,
concurrent clicks, live expiry and blocked framing. `approval-visual.spec.ts`
captures long complete content, multiple targets and media at both required
viewports/text sizes in light and dark. Additional captures substantiate the
prepared/approved/rejected/expired/conflicting/executing/completed and auth/error
states. Set `APPROVAL_VISUAL_PHASE` to a distinct evidence name; output goes to
`output/playwright/approvals-<phase>/`. Inspect these in one batch and retain the
original captures when a single correction/confirmation pass is needed.
