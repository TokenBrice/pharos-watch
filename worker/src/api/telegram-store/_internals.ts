/**
 * Module-internal helpers shared across telegram-store submodules. Not
 * re-exported from `telegram-webhook-store.ts` (the barrel) — keep these out
 * of the public surface.
 */

export function d1ChangeCount(result: D1Result<unknown>): number {
  const changes = Number(result.meta?.changes ?? 0);
  return Number.isFinite(changes) ? changes : 0;
}

export interface TelegramOperationBatchOptions {
  operationStatements?: D1PreparedStatement[];
}

export function appendTelegramOperationStatements(
  statements: D1PreparedStatement[],
  options: TelegramOperationBatchOptions | undefined,
): D1PreparedStatement[] {
  return [...statements, ...(options?.operationStatements ?? [])];
}
