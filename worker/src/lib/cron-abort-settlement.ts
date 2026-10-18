export const CRON_ABORT_GRACE_MS = 1_000;
export const CRON_ABORT_OBSERVATION_MARGIN_MS = 250;
export type AbortSettlement<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "aborted"; reason: unknown; settled: boolean; error?: unknown };
export interface AbortSettlementOptions {
  observer?: boolean;
  platformDeadlineMs?: number;
}

/** Abort is final even if work fulfills during drain; late rejection is always observed. */
export async function settleAfterAbort<T>(
  start: () => Promise<T>, signal: AbortSignal, options: AbortSettlementOptions = {},
): Promise<AbortSettlement<T>> {
  if (signal.aborted) return { status: "aborted", reason: signal.reason, settled: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notifyAbort!: () => void;
  const aborted = new Promise<{ status: "abort" }>((resolve) => {
    notifyAbort = () => resolve({ status: "abort" });
    signal.addEventListener("abort", notifyAbort, { once: true });
  });
  const work = Promise.resolve().then(() => {
    if (signal.aborted) throw signal.reason;
    return start();
  }).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  try {
    const first = await Promise.race([work, aborted]);
    if (first.status !== "abort" && !signal.aborted) return first;
    const graceMs = Math.max(0, Math.min(
      CRON_ABORT_GRACE_MS + (options.observer ? CRON_ABORT_OBSERVATION_MARGIN_MS : 0),
      options.platformDeadlineMs == null ? Infinity : options.platformDeadlineMs - Date.now(),
    ));
    const drained = await Promise.race([
      work,
      graceMs <= 0 ? Promise.resolve({ status: "unsettled" as const })
        : new Promise<{ status: "unsettled" }>((resolve) => {
          timer = setTimeout(() => resolve({ status: "unsettled" }), graceMs);
        }),
    ]);
    return {
      status: "aborted", reason: signal.reason, settled: drained.status !== "unsettled",
      ...(drained.status === "rejected" ? { error: drained.error } : {}),
    };
  } finally {
    signal.removeEventListener("abort", notifyAbort);
    clearTimeout(timer);
  }
}

/** Retain already-started accounting work without reusing its aborted signal. */
export async function retainUntilDeadline(work: Promise<unknown>, deadlineMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadlineMs - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
