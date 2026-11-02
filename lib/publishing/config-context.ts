import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

// Control execution supplies an exact resolved target configuration. Absence in
// this scope is intentional and must never fall back to an active/base account.
const context = new AsyncLocalStorage<Readonly<Record<string, string>>>();
export function withPublicationConfig<T>(values: Record<string, string>, run: () => T): T {
  return context.run(Object.freeze({ ...values }), run);
}
export function publicationConfig() { return context.getStore(); }
