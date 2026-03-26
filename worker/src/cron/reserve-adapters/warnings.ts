import type { LiveReserveWarning } from "@shared/types/live-reserves";

export function reserveInfoWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "info", effect: "info" };
}

export function reserveDegradedWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "warning", effect: "degraded" };
}
