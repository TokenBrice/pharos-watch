import { describe, expect, it } from "vitest";
import {
  encodeJsonCursor,
  parseBooleanInput,
  parseBooleanParam,
  parseClampedIntegerParam,
  parseDayStartParam,
  parseEnumParam,
  parseFloatParam,
  parseIntParam,
  parseJsonCursorParam,
  parseOptionalEnumParam,
  parseOptionalNonNegativeIntegerParam,
  parseOptionalPositiveIntegerParam,
  parseQueryParams,
  parseRequiredStablecoinIdParam,
  parseTimestampSecondsParam,
  readBodyOrQueryParam,
  readBodyOrQueryStringParam,
} from "../api-params";

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

describe("timestamp and day query parsers", () => {
  it("parses Unix seconds, milliseconds, and ISO timestamps to seconds", () => {
    expect(parseTimestampSecondsParam("1735689600")).toBe(1_735_689_600);
    expect(parseTimestampSecondsParam("1735689600000")).toBe(1_735_689_600);
    expect(parseTimestampSecondsParam("2025-01-01T00:00:00Z")).toBe(1_735_689_600);
  });

  it("keeps the worker's 10^12 unit boundary", () => {
    expect(parseTimestampSecondsParam("10000000000")).toBe(10_000_000_000);
    expect(parseTimestampSecondsParam("999999999999")).toBe(999_999_999_999);
    expect(parseTimestampSecondsParam("1000000000000")).toBe(1_000_000_000);
  });

  it("rejects signed and decimal numeric text", () => {
    expect(parseTimestampSecondsParam("-1700000000")).toBeNull();
    expect(parseTimestampSecondsParam("+1700000000")).toBeNull();
    expect(parseTimestampSecondsParam("1700000000.5")).toBeNull();
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
