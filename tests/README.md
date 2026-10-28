# Running the regression checks

Use Node **22.22.2 or later** in the Node 22 line (or Node 24.15 or later), npm
and Python 3. The Python verification and worker tests need no extra packages.

```bash
npm ci
npm run test:unit
npm run test:coverage
npm run test:browser-verification
npm --prefix web run test:worker
npm run typecheck
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e
```

On a fresh Linux CI host, use `npx playwright install --with-deps chromium` to
install browser system dependencies too. The pull-request workflow runs these
checks on Node 22, with read-only repository permissions and no publishing or
account credentials. Failed commands fail the job. Coverage, browser JSON results
and failure traces/screenshots are retained for seven days as `test-evidence`.
The separate tag-triggered release workflow retains its existing authorization.

If the default npm/browser caches are read-only, use writable caches for the
installation and run:

```bash
npm ci --cache /tmp/crossposter-npm-cache
PLAYWRIGHT_BROWSERS_PATH=/tmp/crossposter-playwright-browsers npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/tmp/crossposter-playwright-browsers npm run test:e2e
```

Unit/component tests use the isolation helpers described in
[app/README.md](app/README.md). They exercise real TypeScript route, runner,
configuration and media modules with disposable roots and intercepted IO.
[Characterization notes](app/characterization.md) record existing disagreements
that this refactor preserves.

The three Chromium smoke tests exercise draft editing/reload, theme persistence,
mocked publishing with an uncertain result, and schedule controls/navigation.
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
