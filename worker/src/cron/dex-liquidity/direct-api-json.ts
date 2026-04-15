export type DexApiJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function isDexApiRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export async function readDexApiJson<T>(response: Response, context: string): Promise<DexApiJsonResult<T>> {
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${context} returned invalid JSON: ${message}` };
  }

  if (!isDexApiRecord(data)) {
    return { ok: false, error: `${context} returned non-object JSON root` };
  }

  return { ok: true, data: data as T };
}
