// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  parseArraySearchParam,
  parseBooleanSearchParam,
  parseBoundedNumberSearchParam,
  parseEnumSearchParam,
  parseStablecoinIdSearchParam,
  parseStringSearchParam,
  readJsonStorageValue,
  writeJsonStorageValue,
} from "../url-storage-codecs";

describe("URL search codecs", () => {
  it("parses enum values with optional normalization", () => {
    const values = ["A", "B"] as const;

    expect(parseEnumSearchParam("?grade=a", "grade", values, { normalize: (value) => value.toUpperCase() })).toBe("A");
    expect(parseEnumSearchParam("?grade=c", "grade", values)).toBeNull();
  });

  it("parses bounded numeric and boolean values", () => {
    expect(parseBoundedNumberSearchParam("?limit=10", "limit", { min: 1, max: 20, integer: true })).toBe(10);
    expect(parseBoundedNumberSearchParam("?limit=21", "limit", { min: 1, max: 20, fallback: 5 })).toBe(5);
    expect(parseBooleanSearchParam("?dryRun=1", "dryRun")).toBe(true);
    expect(parseBooleanSearchParam("?dryRun=nope", "dryRun", false)).toBe(false);
  });

  it("parses arrays and stablecoin IDs through caller-provided decoders", () => {
    expect(parseArraySearchParam("?coins=a,b,,c", "coins", (value) => value || null)).toEqual(["a", "b", "c"]);
    expect(parseStablecoinIdSearchParam("?coin=USDC", "coin", {
      decode: (value) => value.toLowerCase(),
      isKnownCoinId: (value) => value === "usdc",
    })).toBe("usdc");
    expect(parseStablecoinIdSearchParam("?coin=DAI", "coin", {
      isKnownCoinId: (value) => value === "usdc",
    })).toBeNull();
  });

  it("parses non-empty string params", () => {
    expect(parseStringSearchParam("?p=%20usdc:10%20", "p")).toBe("usdc:10");
    expect(parseStringSearchParam("?p=", "p", { fallback: "fallback" })).toBe("fallback");
  });
});

describe("JSON storage codecs", () => {
  it("reads and writes JSON storage values with safe fallback", () => {
    writeJsonStorageValue(window.localStorage, "codec-test", [{ id: "ok" }]);

    expect(readJsonStorageValue(
      window.localStorage,
      "codec-test",
      (value) => Array.isArray(value) ? value.length : null,
      0,
    )).toBe(1);

    window.localStorage.setItem("codec-test", "{");
    expect(readJsonStorageValue(window.localStorage, "codec-test", () => 1, 0)).toBe(0);
  });
});
