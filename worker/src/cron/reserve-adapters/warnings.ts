import type { LiveReserveWarning } from "@shared/types/live-reserves";

export function reserveInfoWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "info", effect: "info" };
}

export function reserveDegradedWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "warning", effect: "degraded" };
}

export function reserveFatalWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "warning", effect: "fatal" };
}

/** Await a fetch/parse promise; on rejection, push an info warning that includes
 *  the underlying error message and return `null`. Use this instead of silent
 *  `.catch(() => null)` so operators see what actually failed. */
export async function catchAndWarn<T>(
  promise: Promise<T>,
  code: string,
  label: string,
  warnings: LiveReserveWarning[],
): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    warnings.push(reserveInfoWarning(
      code,
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return null;
  }
}
