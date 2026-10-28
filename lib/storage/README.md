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

`media-service.ts` keeps upload validation, filename/MIME handling and best-effort
image dimensions. Its media adapter handles bytes and metadata files under
`.poster-uploads`. Metadata has the existing shape and filename; lookup derives
the current path from the metadata ID and obtains the size from the actual file.
Stored paths, kinds and sizes are not treated as authoritative during lookup.

## Existing consistency and error limits

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
