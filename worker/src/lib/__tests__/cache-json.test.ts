import { describe, expect, it } from "vitest";
import { decodeCachedJson, decodeJsonString } from "../cache-json";

describe("decodeJsonString", () => {
  it("returns parsed payload when normalize succeeds", () => {
    const result = decodeJsonString<{ value: number }, "missing" | "json-parse-failed" | "invalid-shape">(
      JSON.stringify({ value: 42 }),
      {
        updatedAt: 1_700_000_000,
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: (parsed) => {
          if (
            typeof parsed === "object"
            && parsed !== null
            && "value" in parsed
            && typeof parsed.value === "number"
          ) {
            return { ok: true, payload: { value: parsed.value } };
          }
          return { ok: false, reason: "invalid-shape" };
        },
      },
    );

    expect(result).toEqual({
      ok: true,
      reason: null,
      payload: { value: 42 },
      updatedAt: 1_700_000_000,
    });
  });

  it("returns parse-error when JSON is malformed", () => {
    const result = decodeJsonString<{ value: number }, "missing" | "json-parse-failed" | "invalid-shape">(
      "{bad-json",
      {
        updatedAt: 1_700_000_000,
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: () => ({ ok: true, payload: { value: 0 } }),
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: "json-parse-failed",
      payload: null,
      updatedAt: 1_700_000_000,
    });
  });

  it("returns missing reason when value is absent", () => {
    const result = decodeJsonString<{ value: number }, "missing" | "json-parse-failed">(
      null,
      {
        updatedAt: null,
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: () => ({ ok: true, payload: { value: 0 } }),
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: "missing",
      payload: null,
      updatedAt: null,
    });
  });

  it("returns normalize failure reason and payload when shape validation fails", () => {
    const result = decodeJsonString<{ value: number }, "missing" | "json-parse-failed" | "invalid-shape">(
      JSON.stringify({ value: "oops" }),
      {
        parseErrorReason: "json-parse-failed",
        missingReason: "missing",
        normalize: () => ({ ok: false, reason: "invalid-shape", payload: { value: 0 } }),
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: "invalid-shape",
      payload: { value: 0 },
      updatedAt: null,
    });
  });
});

describe("decodeCachedJson", () => {
  it("uses cached updatedAt when decoding cached rows", () => {
    const result = decodeCachedJson<{ value: number }, "missing" | "json-parse-failed" | "invalid-shape">(
      {
        value: JSON.stringify({ value: 7 }),
        updatedAt: 1_700_000_123,
      },
      {
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: (parsed) => {
          if (
            typeof parsed === "object"
            && parsed !== null
            && "value" in parsed
            && typeof parsed.value === "number"
          ) {
            return { ok: true, payload: { value: parsed.value } };
          }
          return { ok: false, reason: "invalid-shape" };
        },
      },
    );

    expect(result).toEqual({
      ok: true,
      reason: null,
      payload: { value: 7 },
      updatedAt: 1_700_000_123,
    });
  });
});
