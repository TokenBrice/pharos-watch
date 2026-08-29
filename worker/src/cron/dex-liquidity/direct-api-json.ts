import { isRecord } from "@shared/lib/type-guards";
import { toErrorMessage } from "@shared/lib/error-utils";
export type DexApiJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export { isRecord as isDexApiRecord } from "@shared/lib/type-guards";

export async function readDexApiJson<T>(response: Response, context: string): Promise<DexApiJsonResult<T>> {
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    const message = toErrorMessage(error);
    return { ok: false, error: `${context} returned invalid JSON: ${message}` };
  }

  if (!isRecord(data)) {
    return { ok: false, error: `${context} returned non-object JSON root` };
  }

  return { ok: true, data: data as T };
}
