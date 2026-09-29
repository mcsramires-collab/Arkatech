import { AsyncLocalStorage } from 'async_hooks';
const clock = new AsyncLocalStorage<number>();
/** Production uses wall time; isolated tests can reproduce exact date boundaries. */
export function now(): number { return clock.getStore() ?? Date.now(); }
export function withClock<T>(instant: number, action: () => T): T {
  if (!Number.isFinite(instant)) throw new Error('INVALID_CLOCK');
  return clock.run(instant, action);
}
