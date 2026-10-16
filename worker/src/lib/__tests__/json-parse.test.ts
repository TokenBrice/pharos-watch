import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseJson,
  parseJsonObject,
  parseJsonObjectWithSchema,
  parseJsonStringArray,
  tryParseJson,
} from "../json-parse";

describe("json parse helpers", () => {
  it("parses valid JSON and preserves JSON null values", () => {
    expect(parseJson(JSON.stringify({ ok: true }))).toEqual({ ok: true, value: { ok: true } });
    expect(tryParseJson("null")).toBeNull();
  });

  it("returns fallback arrays while filtering non-string entries", () => {
    expect(parseJsonStringArray(JSON.stringify(["a", 1, "b", null]))).toEqual(["a", "b"]);
    expect(parseJsonStringArray(JSON.stringify({ not: "array" }), undefined, ["fallback"])).toEqual(["fallback"]);
    expect(parseJsonStringArray(null, undefined, ["fallback"])).toEqual(["fallback"]);
  });

  it("returns fallback objects only for object payloads", () => {
    expect(parseJsonObject<{ value: number }>(JSON.stringify({ value: 1 }))).toEqual({ value: 1 });
    expect(parseJsonObject(JSON.stringify(["not-object"]), undefined, { fallback: true })).toEqual({
      fallback: true,
    });
  });

  it("validates parsed objects with the supplied schema", () => {
    const schema = z.object({ value: z.number() });

    expect(parseJsonObjectWithSchema(JSON.stringify({ value: 1 }), schema)).toEqual({ value: 1 });
    expect(parseJsonObjectWithSchema(JSON.stringify({ value: "1" }), schema)).toBeNull();
    expect(parseJsonObjectWithSchema(JSON.stringify(["not-object"]), schema)).toBeNull();
    expect(parseJsonObjectWithSchema("{bad-json", schema)).toBeNull();
  });

});
