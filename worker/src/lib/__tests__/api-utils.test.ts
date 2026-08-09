import { beforeEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  encodeJsonCursor,
  errorResponse,
  fetchPaginatedEvents,
  handleStablecoinHistoryRequest,
  methodNotAllowedResponse,
  noStoreResponse,
  parseBooleanInput,
  parseBooleanParam,
  parseClampedIntegerParam,
  parseDayStartParam,
  parseFloatParam,
  parseIntParam,
  parseJsonCursorParam,
  parseOptionalNonNegativeIntegerParam,
  parseOptionalEnumParam,
  parseOptionalPositiveIntegerParam,
  parseOptionalRequestJsonObject,
  parseEnumParam,
  parseRequestJsonWithSchema,
  parseRequiredStablecoinIdParam,
  parseQueryParams,
  parseStablecoinHistoryQuery,
  parseTimestampSecondsParam,
  readBodyOrQueryParam,
  readBodyOrQueryStringParam,
  cacheControlForDegradedPayload,
  respondWithFreshSnapshot,
  jsonResponse,
  jsonResponseWithHeaders,
  jsonFreshResponse,
  validatePayloadWithSchema,
  buildCacheStatuses,
  getCacheJsonParseFailureCountersForTests,
  readCachedJson,
  resetCacheJsonParseFailureCountersForTests,
  safeJsonParse,
  withResponseHeaders,
} from "../api-utils";

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

describe("readCachedJson", () => {
  beforeEach(() => {
    resetCacheJsonParseFailureCountersForTests();
    vi.restoreAllMocks();
  });

  it("returns missing when the cache row is absent", () => {
    expect(readCachedJson("status", "stablecoins", null)).toEqual({ status: "missing" });
  });

  it("returns parsed data for valid cached json", () => {
    expect(readCachedJson<{ ok: boolean }>("status", "stablecoins", {
      value: JSON.stringify({ ok: true }),
    })).toEqual({
      status: "ok",
      data: { ok: true },
    });
  });

  it("returns malformed when the cached json is invalid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = readCachedJson("status", "stablecoins", { value: "{bad-json" });
    expect(result.status).toBe("malformed");
    if (result.status === "malformed") {
      expect(result.message).toMatch(/Unexpected|JSON|Expected/i);
    }
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cache] Failed to parse persisted JSON (status:stablecoins); count=1:"),
      expect.any(String),
    );
    expect(getCacheJsonParseFailureCountersForTests()["status:stablecoins"]?.count).toBe(1);
  });

  it("logs and counts safe JSON parse fallback failures", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(safeJsonParse("{bad-json", { fallback: true }, "daily-digest:input")).toEqual({ fallback: true });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[cache] Failed to parse persisted JSON (daily-digest:input); count=1:"),
      expect.any(String),
    );
    expect(getCacheJsonParseFailureCountersForTests()["daily-digest:input"]?.count).toBe(1);
  });
});

describe("boolean and mixed-source query helpers", () => {
  it("parses boolean query params with defaults", async () => {
    expect(parseBooleanParam(null, "dryRun", true)).toBe(true);
    expect(parseBooleanParam("", "dryRun", false)).toBe(false);
    expect(parseBooleanParam("true", "dryRun", false)).toBe(true);
    expect(parseBooleanParam("1", "dryRun", false)).toBe(true);
    expect(parseBooleanParam("false", "dryRun", true)).toBe(false);
    expect(parseBooleanParam("0", "dryRun", true)).toBe(false);

    const invalid = parseBooleanParam("yes", "dryRun", false);
    expect(invalid).toBeInstanceOf(Response);
    if (invalid instanceof Response) {
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({ error: "Invalid dryRun: must be true or false" });
    }
  });

  it("normalizes loose boolean inputs with fallback values", () => {
    expect(parseBooleanInput(true, false)).toBe(true);
    expect(parseBooleanInput(false, true)).toBe(false);
    expect(parseBooleanInput(" TRUE ", false)).toBe(true);
    expect(parseBooleanInput("false", true)).toBe(false);
    expect(parseBooleanInput("yes", true)).toBe(true);
    expect(parseBooleanInput(1, false)).toBe(false);
  });

  it("reads params from body first and query fallback second", () => {
    const params = new URLSearchParams("limit=20&mode=query&blank=   ");
    expect(readBodyOrQueryParam({ limit: 10 }, params, "limit")).toBe(10);
    expect(readBodyOrQueryParam({}, params, "limit")).toBe("20");
    expect(readBodyOrQueryStringParam({ mode: " body " }, params, "mode")).toBe("body");
    expect(readBodyOrQueryStringParam({ mode: 42 }, params, "mode")).toBe("query");
    expect(readBodyOrQueryStringParam({}, params, "blank")).toBeNull();
  });
});

describe("JSON cursor helpers", () => {
  it("round-trips unicode cursor payloads through URL-safe base64", () => {
    const cursor = encodeJsonCursor({ stablecoin: "eurc-circle", marker: "é", offset: 2 });

    expect(cursor).not.toMatch(/[+/=]/);
    expect(parseJsonCursorParam(cursor, (payload) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "stablecoin" in payload &&
        "marker" in payload &&
        "offset" in payload
      ) {
        return payload as { stablecoin: string; marker: string; offset: number };
      }
      return null;
    })).toEqual({ stablecoin: "eurc-circle", marker: "é", offset: 2 });
  });

  it("returns null for missing cursors", () => {
    expect(parseJsonCursorParam(null, () => "unused")).toBeNull();
    expect(parseJsonCursorParam("", () => "unused")).toBeNull();
  });

  it("rejects malformed, invalid, and throwing cursor validators", async () => {
    const malformed = parseJsonCursorParam("not-base64", () => "unused", "Bad cursor");
    expect(malformed).toBeInstanceOf(Response);
    if (malformed instanceof Response) {
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toEqual({ error: "Bad cursor" });
    }

    const invalidShape = parseJsonCursorParam(encodeJsonCursor({ ok: false }), () => null, "Bad cursor");
    expect(invalidShape).toBeInstanceOf(Response);
    if (invalidShape instanceof Response) {
      expect(invalidShape.status).toBe(400);
      await expect(invalidShape.json()).resolves.toEqual({ error: "Bad cursor" });
    }

    const throwingValidator = parseJsonCursorParam(encodeJsonCursor({ ok: true }), () => {
      throw new Error("validator failed");
    }, "Bad cursor");
    expect(throwingValidator).toBeInstanceOf(Response);
    if (throwingValidator instanceof Response) {
      expect(throwingValidator.status).toBe(400);
      await expect(throwingValidator.json()).resolves.toEqual({ error: "Bad cursor" });
    }
  });
});

describe("parseIntParam", () => {
  it.each([
    { label: "returns the default for null input", raw: null, fallback: 100, min: 1, max: 1000, expected: 100 },
    { label: "returns the default for undefined input", raw: undefined, fallback: 50, min: 1, max: 500, expected: 50 },
    { label: "parses a valid integer", raw: "25", fallback: 100, min: 1, max: 1000, expected: 25 },
    { label: "clamps below min", raw: "-5", fallback: 100, min: 0, max: 1000, expected: 0 },
    { label: "clamps above max", raw: "9999", fallback: 100, min: 1, max: 500, expected: 500 },
  ])("$label", ({ raw, fallback, min, max, expected }) => {
    expect(parseIntParam(raw, fallback, min, max)).toBe(expected);
  });

  it.each([
    {
      label: "rejects out-of-range integers when rangePolicy is reject",
      raw: "9999",
      max: 500,
      name: "limit",
      options: { rangePolicy: "reject" } as const,
      error: "Invalid limit: must be between 1 and 500",
    },
    {
      label: "returns 400 for malformed input",
      raw: "abc",
      max: 1000,
      name: "limit",
      options: undefined,
      error: "Invalid limit: must be a number",
    },
    {
      label: "returns 400 for an empty string",
      raw: "",
      max: 1000,
      name: "offset",
      options: undefined,
      error: "Invalid offset: must be a number",
    },
    {
      label: "returns 400 for non-finite integer input",
      raw: "9".repeat(400),
      max: 1000,
      name: "limit",
      options: undefined,
      error: "Invalid limit: must be a number",
    },
  ])("$label", async ({ raw, max, name, options, error }) => {
    const result = parseIntParam(raw, 100, 1, max, name, options);
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  });
});

describe("integer query helpers", () => {
  it("defaults malformed clamped integer params and clamps out-of-range values", () => {
    expect(parseClampedIntegerParam("abc", 50, 1, 200)).toBe(50);
    expect(parseClampedIntegerParam("0x10", 50, 1, 200)).toBe(50);
    expect(parseClampedIntegerParam("1e3", 50, 1, 200)).toBe(50);
    expect(parseClampedIntegerParam("   ", 50, 1, 200)).toBe(50);
    expect(parseClampedIntegerParam("999", 50, 1, 200)).toBe(200);
    expect(parseClampedIntegerParam("0", 50, 1, 200)).toBe(1);
    expect(parseClampedIntegerParam(" 25 ", 50, 1, 200)).toBe(25);
  });

  it("can preserve zero-as-default behavior for legacy clamped params", () => {
    expect(parseClampedIntegerParam("0", 1825, 30, 1825, { zeroAsDefault: true })).toBe(1825);
  });

  it("parses optional non-negative integer params and defaults missing values", () => {
    expect(parseOptionalNonNegativeIntegerParam("0", 90)).toBe(0);
    expect(parseOptionalNonNegativeIntegerParam(null, 90)).toBe(90);
    expect(parseOptionalNonNegativeIntegerParam("   ", 90)).toBe(90);
  });

  it.each(["-1", "0foo", "9".repeat(400)])("rejects malformed optional non-negative integer param %s", async (value) => {
    const result = parseOptionalNonNegativeIntegerParam(value, 90, "since");
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(400);
      await expect(result.json()).resolves.toEqual({ error: "Invalid since: must be a non-negative integer" });
    }
  });

  it("returns null for missing or blank optional positive integer params", () => {
    expect(parseOptionalPositiveIntegerParam(null, "limit")).toBeNull();
    expect(parseOptionalPositiveIntegerParam("   ", "limit")).toBeNull();
  });

  it("parses and caps optional positive integer params", () => {
    expect(parseOptionalPositiveIntegerParam("25", "limit")).toBe(25);
    expect(parseOptionalPositiveIntegerParam("500", "limit", { max: 200 })).toBe(200);
  });

  it("rejects malformed optional positive integer params", async () => {
    const result = parseOptionalPositiveIntegerParam("25abc", "limit");
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(400);
      await expect(result.json()).resolves.toEqual({ error: "Invalid limit: must be a positive integer" });
    }
  });

  it.each(["0", "9".repeat(400)])("rejects invalid optional positive integer param %s", async (value) => {
    const result = parseOptionalPositiveIntegerParam(value, "limit");
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(400);
      await expect(result.json()).resolves.toEqual({ error: "Invalid limit: must be a positive integer" });
    }
  });
});

describe("parseFloatParam", () => {
  it("returns default for null input", () => {
    expect(parseFloatParam(null, 1.5, 0, 10)).toBe(1.5);
  });

  it("parses valid floats", () => {
    expect(parseFloatParam("25.75", 0, 0, 100, "minAmount")).toBe(25.75);
  });

  it("returns 400 for malformed float input", async () => {
    const result = parseFloatParam("oops", 0, 0, 100, "minAmount");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid minAmount: must be a number" });
  });

  it("rejects out-of-range floats when rangePolicy is reject", async () => {
    const result = parseFloatParam("100.5", 0, 0, 100, "minAmount", { rangePolicy: "reject" });
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid minAmount: must be between 0 and 100" });
  });

  it("returns 400 for non-finite float input", async () => {
    const result = parseFloatParam(`${"9".repeat(400)}.5`, 0, 0, 100, "minAmount");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid minAmount: must be a number" });
  });
});

describe("parseQueryParams", () => {
  it("parses multiple params into an object", () => {
    const params = new URLSearchParams("limit=25&offset=10");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200 },
      offset: { type: "int", default: 0, min: 0, max: 10000 },
    });
    expect(result).toEqual({ limit: 25, offset: 10 });
  });

  it("returns 400 Response for invalid param", () => {
    const params = new URLSearchParams("limit=abc");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200 },
    });
    expect(result).toBeInstanceOf(Response);
  });

  it("uses defaults for missing params", () => {
    const params = new URLSearchParams("");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200 },
      offset: { type: "int", default: 0, min: 0, max: 10000 },
    });
    expect(result).toEqual({ limit: 50, offset: 0 });
  });

  it("supports float params", () => {
    const params = new URLSearchParams("threshold=0.5");
    const result = parseQueryParams(params, {
      threshold: { type: "float", default: 1.0, min: 0, max: 10 },
    });
    expect(result).toEqual({ threshold: 0.5 });
  });

  it("rejects out-of-range values when a spec opts into reject mode", async () => {
    const params = new URLSearchParams("limit=250");
    const result = parseQueryParams(params, {
      limit: { type: "int", default: 50, min: 1, max: 200, rangePolicy: "reject" },
    });
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid limit: must be between 1 and 200" });
  });
});

describe("parseOptionalEnumParam", () => {
  const validModes = new Set(["strict", "relaxed"] as const);

  it("returns null for missing or blank values", () => {
    expect(parseOptionalEnumParam(null, validModes, "mode")).toBeNull();
    expect(parseOptionalEnumParam(undefined, validModes, "mode")).toBeNull();
    expect(parseOptionalEnumParam("   ", validModes, "mode")).toBeNull();
  });

  it("returns the trimmed enum value when valid", () => {
    expect(parseOptionalEnumParam(" strict ", validModes, "mode")).toBe("strict");
  });

  it("returns a 400 response for invalid values", async () => {
    const result = parseOptionalEnumParam("legacy", validModes, "mode");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid mode parameter" });
  });
});

describe("parseOptionalRequestJsonObject", () => {
  it("returns an empty object when no request is provided", async () => {
    await expect(parseOptionalRequestJsonObject()).resolves.toEqual({});
  });

  it("returns an empty object for empty post bodies", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    await expect(parseOptionalRequestJsonObject(request)).resolves.toEqual({});
  });

  it("returns the parsed object for valid JSON objects", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, limit: 10 }),
    });

    await expect(parseOptionalRequestJsonObject(request)).resolves.toEqual({ dryRun: true, limit: 10 });
  });

  it("returns 400 for malformed json", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const response = await parseOptionalRequestJsonObject(request);
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("returns 400 for non-object json", async () => {
    const request = new Request("https://api.pharos.watch/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["not-an-object"]),
    });

    const response = await parseOptionalRequestJsonObject(request);
    expect(response).toBeInstanceOf(Response);
    await expect((response as Response).json()).resolves.toEqual({ error: "Invalid JSON body" });
  });
});

describe("parseRequestJsonWithSchema", () => {
  const schema = z.object({ ok: z.boolean() });

  it("returns parsed schema data for valid JSON", async () => {
    const request = new Request("https://api.pharos.watch/api/test", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });

    await expect(parseRequestJsonWithSchema(request, schema)).resolves.toEqual({ ok: true });
  });

  it("returns configured schema errors", async () => {
    const request = new Request("https://api.pharos.watch/api/test", {
      method: "POST",
      body: JSON.stringify({ ok: "yes" }),
    });

    const response = await parseRequestJsonWithSchema(request, schema, {
      formatSchemaError: () => "Custom schema error",
      responseOptions: { noStore: true },
    });
    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "Custom schema error" });
    }
  });

  it("returns invalid JSON errors before schema validation", async () => {
    const request = new Request("https://api.pharos.watch/api/test", {
      method: "POST",
      body: "{",
    });

    const response = await parseRequestJsonWithSchema(request, schema);
    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    }
  });
});

describe("timestamp and day query parsers", () => {
  it("parses Unix seconds, milliseconds, and ISO timestamps to seconds", () => {
    expect(parseTimestampSecondsParam("1735689600")).toBe(1_735_689_600);
    expect(parseTimestampSecondsParam("1735689600000")).toBe(1_735_689_600);
    expect(parseTimestampSecondsParam("2025-01-01T00:00:00Z")).toBe(1_735_689_600);
  });

  it("returns null for missing or malformed timestamps", () => {
    expect(parseTimestampSecondsParam(null)).toBeNull();
    expect(parseTimestampSecondsParam("  ")).toBeNull();
    expect(parseTimestampSecondsParam("not-a-time")).toBeNull();
  });

  it("normalizes date-like values to UTC day starts", () => {
    expect(parseDayStartParam("2025-01-01T12:34:56Z")).toBe(1_735_689_600);
    expect(parseDayStartParam("1735734896000")).toBe(1_735_689_600);
  });
});

describe("parseEnumParam", () => {
  const validModes = new Set(["strict", "relaxed"] as const);

  it("returns the default when the value is missing", () => {
    expect(parseEnumParam(null, validModes, "mode", "strict")).toBe("strict");
  });

  it("returns the parsed enum value when valid", () => {
    expect(parseEnumParam("relaxed", validModes, "mode", "strict")).toBe("relaxed");
  });

  it("returns a 400 response for invalid values", async () => {
    const result = parseEnumParam("legacy", validModes, "mode", "strict");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid mode parameter" });
  });
});

describe("parseRequiredStablecoinIdParam", () => {
  it("returns a 400 response when the parameter is missing", async () => {
    const result = parseRequiredStablecoinIdParam(new URLSearchParams(""), "stablecoin");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing required parameter: stablecoin" });
  });

  it("returns a 404 response when the stablecoin is unknown", async () => {
    const result = parseRequiredStablecoinIdParam(
      new URLSearchParams("stablecoin=not-a-stablecoin"),
      "stablecoin",
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown stablecoin" });
  });

  it("returns the canonical stablecoin id when the parameter is valid", () => {
    expect(parseRequiredStablecoinIdParam(new URLSearchParams("stablecoin=usdt-tether"), "stablecoin")).toBe(
      "usdt-tether",
    );
  });
});

describe("parseStablecoinHistoryQuery", () => {
  it("returns 400 with stable message when stablecoin is missing", async () => {
    const result = parseStablecoinHistoryQuery(
      new URL("https://x/api/supply-history"),
      { defaultDays: 365, minDays: 1, maxDays: 1825 },
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing ?stablecoin= parameter" });
  });

  it("returns 404 with stable message when stablecoin ID is unknown", async () => {
    const result = parseStablecoinHistoryQuery(
      new URL("https://x/api/supply-history?stablecoin=DROP TABLE"),
      { defaultDays: 365, minDays: 1, maxDays: 1825 },
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown stablecoin" });
  });

  it("applies endpoint-specific defaults and keeps legacy clamp behavior unless reject mode is requested", () => {
    const bounded = parseStablecoinHistoryQuery(
      new URL("https://x/api/supply-history?stablecoin=usdt-tether&days=9999"),
      { defaultDays: 365, minDays: 1, maxDays: 1825 },
    );
    if (bounded instanceof Response) {
      throw new Error("expected parsed query");
    }
    expect(bounded.days).toBe(1825);

    const withDefault = parseStablecoinHistoryQuery(
      new URL("https://x/api/yield-history?stablecoin=usdt-tether"),
      { defaultDays: 90, minDays: 1, maxDays: 365 },
    );
    if (withDefault instanceof Response) {
      throw new Error("expected parsed query");
    }
    expect(withDefault.days).toBe(90);
  });

  it("rejects out-of-range days when a public endpoint opts into reject mode", async () => {
    const result = parseStablecoinHistoryQuery(
      new URL("https://x/api/yield-history?stablecoin=usdt-tether&days=9999"),
      { defaultDays: 90, minDays: 1, maxDays: 365, rangePolicy: "reject" },
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid days: must be between 1 and 365" });
  });

  it("returns 400 when days is malformed", async () => {
    const result = parseStablecoinHistoryQuery(
      new URL("https://x/api/yield-history?stablecoin=usdt-tether&days=abc"),
      { defaultDays: 90, minDays: 1, maxDays: 365 },
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid days: must be a number" });
  });
});

describe("handleStablecoinHistoryRequest", () => {
  it("returns mapped history with cache and extra headers when freshness is omitted", async () => {
    const db = {} as D1Database;
    const fetchRows = vi.fn(async () => [
      { timestamp: 100, value: 1.25 },
      { timestamp: 200, value: 1.5 },
    ]);

    const response = await handleStablecoinHistoryRequest(
      db,
      new URL("https://x/api/yield-history?stablecoin=usdt-tether&days=30"),
      {
        query: { defaultDays: 90, minDays: 1, maxDays: 365, rangePolicy: "reject" },
        cacheControl: "public, max-age=300",
        fetchRows,
        mapRow: (row) => ({ at: row.timestamp, value: row.value }),
        buildHeaders: ({ stablecoinId, history }) => ({
          "X-Stablecoin-Id": stablecoinId,
          "X-History-Count": String(history.length),
        }),
      },
    );

    expect(fetchRows).toHaveBeenCalledWith(expect.objectContaining({
      db,
      stablecoinId: "usdt-tether",
      cutoff: expect.any(Number),
    }));
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("X-Stablecoin-Id")).toBe("usdt-tether");
    expect(response.headers.get("X-History-Count")).toBe("2");
    expect(await response.json()).toEqual([
      { at: 100, value: 1.25 },
      { at: 200, value: 1.5 },
    ]);
  });

  it("adds freshness headers when the handler supplies updatedAt metadata", async () => {
    const nowSec = 1_765_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000);

    try {
      const response = await handleStablecoinHistoryRequest(
        {} as D1Database,
        new URL("https://x/api/supply-history?stablecoin=usdt-tether&days=7"),
        {
          query: { defaultDays: 365, minDays: 1, maxDays: 1825, rangePolicy: "reject" },
          cacheControl: "public, max-age=60",
          fetchRows: async () => [{ timestamp: nowSec - 5, value: 100 }],
          mapRow: (row) => row,
          freshness: ({ stablecoinId, cutoff, rows, history }) => {
            expect(stablecoinId).toBe("usdt-tether");
            expect(cutoff).toBe(nowSec - 7 * 86_400);
            expect(rows).toEqual([{ timestamp: nowSec - 5, value: 100 }]);
            expect(history).toEqual([{ timestamp: nowSec - 5, value: 100 }]);
            return {
              updatedAt: nowSec - 10,
              maxAgeSec: 60,
            };
          },
        },
      );

      expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
      expect(response.headers.get("X-Data-Age")).toBe("10");
      expect(response.headers.get("Warning")).toBeNull();
      expect(await response.json()).toEqual([{ timestamp: nowSec - 5, value: 100 }]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("fetchPaginatedEvents", () => {
  it("builds count and data queries with validated pagination inputs", async () => {
    type BoundStatement = { sql: string; binds: unknown[] };
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({ sql, binds }),
      }),
      batch: vi.fn(async (stmts: BoundStatement[]) => {
        expect(stmts).toHaveLength(2);
        expect(stmts[0]).toEqual({
          sql: "SELECT COUNT(*) as total FROM blacklist_events WHERE stablecoin_id = ?",
          binds: ["usdt-tether"],
        });
        expect(stmts[1]).toEqual({
          sql: "SELECT * FROM blacklist_events WHERE stablecoin_id = ? ORDER BY timestamp DESC, id ASC LIMIT ? OFFSET ?",
          binds: ["usdt-tether", 25, 50],
        });

        return [
          { results: [{ total: 2 }] },
          { results: [{ id: "a" }, { id: "b" }] },
        ];
      }),
    } as unknown as D1Database;

    const result = await fetchPaginatedEvents<{ id: string }, string>(db, {
      tableName: "blacklist_events",
      orderBy: "timestamp DESC, id ASC",
      conditions: ["stablecoin_id = ?"],
      filterBindings: ["usdt-tether"],
      limit: 25,
      offset: 50,
      mapRow: (row) => row.id,
    });

    expect(result).toEqual({
      total: 2,
      events: ["a", "b"],
    });
  });

  it("rejects non-allowlisted tables and malformed order clauses", async () => {
    await expect(fetchPaginatedEvents({} as D1Database, {
      tableName: "cache",
      orderBy: "timestamp DESC",
      conditions: [],
      filterBindings: [],
      limit: 10,
      offset: 0,
      mapRow: (row) => row,
    })).rejects.toThrow("Invalid table: cache");

    await expect(fetchPaginatedEvents({} as D1Database, {
      tableName: "blacklist_events",
      orderBy: "timestamp DOWN",
      conditions: [],
      filterBindings: [],
      limit: 10,
      offset: 0,
      mapRow: (row) => row,
    })).rejects.toThrow("Invalid orderBy direction: DOWN");

    await expect(fetchPaginatedEvents({} as D1Database, {
      tableName: "blacklist_events",
      orderBy: "timestamp DESC NULLS LAST",
      conditions: [],
      filterBindings: [],
      limit: 10,
      offset: 0,
      mapRow: (row) => row,
    })).rejects.toThrow("Invalid orderBy: timestamp DESC NULLS LAST");
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

  it("merges custom headers through the explicit headers form", async () => {
    const res = jsonResponseWithHeaders({ ok: true }, { "Cache-Control": "no-store" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("does not mistake a header record key for an option", async () => {
    // The retired options-sniffing signature read this record as options and
    // dropped every header while setting status 503.
    const res = jsonResponseWithHeaders({ ok: true }, { status: "503", headers: "x", noStore: "1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("status")).toBe("503");
    expect(res.headers.get("headers")).toBe("x");
    expect(res.headers.get("noStore")).toBe("1");
  });

  it("supports status, no-store, and Retry-After options", async () => {
    const res = jsonResponse({ ok: true }, {
      status: 202,
      noStore: true,
      retryAfterSec: 3,
    });

    expect(res.status).toBe(202);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("3");
  });
});

describe("response header helpers", () => {
  it("adds or replaces response headers without changing status", async () => {
    const res = withResponseHeaders(jsonResponse({ ok: true }, { status: 202, headers: { "X-Test": "old" } }), {
      "X-Test": "new",
      "X-Extra": "1",
    });

    expect(res.status).toBe(202);
    expect(res.headers.get("X-Test")).toBe("new");
    expect(res.headers.get("X-Extra")).toBe("1");
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("adds no-store only when it is missing", () => {
    const cached = jsonResponse({ ok: true });
    expect(noStoreResponse(cached).headers.get("Cache-Control")).toBe("no-store");

    const alreadyNoStore = jsonResponse({ ok: true }, { noStore: true });
    expect(noStoreResponse(alreadyNoStore)).toBe(alreadyNoStore);
  });

  it("returns 405 responses with an Allow header", async () => {
    const res = methodNotAllowedResponse("Use GET", ["GET", "HEAD"]);

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
    await expect(res.json()).resolves.toEqual({ error: "Use GET" });
  });
});

describe("jsonFreshResponse", () => {
  it("returns plain JSON when freshness metadata is not provided", async () => {
    const res = jsonFreshResponse({ ok: true }, {
      cacheControl: "public, max-age=60",
      headers: { "X-Test": "1" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("X-Test")).toBe("1");
    expect(res.headers.get("X-Data-Age")).toBeNull();
  });
});

describe("cacheControlForDegradedPayload", () => {
  it("switches degraded payloads to no-store", () => {
    expect(cacheControlForDegradedPayload({ _meta: { degraded: false } })).toBe("public, s-maxage=300, max-age=60");
    expect(cacheControlForDegradedPayload({ _meta: { degraded: true } })).toBe("no-store");
  });
});

describe("respondWithFreshSnapshot", () => {
  class SnapshotUnavailableError extends Error {}

  it("returns a freshness-decorated snapshot response", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await respondWithFreshSnapshot({
      load: async () => ({ updatedAt: nowSec - 5, value: 1 }),
      cacheControl: "public, max-age=60",
      maxAgeSec: 60,
      unavailableError: SnapshotUnavailableError,
      unavailableMessage: "Snapshot unavailable",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(Number(res.headers.get("X-Data-Age"))).toBeGreaterThanOrEqual(0);
    await expect(res.json()).resolves.toEqual({ updatedAt: nowSec - 5, value: 1 });
  });

  it("returns configured 503 responses for unavailable snapshots", async () => {
    const res = await respondWithFreshSnapshot({
      load: async () => {
        throw new SnapshotUnavailableError("missing");
      },
      cacheControl: "public, max-age=60",
      maxAgeSec: 60,
      unavailableError: SnapshotUnavailableError,
      unavailableMessage: "Snapshot unavailable",
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "Snapshot unavailable" });
  });

  it("returns 503 when a snapshot has not been populated", async () => {
    const res = await respondWithFreshSnapshot({
      load: async () => ({ updatedAt: 0 }),
      cacheControl: "public, max-age=60",
      maxAgeSec: 60,
      unavailableError: SnapshotUnavailableError,
      unavailableMessage: "Snapshot unavailable",
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "Data not yet available" });
  });

  it("rethrows unexpected snapshot loading errors", async () => {
    await expect(respondWithFreshSnapshot({
      load: async () => {
        throw new Error("boom");
      },
      cacheControl: "public, max-age=60",
      maxAgeSec: 60,
      unavailableError: SnapshotUnavailableError,
      unavailableMessage: "Snapshot unavailable",
    })).rejects.toThrow("boom");
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

describe("buildCacheStatuses", () => {
  function makeDb(nowSec: number) {
    const seenSql: string[] = [];
    const db = {
      prepare: (sql: string) => {
        seenSql.push(sql);
        const first = async <T>() => {
          if (sql.includes("FROM cache WHERE key = ?")) {
            return {
              value: JSON.stringify({
                updatedAt: nowSec - 120,
                source: "compute-dews",
                publishStatus: "published",
                coverageVersion: 2,
                expectedRowCount: 2,
                stablecoinIdsDigest: "a".repeat(64),
              }),
              updated_at: nowSec - 120,
            } as T;
          }
          if (sql.includes("MAX(updated_at)")) {
            return { age: 120 } as T;
          }
          return null as T | null;
        };
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => {
              if (sql.includes("cache WHERE key IN")) {
                return {
                  results: [{ key: "stablecoins", updated_at: nowSec - 60 }] as T[],
                  success: true,
                  meta: {},
                };
              }
              return { results: [] as T[], success: true, meta: {} };
            },
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;
    return { db, seenSql };
  }

  it("uses table timestamps for table-backed datasets and the publication pointer for DEWS", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { db, seenSql } = makeDb(nowSec);

    await buildCacheStatuses(db, nowSec);

    const dexSql = seenSql.find((s) => s.includes("dex_liquidity"));
    const yieldSql = seenSql.find((s) => s.includes("yield_data"));
    expect(dexSql).toContain("? - MAX(updated_at)");
    expect(yieldSql).toContain("? - MAX(updated_at)");
    expect(yieldSql).toContain("is_best = 1");
    expect(seenSql.some((sql) => sql.includes("FROM stress_signals"))).toBe(false);
    expect(seenSql.some((sql) => sql.includes("FROM cache WHERE key = ?"))).toBe(true);
  });

  it("uses freshness sentinels when present and skips hot-table freshness queries", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const seenSql: string[] = [];
    const db = {
      prepare: (sql: string) => {
        seenSql.push(sql);
        const first = async <T>() => null as T | null;
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => {
              if (sql.includes("cache WHERE key IN")) {
                return {
                  results: [
                    { key: "stablecoins", updated_at: nowSec - 60, value: "{}" },
                    {
                      key: "freshness:dex-liquidity",
                      updated_at: nowSec - 120,
                      value: JSON.stringify({
                        updatedAt: nowSec - 120,
                        source: "sync-dex-liquidity",
                        publishStatus: "ok",
                      }),
                    },
                    {
                      key: "freshness:yield-data",
                      updated_at: nowSec - 180,
                      value: JSON.stringify({
                        updatedAt: nowSec - 180,
                        source: "sync-yield-data",
                        publishStatus: "ok",
                      }),
                    },
                    {
                      key: "freshness:dews",
                      updated_at: nowSec - 240,
                      value: JSON.stringify({
                        updatedAt: nowSec - 240,
                        source: "compute-dews",
                        publishStatus: "ok",
                      }),
                    },
                  ] as T[],
                  success: true,
                  meta: {},
                };
              }
              return { results: [] as T[], success: true, meta: {} };
            },
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { caches, diagnostics } = await buildCacheStatuses(db, nowSec);

    expect(caches["dex-liquidity"]?.ageSeconds).toBe(120);
    expect(caches["dex-liquidity"]).toMatchObject({
      freshnessSource: "freshness-sentinel",
      producerJob: "sync-dex-liquidity",
      producerIntervalSec: 1800,
      endpointMaxAge: 3600,
      availabilityMaxAge: 43200,
    });
    expect(caches["yield-data"]?.ageSeconds).toBe(180);
    expect(caches["yield-data"]).toMatchObject({
      freshnessSource: "freshness-sentinel",
      producerJob: "sync-yield-data",
      producerIntervalSec: 3600,
      endpointMaxAge: 3600,
      availabilityMaxAge: 3600,
    });
    expect(caches.dews?.ageSeconds).toBe(240);
    expect(caches.dews).toMatchObject({
      freshnessSource: "freshness-sentinel",
      producerJob: "compute-dews",
      producerIntervalSec: 1800,
      endpointMaxAge: 1800,
      availabilityMaxAge: 1800,
    });
    expect(diagnostics).toEqual([]);
    expect(seenSql.some((sql) => sql.includes("FROM dex_liquidity"))).toBe(false);
    expect(seenSql.some((sql) => sql.includes("FROM yield_data"))).toBe(false);
    expect(seenSql.some((sql) => sql.includes("FROM stress_signals"))).toBe(false);
  });

  it("clamps negative table ages to zero without accepting a future DEWS table row", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = {
      prepare: (sql: string) => {
        const first = async <T>() => {
          if (sql.includes("MAX(updated_at)") || sql.includes("MAX(computed_at)")) {
            return { age: -30 } as T;
          }
          return null as T | null;
        };
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { caches } = await buildCacheStatuses(db, nowSec);
    expect(caches["dex-liquidity"]?.ageSeconds).toBe(0);
    expect(caches["yield-data"]?.ageSeconds).toBe(0);
    expect(caches.dews?.ageSeconds).toBeNull();
  });

  it("reports missing DEWS publication evidence instead of throwing", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = {
      prepare: (sql: string) => {
        const first = async <T>() => {
          if (sql.includes("MAX(updated_at)")) {
            return { age: 60 } as T;
          }
          return null as T | null;
        };
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { caches, failures } = await buildCacheStatuses(db, nowSec);
    expect(caches.dews?.ageSeconds).toBeNull();
    expect(failures).toEqual([
      {
        key: "dews",
        source: "table-freshness",
        message: "DEWS published generation unavailable (no-pointer): publication pointer is missing",
      },
    ]);
  });

  it("does not let producer cron timestamps replace missing DEWS publication evidence", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = {
      prepare: (sql: string) => {
        const first = async <T>() => {
          return null as T | null;
        };
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => {
              if (sql.includes("FROM cron_runs")) {
                return {
                  results: [{ job: "compute-dews", started_at: nowSec - 300 }] as T[],
                  success: true,
                  meta: {},
                };
              }
              return { results: [] as T[], success: true, meta: {} };
            },
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { caches, diagnostics, failures, warnings } = await buildCacheStatuses(db, nowSec);
    expect(caches.dews?.ageSeconds).toBeNull();
    expect(caches.dews?.warning).toBeUndefined();
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ key: "dews" }));
    expect(failures).toEqual([
      {
        key: "dews",
        source: "table-freshness",
        message: "DEWS published generation unavailable (no-pointer): publication pointer is missing",
      },
    ]);
    expect(warnings).not.toContain("dews: freshness table query failed; using cron fallback");
  });

  it("uses table fallback warnings when the cache lookup fails", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const db = {
        prepare: (sql: string) => {
          const first = async <T>() => {
            if (sql.includes("MAX(updated_at)") || sql.includes("MAX(computed_at)")) {
              return { age: 45 } as T;
            }
            return null as T | null;
          };
          return {
            bind: (..._args: unknown[]) => ({
              all: async <T>() => {
                if (sql.includes("cache WHERE key IN")) {
                  throw new Error("cache lookup failed");
                }
                if (sql.includes("FROM cron_runs")) {
                  return { results: [] as T[], success: true, meta: {} };
                }
                return { results: [] as T[], success: true, meta: {} };
              },
              first,
              run: async () => ({ success: true, meta: {} }),
            }),
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
            first,
            run: async () => ({ success: true, meta: {} }),
          };
        },
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
        dump: async () => new ArrayBuffer(0),
      } as unknown as D1Database;

      const { caches, diagnostics, failures, warnings } = await buildCacheStatuses(db, nowSec);

      expect(caches["dex-liquidity"]?.ageSeconds).toBe(45);
      expect(caches["dex-liquidity"]?.warning).toBe(
        "dex-liquidity: freshness sentinel lookup failed; using table fallback",
      );
      expect(diagnostics).toContainEqual({
        key: "dex-liquidity",
        freshnessSource: "table-fallback",
        warning: "dex-liquidity: freshness sentinel lookup failed; using table fallback",
        failureSource: "cache-table",
      });
      expect(failures).toContainEqual({
        key: "__cache__",
        source: "cache-table",
        message: "cache lookup failed",
      });
      expect(warnings).toContain("dex-liquidity: freshness sentinel lookup failed; using table fallback");
      expect(infoSpy).toHaveBeenCalledWith(
        "[api-freshness] dex-liquidity: freshness sentinel lookup failed; using table fallback",
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("uses cron fallback warnings when cache lookup fails and table freshness is unavailable", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const db = {
        prepare: (sql: string) => {
          const first = async <T>() => {
            if (sql.includes("MAX(updated_at)") || sql.includes("MAX(computed_at)")) {
              return { age: null } as T;
            }
            return null as T | null;
          };
          return {
            bind: (..._args: unknown[]) => ({
              all: async <T>() => {
                if (sql.includes("cache WHERE key IN")) {
                  throw new Error("cache lookup failed");
                }
                if (sql.includes("FROM cron_runs")) {
                  return {
                    results: [
                      { job: "sync-dex-liquidity", started_at: nowSec - 90 },
                      { job: "sync-yield-data", started_at: nowSec - 120 },
                      { job: "compute-dews", started_at: nowSec - 150 },
                    ] as T[],
                    success: true,
                    meta: {},
                  };
                }
                return { results: [] as T[], success: true, meta: {} };
              },
              first,
              run: async () => ({ success: true, meta: {} }),
            }),
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
            first,
            run: async () => ({ success: true, meta: {} }),
          };
        },
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
        dump: async () => new ArrayBuffer(0),
      } as unknown as D1Database;

      const { caches, diagnostics, failures, warnings } = await buildCacheStatuses(db, nowSec);

      expect(caches["dex-liquidity"]?.ageSeconds).toBe(90);
      expect(caches["dex-liquidity"]?.warning).toBe(
        "dex-liquidity: freshness sentinel lookup failed; using cron fallback",
      );
      expect(diagnostics).toContainEqual({
        key: "dex-liquidity",
        freshnessSource: "cron-fallback",
        warning: "dex-liquidity: freshness sentinel lookup failed; using cron fallback",
        failureSource: "cache-table",
      });
      expect(failures).toContainEqual({
        key: "__cache__",
        source: "cache-table",
        message: "cache lookup failed",
      });
      expect(warnings).toContain("dex-liquidity: freshness sentinel lookup failed; using cron fallback");
      expect(infoSpy).toHaveBeenCalledWith(
        "[api-freshness] dex-liquidity: freshness sentinel lookup failed; using cron fallback",
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("records cron fallback failures when both table and producer fallback lookups are unavailable", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = {
        prepare: (sql: string) => {
          const first = async <T>() => {
            if (sql.includes("MAX(updated_at)") || sql.includes("MAX(computed_at)")) {
              return { age: null } as T;
            }
            return null as T | null;
          };
          return {
            bind: (..._args: unknown[]) => ({
              all: async <T>() => {
                if (sql.includes("FROM cron_runs")) {
                  throw new Error("cron lookup failed");
                }
                return { results: [] as T[], success: true, meta: {} };
              },
              first,
              run: async () => ({ success: true, meta: {} }),
            }),
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
            first,
            run: async () => ({ success: true, meta: {} }),
          };
        },
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
        dump: async () => new ArrayBuffer(0),
      } as unknown as D1Database;

      const { failures } = await buildCacheStatuses(db, nowSec);

      expect(failures).toContainEqual({
        key: "dex-liquidity",
        source: "cron-fallback",
        message: "cron lookup failed",
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[api-freshness] Failed to read producer cron fallbacks",
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("uses fx-rates-meta usableSyncAt for cache freshness and keeps cadence-aware source warnings separate", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = {
      prepare: (sql: string) => {
        const first = async <T>() => {
          if (sql.includes("FROM cache WHERE key = ?")) {
            return {
              value: JSON.stringify({
                updatedAt: nowSec - 60,
                source: "compute-dews",
                publishStatus: "published",
                coverageVersion: 2,
                expectedRowCount: 2,
                stablecoinIdsDigest: "a".repeat(64),
              }),
              updated_at: nowSec - 60,
            } as T;
          }
          if (sql.includes("MAX(updated_at)")) {
            return { age: 60 } as T;
          }
          return null as T | null;
        };
        return {
          bind: (..._args: unknown[]) => ({
            all: async <T>() => {
              if (sql.includes("cache WHERE key IN")) {
                return {
                  results: [
                    { key: "stablecoins", updated_at: nowSec - 60, value: "{}" },
                    { key: "stablecoin-charts", updated_at: nowSec - 60, value: "{}" },
                    { key: "usds-status", updated_at: nowSec - 60, value: "{}" },
                    { key: "fx-rates", updated_at: nowSec - 60, value: JSON.stringify({ peggedEUR: 1.08 }) },
                    {
                      key: "fx-rates-meta",
                      updated_at: nowSec - 60,
                      value: JSON.stringify({
                        usableSyncAt: nowSec - 60,
                        mode: "cached-fallback",
                        sourceUpdatedAtByPeg: { peggedEUR: nowSec - 8 * 3600 },
                        sourceModeByPeg: { peggedEUR: "cached" },
                        sourceCadenceByPeg: { peggedEUR: "intraday" },
                        consecutiveFallbackRuns: 4,
                      }),
                    },
                    { key: "bluechip-ratings", updated_at: nowSec - 60, value: "{}" },
                  ] as T[],
                  success: true,
                  meta: {},
                };
              }
              return { results: [] as T[], success: true, meta: {} };
            },
            first,
            run: async () => ({ success: true, meta: {} }),
          }),
          all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          first,
          run: async () => ({ success: true, meta: {} }),
        };
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const { caches, statusFloor, warnings } = await buildCacheStatuses(db, nowSec);

    expect(caches["fx-rates"]?.ageSeconds).toBe(60);
    expect(caches["fx-rates"]?.mode).toBe("cached-fallback");
    expect(caches["fx-rates"]?.sourceStatus).toBe("degraded");
    expect(caches["fx-rates"]?.consecutiveFallbackRuns).toBe(4);
    expect(statusFloor).toBe("degraded");
    expect(warnings[0]).toContain("cached fallback FX rates");
  });
});
