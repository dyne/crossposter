# Local storage boundaries

`local-config.ts` and `media-store.ts` keep their existing exports and wire the
production stores. They capture `CROSSPOSTER_DATA_DIR` (falling back to the
current working directory) when imported. `CROSSPOSTER_APP_ROOT` does not change
these data paths. The JSON and media adapter constructors accept an explicit
data root and never look up environment variables themselves.

`config-codec.ts`, `content-codec.ts` and `schedule-codec.ts` normalize unknown
persisted data without IO. Missing profile/post IDs and post timestamps use
explicit callbacks. They preserve the existing truncation, coercion and legacy
URL/config rules; request validation is a separate boundary. The configuration
store receives JSON IO, defaults and environment lookup. It keeps active profile,
local value, environment and field-default precedence, including the existing
exclusion of local/environment credentials for explicitly selected profiles.

The deliberate schedule-codec exception is valid title-only Dribbble/Pinterest
content, which now survives round trips (including mixed title-only targets).
Other legacy coercion, selection and fallback behavior remains unchanged.

`media-service.ts` keeps upload validation, filename/MIME handling and best-effort
image dimensions. Its media adapter handles bytes and metadata files under
`.poster-uploads`. Metadata has the existing shape and filename; lookup derives
the current path from the metadata ID and obtains the size from the actual file.
Stored paths, kinds and sizes are not treated as authoritative during lookup.

Control's raw streaming upload uses the same media service with a configured
size/deadline, exact chunk count and SHA256 digest. It retains at most one MiB
for image-header inspection. The filesystem adapter uses private `.incoming-*`
staging and exclusive final links; successful uploads add optional `digest` to
the incumbent metadata format. Strict control lookup recomputes it from actual
bytes and rejects mismatches. Legacy metadata without a digest remains readable
and its current bytes are still hashed for preparation. Interrupted/failed
owned uploads clean their staging and partial links. Ownership loss and abrupt
death can leave private unreferenced files; these grant no draft, approval or
publishing authority. Dashboard multipart upload compatibility is unchanged.

Draft replacement now has a narrow shared synchronous service. Both supported
clients can send an expected revision; a stale write returns a conflict before
replacing the singleton. The control route resolves explicit targets and stored
media, checks its existing content/target/time/byte-digest revision, and rechecks
its dependencies after media IO. The dashboard uses an additive storage revision
and compatible response fields. Server update times advance on every accepted
save/clear; supplied timestamps cannot reset the revision or resurrect an old
draft. The replacement reads current configuration immediately before writing,
preserving unrelated known history, queue and profile sections.
Deleted incumbent profile/media references do not prevent acquiring a recovery
draft revision and clearing/replacing them. That revision binds missing-resource
state; restoring files/profiles or racing another draft change conflicts. Only
draft observation uses the missing-file probe; attachment lookup and publication
remain strict, and corrupt/unreadable state still fails closed.

## Existing consistency and error limits

### Control-enabled ownership and durability

An explicit `.poster-control.json` opts the canonical data root into backend
ownership. A complete fsynced private claim is linked exclusively at
`.poster-owner.json`. Every supported production config write, media mutation,
publish dispatch and scheduler mutation checks ownership and readable config /
action storage before effects; optional dashboard paths use these same guards.
Legacy config reads also fail closed while opted in. Invalid, unreadable or
symlink setup is an error, and removing setup while an owner or journal remains
does not restore legacy writes. The pure control GET routes create no files.

One process shares its cached claim across route bundles, but verifies the
on-disk random token and file identity every time. Missing/replaced claims are
errors, never implicit reacquisition. Explicit release is for a quiescent backend;
normal process exit releases its own claim. Abrupt termination leaves a stale
claim. Recovery probes its PID with signal zero, rechecks the claim under a
recovery gate, and reclaims only `ESRCH` (confirmed absent). Every live PID,
including a reused PID, is refused. The backend never kills the recorded process.
Malformed claims, unknown liveness and an abandoned recovery gate fail closed;
offline owner inspection is required rather than guessing which files to remove.

`.poster-actions.json` is a strict version-1 journal with immutable payload
digests, request keys, private account bindings, action revisions and retained
terminal records including post/schedule IDs. An initialization marker is flushed
before the first action, so a missing initialized journal is corruption across
restart. Reads never repair, expire or initialize records. Writes use mode 0600,
file flush, atomic rename and directory flush; existing config uses the same
replacement sequence while control is enabled. Unsupported flush or any IO
failure is surfaced, without a weaker durability fallback. A failure after rename
can leave complete new bytes visible; callers reread on retry and never infer
rollback. Temporary leftovers grant no execution or replay authority. Corruption
and unreadable state cannot be replaced with default-empty configuration/queue
data. This protects cooperating local backends on the same filesystem; it is
not a transaction with a provider or a sandbox against the operating-system owner.

Readers and durable writers share a 64 MiB JSON ceiling. Writers count the exact
serialized UTF-8 bytes, including the trailing newline, before opening a temporary
file or replacing prior state. The next action journal is checked before first
initialization writes as well. Oversized output returns `storage_unavailable`,
preserves the previous readable records/configuration, and never prunes history
to fit. Focused tests inject smaller limits into the same reader/writer paths.

`scheduled` and `rescheduled` mean accepted future work, not final publication.
Persistence supports `prepared → approved → executing → scheduled/rescheduled`,
then `executing` with per-target dispatch/result updates and a final outcome under
the same action identity. The accepted schedule remains authorized after the
preparation deadline; reaching its saved time does not require a new preparation.
Payload, request key, account bindings and saved times stay immutable, and an
assigned schedule/post ID cannot be replaced. Final outcomes cannot transition
back to execution. These are internal persistence rules; approval authority,
queue acceptance and dispatch remain separate use cases.

### Legacy operation without control setup

- Configuration uses synchronous, direct reads and writes of
  `poster.config.local.json`. Each ordinary read/modify/write completes without
  an asynchronous gap in one process. There is no lock, atomic rename,
  transaction or protection against other processes, reentrant updates or
  external editors overwriting changes. A failed write can leave a partial file.
- Missing configuration and caught read/parse/normalization failures return
  defaults without rewriting the file. The existence check remains outside that
  catch. Writes normalize the known sections, propagate failures and do not
  create a missing data root. Unknown persisted keys are discarded on a write,
  as before. A missing schedule update performs no write; callback errors escape.
- Media upload creates the directory, writes bytes and then writes JSON metadata.
  These are separate operations without rollback. A failure can leave bytes or
  incomplete metadata. Upload/lookup/open failures propagate; failures while
  reading image dimensions only omit the dimensions. Read-stream errors can
  arrive while a caller consumes the returned stream.
- Single-item deletion suppresses both unlink failures and returns true if
  either the bytes or metadata were removed. Invalid IDs therefore yield false
  on deletion while lookup rejects them. Delete-all treats a listing failure as
  an empty directory, propagates removal failures and counts top-level entries.
  Stats skip failed listings/stats and count regular files recursively, including
  metadata. These operations can observe partially completed uploads/deletions.

`tests/app/storage-adapters.test.ts` exercises the same relevant store operations
with serialized memory adapters and disposable filesystem adapters.
`storage-facades.test.ts` records production wiring, layout and error behavior;
its initial cases passed before IO extraction. None of these boundaries adds
migrations, retries or stronger consistency guarantees.
