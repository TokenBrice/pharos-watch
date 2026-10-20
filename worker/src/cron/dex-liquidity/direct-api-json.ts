import { isRecord } from "@shared/lib/type-guards";
import { toErrorMessage } from "@shared/lib/error-utils";
import { isResponseBodyTooLargeError, readResponseTextWithinLimitWithSignal } from "../../lib/response-body";
import { parseJson } from "../../lib/json-parse";
export type DexApiJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export { isRecord as isDexApiRecord } from "@shared/lib/type-guards";

/** Reject numeric prefixes, empty values and non-decimal encodings from provider scalars. */
export function parseStrictFiniteDecimal(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const unsigned = normalized[0] === "+" || normalized[0] === "-" ? normalized.slice(1) : normalized;
  if (!unsigned || ["0x", "0o", "0b"].includes(unsigned.slice(0, 2).toLowerCase())) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads one direct-API page body under an explicit byte cap.
 *
 * The cap is enforced while streaming and against the declared
 * `Content-Length`, so a mis-served body (HTML error page, doubled payload) is
 * cancelled instead of being buffered and parsed inside the isolate. An
 * over-cap page returns the source's machine-readable error and never a
 * partially parsed page: pagination stops on it exactly like an HTTP failure.
 */
export async function readDexApiJson<T>(
  response: Response,
  context: string,
  maxBytes: number,
): Promise<DexApiJsonResult<T>> {
  let text: string;
  try {
    text = await readResponseTextWithinLimitWithSignal(response, maxBytes);
  } catch (error) {
    if (isResponseBodyTooLargeError(error)) {
      return { ok: false, error: `${context} response body exceeded ${maxBytes} bytes` };
    }
    const message = toErrorMessage(error);
    return { ok: false, error: `${context} returned invalid JSON: ${message}` };
  }

  const parsed = parseJson(text);
  if (!parsed.ok) {
    return { ok: false, error: `${context} returned invalid JSON: ${parsed.message}` };
  }
  if (!isRecord(parsed.value)) {
    return { ok: false, error: `${context} returned non-object JSON root` };
  }

  return { ok: true, data: parsed.value as T };
}
