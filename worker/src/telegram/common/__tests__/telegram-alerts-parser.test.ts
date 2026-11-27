import { describe, it, expect } from "vitest";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  resolveTicker,
  parseTargetArgs,
  parseSubscribeArgs,
  suggestClosestPreset,
  validateSubscribeArgs,
  type ParsedSubscribeArgs,
} from "../alerts-parser";

describe("resolveTicker", () => {
  it.each([
    ["resolves unique ticker", "USDC", "unique", 1, { id: "usdc-circle" }],
    ["resolves exact coin ids uniquely", "usdc-circle", "unique", 1, { symbol: "USDC" }],
    ["resolves pre-launch tickers for explicit launch subscriptions", "USDPT", "unique", 1, { id: "usdpt-western-union" }],
    ["returns ambiguous for duplicate tickers", "USDQ", "ambiguous", 2, undefined],
    ["returns not_found for unknown ticker", "ZZZZZ", "not_found", 0, undefined],
  ] as const)("%s", (_name, query, status, count, first) => {
    const result = resolveTicker(query);
    expect(result.status).toBe(status);
    expect(result.matches).toHaveLength(count);
    if (first) expect(result.matches[0]).toMatchObject(first);
  });

  it("can resolve frozen exact ids when the tracked scope is requested", () => {
    const frozen = FROZEN_STABLECOINS[0];
    expect(frozen).toBeDefined();

    const defaultResult = resolveTicker(frozen!.id);
    expect(defaultResult.status).toBe("not_found");

    const trackedResult = resolveTicker(frozen!.id, "tracked");
    expect(trackedResult.status).toBe("unique");
    expect(trackedResult.matches[0].id).toBe(frozen!.id);
  });
});

describe("parseSubscribeArgs", () => {
  it.each<[string, string, Partial<ParsedSubscribeArgs>, string?]>([
    ["separates alert types from tickers", "dews depeg USDC BOLD", { alertTypes: new Set(["dews", "depeg"]), subscribeAll: false, presetIds: [], tickers: ["USDC", "BOLD"] }],
    ["recognizes the all-stablecoin token", "dews all", { alertTypes: new Set(["dews"]), subscribeAll: true, presetIds: [], tickers: [], invalidTargets: [] }],
    ["classifies preset aliases separately from tickers", "dews usd-top25 USDC", { alertTypes: new Set(["dews"]), subscribeAll: false, presetIds: ["usd-top25"], tickers: ["USDC"], invalidTargets: [] }],
    ["accepts dashed preset aliases and canonicalizes them", "dews usd-top-25", { alertTypes: new Set(["dews"]), subscribeAll: false, presetIds: ["usd-top25"], tickers: [], invalidTargets: [] }],
    ["classifies unknown tokens as invalidTargets", "foo dews USDC", { alertTypes: new Set(["dews"]), subscribeAll: false, presetIds: [], tickers: ["USDC"], invalidTargets: ["foo"] }],
    ["parses depeg-step after preset targets and implies depeg", "usd-top-50 depeg-step 250", { alertTypes: new Set(["depeg"]), presetIds: ["usd-top50"], tickers: [], depegWorseningBpsStep: 250, invalidTargets: [] }],
    ["parses depeg-step off", "depeg-step off USDC", { alertTypes: new Set(["depeg"]), tickers: ["USDC"], depegWorseningBpsStep: null }],
    ["captures invalid depeg-step values", "usd-top-50 depeg-step 75", { alertTypes: new Set(["depeg"]), invalidDepegWorseningBpsStep: "75" }, "Depeg-step values"],
  ])("%s", (_name, input, expected, err) => {
    const result = parseSubscribeArgs(input);
    expect(result).toMatchObject(expected);
    if (err) expect(validateSubscribeArgs(result)).toContain(err);
  });
});

describe("parseTargetArgs", () => {
  it("parses tickers and presets for unsubscribe-style commands", () => {
    const result = parseTargetArgs("usd-top25 USDC");
    expect(result.includeAll).toBe(false);
    expect(result.presetIds).toEqual(["usd-top25"]);
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTargets).toEqual([]);
  });

  it("recognizes all as an exclusive target token", () => {
    const result = parseTargetArgs("all");
    expect(result.includeAll).toBe(true);
    expect(result.presetIds).toEqual([]);
    expect(result.tickers).toEqual([]);
    expect(result.invalidTargets).toEqual([]);
  });

  it("accepts frozen exact ids for tracked-scope target parsing", () => {
    const frozen = FROZEN_STABLECOINS[0];
    expect(frozen).toBeDefined();

    const defaultResult = parseTargetArgs(frozen!.id);
    expect(defaultResult.invalidTargets).toEqual([frozen!.id]);

    const trackedResult = parseTargetArgs(frozen!.id, { resolutionScope: "tracked" });
    expect(trackedResult.tickers).toEqual([frozen!.id]);
    expect(trackedResult.invalidTargets).toEqual([]);
  });
});

describe("validateSubscribeArgs", () => {
  function baseArgs(): ParsedSubscribeArgs {
    return { alertTypes: new Set(), subscribeAll: false, presetIds: [], tickers: [], invalidTargets: [] };
  }

  const rejections: ReadonlyArray<{
    name: string;
    parsed: Partial<ParsedSubscribeArgs>;
    contains: readonly string[];
    absent?: readonly string[];
  }> = [
    {
      name: "requires at least one alert type",
      parsed: { tickers: ["USDC"] },
      contains: ["alert type"],
    },
    {
      name: "requires at least one ticker or preset",
      parsed: { alertTypes: new Set(["dews"]) },
      contains: ["ticker or preset"],
    },
    {
      name: "treats unknown non-typo tokens beside a valid ticker as unknown ticker or preset",
      parsed: { tickers: ["USDC"], invalidTargets: ["foo"] },
      contains: ["Unknown ticker or preset: foo"],
      absent: ["Unknown alert type", "/presets"],
    },
    {
      name: "suggests the closest alert type only when no targets parsed and token resembles an alert type",
      parsed: { invalidTargets: ["dewz"] },
      contains: ["Unknown alert type: dewz", 'Did you mean "dews"?'],
    },
    {
      name: "does not misdiagnose an unknown ticker or preset typo as an alert type",
      parsed: { invalidTargets: ["USDTX"] },
      contains: ["Unknown ticker or preset: USDTX"],
      absent: ["Unknown alert type", "Did you mean"],
    },
    {
      name: "names the unknown ticker when an alert type is present",
      parsed: { alertTypes: new Set(["dews"]), invalidTargets: ["XYZZY"] },
      contains: ["Unknown ticker or preset: XYZZY"],
      absent: ["/presets"],
    },
    {
      name: "rejects mixing all with explicit tickers",
      parsed: { alertTypes: new Set(["dews"]), subscribeAll: true, tickers: ["USDC"] },
      contains: ['either "all" or specific tickers/presets'],
    },
    {
      name: "rejects retired launch alerts with the digest redirect",
      parsed: { alertTypes: new Set(["dews"]), retiredAlertTypes: ["launch"], tickers: ["USDC"] },
      contains: ["Launch alerts are retired", "@pharoswatch channel digest"],
    },
  ];

  it("returns null for valid args", () => {
    expect(validateSubscribeArgs({ ...baseArgs(), alertTypes: new Set(["dews"]), tickers: ["USDC"] })).toBeNull();
  });

  it("disambiguates USDCx across chains and suggests presets/tickers without matching single-char coins", () => {
    expect(resolveTicker("USDCx")).toMatchObject({ status: "ambiguous", matches: expect.arrayContaining([expect.objectContaining({ id: "usdcx-movement" }), expect.objectContaining({ id: "usdcx-canton" })]) });
    expect(resolveTicker("usdcx-movement")).toMatchObject({ status: "unique", matches: [expect.objectContaining({ id: "usdcx-movement" })] });
    expect(resolveTicker("USDTX")).toMatchObject({ status: "not_found", suggestion: expect.objectContaining({ symbol: "USDT" }) });
    expect(suggestClosestPreset("usd-top24")).toBe("usd-top25");
    expect(suggestClosestPreset("usd-top20")).toBe("usd-top10");
    expect(resolveTicker("usd-top20").suggestion?.symbol).not.toBe("U");
  });

  it.each(rejections)("$name", ({ parsed, contains, absent }) => {
    const result = validateSubscribeArgs({ ...baseArgs(), ...parsed });
    for (const fragment of contains) expect(result).toContain(fragment);
    for (const fragment of absent ?? []) expect(result).not.toContain(fragment);
  });
});

describe("retired launch alert type", () => {
  it("is neither an alert type nor a ticker, and validation explains the retirement", () => {
    const parsed = parseSubscribeArgs("launch USDPT");
    expect(parsed.alertTypes.size).toBe(0);
    expect(parsed.retiredAlertTypes).toEqual(["launch"]);
    expect(parsed.tickers).toEqual(["USDPT"]);
    expect(validateSubscribeArgs(parsed)).toContain("Launch alerts are retired");
  });

  it("is dropped from the valid-type hint", () => {
    expect(validateSubscribeArgs(parseSubscribeArgs("lanch"))).toBe(
      "Unknown ticker or preset: lanch. Check spelling or use the coin's symbol.",
    );
    expect(validateSubscribeArgs(parseSubscribeArgs("dewz"))).not.toContain("launch");
  });
});
