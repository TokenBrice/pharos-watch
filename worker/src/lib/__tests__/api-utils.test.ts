import { describe, it, expect } from "vitest";
import { z } from "zod";
import { errorResponse, parseIntParam, jsonResponse, validatePayloadWithSchema } from "../api-utils";

describe("errorResponse", () => {
  it("returns JSON error with given status", async () => {
    const res = errorResponse(400, "Bad request");
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ error: "Bad request" });
  });

  it("returns 503 for service unavailable", async () => {
    const res = errorResponse(503, "Data not yet available");
    expect(res.status).toBe(503);
  });
});

describe("parseIntParam", () => {
  it("returns default for null input", () => {
    expect(parseIntParam(null, 100, 1, 1000)).toBe(100);
  });

  it("returns default for undefined input", () => {
    expect(parseIntParam(undefined, 50, 1, 500)).toBe(50);
  });

  it("parses valid integer", () => {
    expect(parseIntParam("25", 100, 1, 1000)).toBe(25);
  });

  it("clamps below min", () => {
    expect(parseIntParam("-5", 100, 0, 1000)).toBe(0);
  });

  it("clamps above max", () => {
    expect(parseIntParam("9999", 100, 1, 500)).toBe(500);
  });

  it("returns default for NaN input", () => {
    expect(parseIntParam("abc", 100, 1, 1000)).toBe(100);
  });

  it("returns default for empty string", () => {
    expect(parseIntParam("", 100, 1, 1000)).toBe(100);
  });
});

describe("jsonResponse", () => {
  it("returns JSON with default headers", async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("merges custom headers", async () => {
    const res = jsonResponse({ ok: true }, { "Cache-Control": "no-store" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("validatePayloadWithSchema", () => {
  it("returns parsed data when schema matches", () => {
    const schema = z.object({ ok: z.boolean() });
    const result = validatePayloadWithSchema(schema, { ok: true }, "test");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ ok: true });
  });

  it("returns issues when schema fails", () => {
    const schema = z.object({ ok: z.boolean() });
    const result = validatePayloadWithSchema(schema, { ok: "yes" }, "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });
});
