# Application tests

Run `npm run test:unit` for application tests, or `npm run test:coverage` for
the same tests with V8 coverage in `coverage/`. Both fail when no tests match.
Vitest resolves `@/` as the repository root. Its `server-only` alias is confined
to the test configuration; production guards remain active.

The suite uses Node by default. Component tests can select jsdom with
`// @vitest-environment jsdom` and use React Testing Library. JSX uses the
automatic React runtime. The installed tooling supports Node 22.22.2 or later
in the Node 22 release line (also Node 24.15 or later).

`setup.ts` creates disposable application/data roots before test collection,
removes inherited configuration fields, disables the scheduler, and installs
default failures for providers, subprocesses, fetch, WebSockets and Node
HTTP/socket APIs. Application filesystem operations used by configuration and
media storage are confined to fixture roots. These mocks protect the tested
application boundaries; they are not an operating-system sandbox for arbitrary
third-party code. No test should import account/browser tooling or use live
credentials.

Import modules that capture paths **dynamically after selecting a root**:

```ts
import { useDataRoot } from "./support/sandbox";

useDataRoot(); // sets environment, then resets the application module cache
const config = await import("@/lib/local-config");
config.writeLocalConfig({ ...config.readLocalConfig(), values: {} });
```

Use builders in `support/fixtures.ts` and `freezeClock()` when time matters.
Configure outbound results explicitly with `vi.mocked(providers.bluesky)` or
`vi.mocked(fetch)`. Unconfigured IO fails teardown even if application code
catches its error. `takeBlockedCalls()` exists only for guard characterization.
Tests within a file run sequentially; module cache, mocks, environment, globals,
timers and fixture directories are reset between tests. Scratch roots are
deleted when the test file finishes.

`test:e2e` runs the isolated Chromium smoke suite described in
[the testing guide](../README.md). It never launches provider-account browsers.
The default unit and browser reporters reject zero executed tests, including
blanket skips; focused-only tests are forbidden. Keep the required reporter
enabled when choosing additional CLI reporters for evidence capture.

See [existing behavior disagreements](characterization.md) before changing an
assertion that disagrees with a preferred future contract.
