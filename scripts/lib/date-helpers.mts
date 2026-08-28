import { isValidIsoDateOnly } from "../../shared/types/date-primitives.ts";

export function isValidDateOnly(value: unknown): boolean {
  return isValidIsoDateOnly(value);
}
