import { isValidIsoDateOnly } from "../../shared/types/date-primitives";

export function isValidDateOnly(value: unknown): boolean {
  return isValidIsoDateOnly(value);
}
