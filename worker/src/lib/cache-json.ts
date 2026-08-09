export interface CachedJsonRow {
  value: string;
  updatedAt: number;
}

interface JsonDecodeOk<T> {
  ok: true;
  reason: null;
  payload: T;
  updatedAt: number | null;
}

interface JsonDecodeError<T, R extends string> {
  ok: false;
  reason: R;
  payload: T | null;
  updatedAt: number | null;
}

export type JsonDecodeResult<T, R extends string> =
  | JsonDecodeOk<T>
  | JsonDecodeError<T, R>;

type JsonNormalizerResult<T, R extends string> =
  | { ok: true; payload: T }
  | { ok: false; reason: R; payload?: T | null };

interface DecodeJsonStringOptions<T, R extends string> {
  updatedAt?: number | null;
  missingReason?: R;
  parseErrorReason: R;
  normalize: (parsed: unknown) => JsonNormalizerResult<T, R>;
}

function finalizeJsonDecode<T, R extends string>(
  updatedAt: number | null,
  result: JsonNormalizerResult<T, R>,
): JsonDecodeResult<T, R> {
  if (result.ok) {
    return {
      ok: true,
      reason: null,
      payload: result.payload,
      updatedAt,
    };
  }
  return {
    ok: false,
    reason: result.reason,
    payload: result.payload ?? null,
    updatedAt,
  };
}

export function decodeJsonString<T, R extends string>(
  value: string | null | undefined,
  options: DecodeJsonStringOptions<T, R>,
): JsonDecodeResult<T, R> {
  const updatedAt = options.updatedAt ?? null;
  if (value == null) {
    if (options.missingReason == null) {
      throw new Error("decodeJsonString requires missingReason when value may be absent");
    }
    return {
      ok: false,
      reason: options.missingReason,
      payload: null,
      updatedAt,
    };
  }

  try {
    return finalizeJsonDecode(updatedAt, options.normalize(JSON.parse(value)));
  } catch {
    return {
      ok: false,
      reason: options.parseErrorReason,
      payload: null,
      updatedAt,
    };
  }
}

interface DecodeCachedJsonOptions<T, R extends string> {
  missingReason: R;
  parseErrorReason: R;
  normalize: (parsed: unknown) => JsonNormalizerResult<T, R>;
}

export function decodeCachedJson<T, R extends string>(
  cached: CachedJsonRow | null,
  options: DecodeCachedJsonOptions<T, R>,
): JsonDecodeResult<T, R> {
  return decodeJsonString(cached?.value, {
    updatedAt: cached?.updatedAt ?? null,
    missingReason: options.missingReason,
    parseErrorReason: options.parseErrorReason,
    normalize: options.normalize,
  });
}
