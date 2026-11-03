# Local MCP operating guide

Crossposter has two processes: a persistent backend owns storage, providers and
scheduling; a client starts the `crossposter-mcp` stdio bridge. Closing Codex or
Gestalt closes its bridge and leaves the backend running. Use existing accounts
configured through the normal [provider setup](README.md#provider-setup) and
Settings/sign-in flows. MCP provides no account connection tools.

This guide is for one local owner on the same machine. Bind to an explicit
loopback IP; remote MCP, proxies and multi-user hosting are outside this workflow.
The dashboard is optional for daily operations. The independent approval page
is required for publish, schedule, reschedule and cancel actions.

## 1. Build the local application

Use Node 22.22.2 or later in the Node 22 line, or Node 24.15 or later, plus npm
and Python 3. From the source checkout:

```bash
npm ci
npm run build
```

`build` produces both the Next backend and `dist/mcp`. To install a reviewed local
tarball with the same locked dependencies, from that checkout:

```bash
mkdir -p /absolute/staging /absolute/local-install
npm pack --dry-run --json
npm pack --pack-destination /absolute/staging
tar -xzf /absolute/staging/apoorvdarshan-crossposter-1.1.16.tgz -C /absolute/local-install
cp package-lock.json /absolute/local-install/package/package-lock.json
cd /absolute/local-install/package
npm ci --include=dev --ignore-scripts
npm run build
```

Use the filename printed by `npm pack` if the package version changes. npm omits
`package-lock.json` and `.next` from the tarball; the lock above comes from the
same reviewed checkout. `prepack` builds the shipped bridge, while the extracted
application still needs its backend build. These commands create a local
artifact, without publishing a package or installing a service.

## 2. Create the machine identity once

In Bash, replace these example paths with absolute paths. `APP_ROOT` is the
checkout or extracted `package` directory containing `package.json`. Keep the
data root separate from media selected for upload:

```bash
APP_ROOT=/absolute/local-install/package
DATA_ROOT=/absolute/private/crossposter-data
MEDIA_ROOT=/absolute/selected-media
mkdir -p "$DATA_ROOT" "$MEDIA_ROOT"
chmod 700 "$DATA_ROOT"
node "$APP_ROOT/scripts/setup-control.mjs" --data-root "$DATA_ROOT" --origin http://127.0.0.1:2004
```

For an existing installation, select its existing data root; do not copy an
identity to a new location. Setup exclusively creates `.poster-control.json`
with mode 0600, a random machine token and an identity bound to the canonical
data directory and exact origin. The token is never printed. Both processes
read that file locally; no token belongs in chat, tool arguments or client
configuration. Existing files, including symlinks, are refused. There is no
automatic credential overwrite or rotation command. Keep the root stable across
restarts and keep all its config, journal, uploads and sessions private.

The origin must be exactly `http://127.0.0.1:2004` (or your chosen port and
explicit loopback IP, including bracketed IPv6). `localhost`, a trailing slash,
HTTPS, URL credentials and non-loopback hosts are rejected by control setup.
Use the same literal origin everywhere; never scan for a backend on other ports.

## 3. Start the persistent backend separately

Set the owner approval password in a local terminal, outside the MCP client:

```bash
read -r -s -p 'Local owner approval password: ' POSTER_ADMIN_PASSWORD
printf '\n'
export POSTER_ADMIN_PASSWORD
CROSSPOSTER_DATA_DIR="$DATA_ROOT" CROSSPOSTER_TIMEZONE=Europe/Berlin \
  CROSSPOSTER_RUN_MODE=production node "$APP_ROOT/bin/crossposter.mjs" \
  --host 127.0.0.1 --port 2004 --data-dir "$DATA_ROOT" --no-open --no-update
```

Build first and confirm `APP_ROOT/.next/BUILD_ID` exists: without it, the launcher
falls back to development mode even when production is requested. Leave this
process running for scheduled work. Do not install/restart an existing service
just to attach a bridge. Only one backend may own the control-enabled data root.

Choose a distinct non-placeholder owner password, never the machine token. A
password already stored in `poster.config.local.json` takes precedence over
the environment; update it locally if necessary. The dashboard's
`POSTER_REQUIRE_ADMIN_PASSWORD` toggle does not turn off MCP owner approval.
Do not forward the owner password to the bridge; start the client from a separate
terminal without that exported password. Browser sessions expire after
15 minutes, and five wrong logins block further attempts for that 15-minute
window. Restart signs the browser out; persisted decisions remain valid subject
to their original expiry and dependency checks.

The launcher warms up after five seconds and pings every 30 seconds; the backend
owns its 30-second scheduler timer. `POSTER_DISABLE_SCHEDULER=true` in the backend
environment or data `.env` stops automatic ticks. It does not prevent explicit
ticks on legacy endpoints. MCP read tools never start or invoke a tick.

## 4. Configure Codex / Gestalt

The [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
checked on 2 November 2026,
describes stdio entries in Codex `config.toml`, including `command`, `args`,
`cwd`, `env` and forwarded `env_vars`. Use the configuration owned by your actual
Codex host; project entries require trust. Managed Gestalt sessions may control
registration and activation separately. Prepare the entry first and activate it
at the host's safe session boundary; a saved entry alone does not prove attachment.

Replace every example path below with a literal absolute path. TOML does not
run these strings through a shell: do not put `$DATA_ROOT`, `${HOME}`, `~` or
command substitutions in them. Use your actual Node executable path.

```toml
[mcp_servers.crossposter]
command = "/absolute/path/to/node"
args = ["/absolute/local-install/package/bin/crossposter-mcp.mjs"]
cwd = "/absolute/local-install/package"

[mcp_servers.crossposter.env]
CROSSPOSTER_DATA_DIR = "/absolute/private/crossposter-data"
CROSSPOSTER_MCP_ENDPOINT = "http://127.0.0.1:2004"
CROSSPOSTER_MCP_MEDIA_ROOTS = '["/absolute/selected-media"]'
```

`CROSSPOSTER_MCP_MEDIA_ROOTS` is a JSON array, with at most sixteen existing
absolute directories. Use `[]` to disable uploads. Select narrow media-only
directories, excluding data/config/session trees. Upload accepts one regular
file inside the canonical roots; symlinks resolving outside them, traversal,
directories and devices are rejected. Media bytes stream directly to the backend.

Optional limits are positive integer strings: `CROSSPOSTER_MCP_UPLOAD_MAX_BYTES`
defaults to 536870912 (512 MiB), with a maximum of 274877906944 (256 GiB);
`CROSSPOSTER_MCP_UPLOAD_TIMEOUT_MS` defaults to 900000 and can only be lowered.
Backend upload limits also apply, as do each provider's stricter rules. Set
nondefault limits on both processes when needed. Ordinary backend calls have
a 30-second bridge deadline; uploads use the configured deadline. If your host
has a shorter tool timeout, it can interrupt the call first.

Codex's `codex mcp list` shows configured entries; `/mcp` shows active servers in
the terminal client. Confirm thirteen discovered tools and call `get_status`:
check matching backend identity/version, `approvalConfigured` and scheduler
state. `list_targets` reports configuration readiness, not verified provider login.
Client tool approval prompts do not replace the separate owner decision.
`crossposter-mcp` accepts no arguments, including `--help`. Setup help is
`node scripts/setup-control.mjs --help`; backend help is
`node bin/crossposter.mjs --help`. Bridge stdout is exclusively MCP framing;
startup/protocol diagnostics go to stderr without credentials.

## Manual Codex launch, use and debugging

On 3 November 2026, the user explicitly deferred the live Codex / Gestalt and
independent-owner acceptance session. Do not interpret the automated tests or
this handoff as a successful real-client journey. That deferred session does
not block implementation review; backend owner approval remains required.

The shipped launcher follows Gestalt's dedicated-home approach. On **your first
manual invocation**, it creates `~/.codex-crossposter` privately and selects it
only for the child through Codex's documented
[`CODEX_HOME`](https://learn.chatgpt.com/docs/config-file/environment-variables).
The running shell's `HOME`, Codex/Gestalt home and session variables stay intact.
It copies no configuration, auth files, sessions, plugins or tokens. This is a
stdio app-server launcher with an optional direct-tool console, not Codex TUI.
It neither starts the Crossposter backend nor runs a model turn.

After starting the backend in section 3, use another local terminal:

```bash
APP_ROOT=/absolute/local-install/package
node "$APP_ROOT/scripts/codex-crossposter.mjs" --console \
  --data-dir /absolute/private/crossposter-data \
  --endpoint http://127.0.0.1:2004 --media-root /absolute/selected-media
```

Install Codex separately if it is absent; this launcher never installs it.
`--codex /absolute/path/to/codex` selects an executable when needed. The child
working directory is its private Codex state home. That home, the application
installation, backend data root and allowed media directories are distinct.
`--state-home /absolute/private/test-home` is available for a separate disposable
debug home. Never point it at your normal Codex or Gestalt home. Existing state
directories must be owned by you, have mode 0700 and not be symlinks.

An isolated home may need fresh Codex authentication. Quit the console first;
in a local terminal, authenticate into that same home without copying caches:

```bash
crossposterCodexHome="$HOME/.codex-crossposter"
env CODEX_HOME="$crossposterCodexHome" codex -c 'cli_auth_credentials_store="file"' login
```

The launcher creates the directory before launching the host, including on a
failed first attempt. If you selected `--state-home`, use that exact directory
for login too. The [official authentication guide](https://learn.chatgpt.com/docs/auth)
documents fresh login and file-based storage under the selected home. Keep the
login terminal attached; enter credentials directly there/in the browser. Do not
pipe login through this launcher or put tokens in chat. Then rerun the launcher.
Account/API/owner tokens and Gestalt control variables from the calling shell
are excluded from the host's environment; ordinary terminal/proxy/CA settings
are retained. Managed authentication requirements still apply.

Console commands are one line each:

```text
tools
call get_status {}
call list_targets {}
call get_draft {}
quit
```

Use `call <tool-name> <JSON object>` for the thirteen tools described below and
in [AGENT_POSTING.md](AGENT_POSTING.md). Paste JSON on one line and substitute
returned IDs/revisions/digests exactly. A preparation also prints its local
approval URL. Open that page separately, enter the owner password directly and
decide; the console has no owner-login/approval command. After that decision,
explicitly call `commit_action` and poll `get_action`. The console never commits,
retries or replays an action automatically. Ordinary RPCs have a 45-second
console deadline; uploads allow the bridge's default 15-minute deadline.

`quit`, EOF or Ctrl-C stops and awaits this owned host/bridge; the separate backend
continues. To check disconnect/reconnect, quit, rerun the same launch command,
and inspect the retained action/queue IDs. Restarting the console creates a new
ephemeral thread without replaying tools. No session history or tool arguments
are written by the console. Without `--console`, stdin/stdout carry app-server
JSON-RPC bytes unchanged for your own protocol client; diagnostic banners use
stderr. Do not feed TUI commands or shell commands to that stdio mode.

Every attempt prints its unique log directory on stderr:

```text
~/.codex-crossposter/crossposter-debug/<UTC-time>-<random-id>/
  lifecycle.jsonl   UTC start/spawn/shutdown/end, paths, exit/signal, startup errors
  stderr.log        child stderr, including native startup failures
  protocol.jsonl    frame/method/error metadata; no arguments/results or auth payloads
  codex-log/        Codex's own diagnostics selected through log_dir
~/.codex-crossposter/sqlite/    isolated native runtime state
~/.codex-crossposter/auth.json fresh file-based login, when configured by you
```

Directories are 0700; launcher log files are 0600, with a private inherited umask
for native files. Missing executable and native nonzero startup failures retain
logs and exit status. Signals target only the owned host process group; shutdown
is bounded and no backend is stopped. SIGKILL/power loss cannot record a final
event. The launcher does not run a version probe; version remains unknown until
observed in protocol initialization. Logs persist across attempts. Inspect the
latest run's `lifecycle.jsonl`, then `stderr.log` and `codex-log/`; do not share
auth files or unreviewed private diagnostics. Codex's own logs can contain local
data, so review/redact before sharing. The original restricted-runtime attempt
failed before initialization with a read-only filesystem error; its precise
write target/root cause was not established. This launcher has been checked
with fake processes only; a dedicated home is not a claim that the live failure
is fixed. No real Codex or owner journey was run for this handoff.

### Optional disposable manual fixture (source checkout only)

For later manual testing without real providers, build the source checkout and
run this helper yourself in a local terminal:

```bash
npm run build
python3 tests/manual_mcp_fixture.py
```

It prompts for a fixture owner password without echo, creates private disposable
data/media, and starts the production backend with the existing outbound/process
guard. Only synthetic Dev.to responses exist: `devto:base` succeeds;
`devto:uncertain` simulates an accepted request whose response is interrupted.
It prints a correctly quoted console launch command and retains backend logs
under the printed temporary fixture root's `logs/`. It never launches Codex or
approves an action. Test helpers are excluded from the runtime tarball.

In the later manual console, list targets, upload the printed fixture's
`media/fixture.png`, save/reload a draft and prepare publication to both targets.
Verify an unapproved commit cannot dispatch; independently approve in the browser,
commit and inspect both outcomes. Repeat commit on that ID and confirm no new
entries in `data/fixture-provider-calls.jsonl`. Prepare a schedule at least an
hour ahead for `devto:base`; independently approve/commit it, then do the same
for a reschedule. Quit/relaunch the console and verify the queue ID/content/time
survive, then independently approve/commit cancellation. Inspect each exact
30-minute approval expiry; expired/conflicting intent needs a new preparation
and request key. Never substitute a mock or scripted approval for your decision.

Keep the fixture terminal running while debugging; Ctrl-C stops/awaits its
backend and retains the private fixture data/logs. Review or remove that printed
fixture directory afterward; it contains machine credentials and retained local
content. The normal existing-account backend is a separate workflow and must
never receive these fixture settings. This optional live journey is deferred
at the user's request and was not run during implementation.

## 5. Daily workflow

See [AGENT_POSTING.md](AGENT_POSTING.md) for the complete tool sequence and input
examples. Start with `get_status`, `list_targets` and `get_draft`. Use returned
target IDs and current revisions. Upload one optional media file, then save and
reload the singleton draft if desired. Draft edits need no publication approval.

Prepare an explicit mode with a stable request key. Show the full immutable
preview and the approval path at the configured origin. The owner opens that
page, authenticates directly, checks accounts/content/media/time and chooses
Approve or Reject. An approval link or chat confirmation cannot approve. Never
ask the owner to send a password to the agent. After approval, commit only the
saved action ID and digest; poll that ID using `get_action` and inspect every
target outcome. Approval itself neither publishes nor enqueues.

The preparation window is 30 minutes. Content/account/media/relevant revision
changes require a new preparation and approval. Reuse a request key only for
the identical canonical request; a changed request needs a new key. Repeated
commit returns the same durable execution, without a new local dispatch.

Schedules require a future RFC3339 instant with `Z` or an explicit numeric offset,
at both preparation and commit. Resolve natural-language times before calling
the tool. `2027-10-31T02:30:00+02:00` and `2027-10-31T02:30:00+01:00` are distinct
Berlin instants. Storage uses UTC; the frozen preview displays the backend's
IANA `CROSSPOSTER_TIMEZONE` (default `Europe/Berlin`). The optional calendar uses
the browser's local timezone. Check the actual UTC and local preview before approval.
An accepted schedule retains authorization beyond the preparation deadline;
`scheduled`/`rescheduled` means queued, not published. Reschedule/cancel use the
queue item's current revision and their own preparation/approval/commit. Cancel
removes local pending/failed work and never deletes an already published native post.

## 6. Polling and recovery

| Observation | Next action |
| --- | --- |
| `executing` or running targets | Poll the same `actionId` with `get_action`; long provider work belongs to the backend. |
| Client disconnect, tool timeout or `backend_unavailable` | Reconnect to the same root/origin and inspect the known action ID. If preparation lost its response, repeat the identical request with the same request key. A lost response never proves rollback. |
| `partial`, `failed` or `uncertain` | Report all target states and safe URLs. Check provider accounts manually before any deliberate new attempt; exclude known successes. No automatic retry tool exists. |
| `not_dispatched` | This target has no durable dispatch claim; recovery still does not automatically resume it. A deliberate attempt requires a new preparation and approval. |
| Expired/rejected/conflicting approval or revision conflict | Reload current state; prepare the corrected intent under a new request key and obtain a fresh decision. |
| `cursor_stale` | Restart that collection from its first page; follow `nextCursor` until null. |
| `instance_mismatch` / `unauthorized` | Check exact origin, canonical root, credential permissions and matching application versions locally. Do not replace identity files to suppress an error. |
| `storage_corrupt`, `storage_unavailable` or `ownership_conflict` | Stop mutations and inspect local storage/ownership. Preserve journals and retained outcomes; never delete them to force a retry. See [storage recovery](lib/storage/README.md). |

Stop/restart only your owned backend process, retaining the same data root and
identity. Interrupted external calls become uncertain; known successes are never
automatically replayed. Overdue accepted work that was never dispatched can catch
up when the backend next ticks. Frozen account/media changes fail visibly instead
of silently replacing the authorized payload. There is no exactly-once guarantee
across the local filesystem and an external provider.

The legacy dashboard/HTTP publishing endpoints keep their existing authentication
policy. MCP approval does not globally govern those routes. Use MCP tools for an
MCP task rather than bypassing approval through `/api/publish` or `/api/scheduled`.

## Verification and acceptance limits

From a source checkout, `npm run test:mcp-package` audits the dry-run and actual
tarball, compares every delivered file with the checkout and rebuilt bridge,
installs with the current lock, builds the extracted backend, and exercises both
executables from an unrelated working directory against disposable state and
intercepted providers. Test files, personal config/media/sessions and generated
evidence are excluded from the package. The fixture browser decision is automated
test coverage; it is not evidence that an independent owner approved through the
actual Codex / Gestalt host. The user explicitly deferred real host discovery,
the live workflow and independent-owner observations on 3 November 2026. They
remain unverified future manual work and do not block this implementation's
review. Fake-executable launcher tests are part of `test:mcp`; all automated
protocol/backend/approval/UI/package gates remain required.
