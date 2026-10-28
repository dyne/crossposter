import "server-only";
import type { ScheduledTickState } from "./service";

export type SchedulerState = ScheduledTickState & {
  timer?: ReturnType<typeof setInterval>;
};

type SchedulerGlobal = typeof globalThis & { __crossposterScheduler?: SchedulerState };

export function schedulerState(): SchedulerState {
  const state = globalThis as SchedulerGlobal;
  state.__crossposterScheduler ||= { running: false };
  return state.__crossposterScheduler;
}

export function startSchedulerTimer(
  state: SchedulerState,
  tick: (requestUrl: string) => Promise<unknown>,
  requestUrl: string
): void {
  if (state.timer) return;

  state.timer = setInterval(() => {
    void tick(requestUrl).catch(() => undefined);
  }, 30_000);
  state.timer.unref?.();
}

// Stop future ticks without releasing the guard of an in-flight publish.
export function stopSchedulerTimer(state: SchedulerState): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}
