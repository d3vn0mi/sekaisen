/** Real timers, kept apart from the engine's clock so a call cannot hang a tick. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // A pending call timeout never keeps the process alive.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CallTimeout extends Error {
  constructor(name: string, ms: number) {
    super(`${name} timed out after ${ms} ms`);
    this.name = "CallTimeout";
  }
}

/**
 * Settles with `call`, or rejects with a CallTimeout once `ms` pass first.
 * The call itself is not cancelled; whatever it settles with later is
 * dropped.
 */
export function withTimeout<T>(
  name: string,
  call: () => Promise<T>,
  ms: number,
  timers: Timers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = timers.setTimeout(
      () => reject(new CallTimeout(name, ms)),
      ms,
    );
    let pending: Promise<T>;
    try {
      pending = call();
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (value) => {
        timers.clearTimeout(handle);
        resolve(value);
      },
      (err: unknown) => {
        timers.clearTimeout(handle);
        reject(err);
      },
    );
  });
}
