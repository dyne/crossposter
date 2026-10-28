# Contributing

Thanks for considering a contribution to Crossposter.

Crossposter is a small local/self-hosted publishing dashboard. Keep changes
focused, practical, and aligned with the current product scope.

## Current Scope

Supported publishing providers:

- X / Twitter
- LinkedIn
- Bluesky
- Mastodon
- Instagram
- YouTube
- Dev.to
- Pinterest
- Hacker News
- Nostr
- Dribbble

Provider changes should make the setup, limits, failure modes, and account-risk
tradeoffs clear in the UI and docs. Unofficial or cookie/session-based providers
must remain local and user-triggered.

Unofficial integrations must be documented as unofficial anywhere users configure
or learn about them. Note when a provider depends on cookies, local sessions,
private APIs, third-party tools, or normal browser/web submit flows. Do not
present those providers as platform-approved APIs.

Contributors should assume users are responsible for platform terms, automation
rules, rate limits, and content policies. Avoid changes that encourage bulk,
spammy, parallel, or account-risky posting.

## Development

Run the published local app without cloning:

```bash
npx @apoorvdarshan/crossposter@latest
```

For a source checkout, use Node 22.22.2 or later in the Node 22 line (or Node
24.15 or later), npm and Python 3. Install the locked dependencies:

```bash
npm ci
```

Run locally:

```bash
npm run dev:local
```

Open:

```text
http://localhost:2004
```

## Checks

Run these before opening a pull request:

```bash
npm run test:boundaries
npm run test:unit
npm run test:coverage
npm run test:browser-verification
npm --prefix web run test:worker
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Install Chromium once with `npx playwright install chromium` before the browser
suite; Linux CI uses `--with-deps`. Build before running it and leave port 4173
free. The tests use disposable data and intercepted provider/network/process
edges; never supply account credentials or disable those guards. No required
test may be skipped. The only existing lint warning is the anonymous default
export in `web/worker/index.mjs`.

See [the regression guide](tests/README.md) for cache options, evidence commands,
coverage limits and visual comparisons, and [the required scenarios](tests/SCENARIOS.md)
before changing a behavior assertion. Coverage gates apply independently to
critical files; the broader report is not a whole-product coverage guarantee.
Those test files/tools are for a source checkout and are not included in the
runtime npm package.

## Where to change behavior

Read [ARCHITECTURE.md](ARCHITECTURE.md) for ownership, dependency direction,
provider/profile extension steps and diagnostic entry points. Keep public route
shapes/statuses, provider IDs, environment names, local JSON/IndexedDB formats
and existing UI compatible during refactors. Add a regression at the owning
boundary before deciding a changed contract. The known disagreements are
documented in [the characterization notes](tests/app/characterization.md).

Before shipping extraction changes, run `npm pack --dry-run --json` and inspect
that new production modules are present. Build the actual tarball in a temporary
directory with the locked dependencies available; a checkout build alone does
not establish that the package contains its imports. Do not publish as a test.

## Secrets

Never commit API keys, access tokens, refresh tokens, app secrets, browser
cookies, platform passwords, local session folders, uploaded media, or
`poster.config.local.json`.

Use `.env.example` for documented placeholders only.

## Pull Requests

Good pull requests should:

- explain the problem being solved
- keep unrelated refactors out
- include screenshots for UI changes
- update docs when setup or behavior changes
- include focused tests or verification notes when relevant
- describe any unchanged failure/uncertainty or data compatibility limits

## Issues And Feature Requests

Use GitHub Issues for public bug reports and feature requests:

- Report an issue: https://github.com/apoorvdarshan/crossposter/issues/new
- Request a feature: https://github.com/apoorvdarshan/crossposter/issues/new
- View open issues: https://github.com/apoorvdarshan/crossposter/issues

Do not include API keys, tokens, secrets, or private account details in a public
issue. For sensitive security reports, use the email process in `SECURITY.md`.

## Code Style

Follow the existing TypeScript, React, and CSS patterns in the repo. Prefer
small, readable changes over broad rewrites.
