import { describe, it, expect } from "vitest";
import { FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  resolveTicker,
  parseTargetArgs,
  parseSubscribeArgs,
  validateSubscribeArgs,
  parseDisambiguationReply,
  findInvalidDisambiguationToken,
  suggestClosestToken,
  type ParsedSubscribeArgs,
} from "../telegram/alerts-parser";

describe("resolveTicker", () => {
  it("resolves unique ticker", () => {
    const result = resolveTicker("USDC");
    expect(result.status).toBe("unique");
    expect(result.matches[0].id).toBe("usdc-circle");
  });

  it("is case-insensitive", () => {
    const result = resolveTicker("usdc");
    expect(result.status).toBe("unique");
    expect(result.matches[0].id).toBe("usdc-circle");
  });

  it("resolves exact coin ids uniquely", () => {
    const result = resolveTicker("usdc-circle");
    expect(result.status).toBe("unique");
    expect(result.matches[0].symbol).toBe("USDC");
  });

  it("resolves pre-launch tickers for explicit launch subscriptions", () => {
    const result = resolveTicker("USDPT");
    expect(result.status).toBe("unique");
    expect(result.matches[0].id).toBe("usdpt-western-union");
  });

  it("returns ambiguous for duplicate tickers", () => {
    const result = resolveTicker("GUSD");
    expect(result.status).toBe("ambiguous");
    expect(result.matches.length).toBe(2);
  });

  it("returns not_found for unknown ticker", () => {
    const result = resolveTicker("ZZZZZ");
    expect(result.status).toBe("not_found");
    expect(result.matches).toEqual([]);
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
  it("separates alert types from tickers", () => {
    const result = parseSubscribeArgs("dews depeg USDC BOLD");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg"]));
    expect(result.subscribeAll).toBe(false);
    expect(result.presetIds).toEqual([]);
    expect(result.tickers).toEqual(["USDC", "BOLD"]);
  });

  it("is order-independent", () => {
    const result = parseSubscribeArgs("USDC dews BOLD depeg");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg"]));
    expect(result.subscribeAll).toBe(false);
    expect(result.presetIds).toEqual([]);
    expect(result.tickers).toEqual(["USDC", "BOLD"]);
  });

  it("handles all three types", () => {
    const result = parseSubscribeArgs("dews depeg safety USDT");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg", "safety"]));
  });

  it("recognizes the all-stablecoin token", () => {
    const result = parseSubscribeArgs("dews all");
    expect(result.alertTypes).toEqual(new Set(["dews"]));
    expect(result.subscribeAll).toBe(true);
    expect(result.presetIds).toEqual([]);
    expect(result.tickers).toEqual([]);
    expect(result.invalidTargets).toEqual([]);
  });

  it("classifies preset aliases separately from tickers", () => {
    const result = parseSubscribeArgs("dews usd-top25 USDC");
    expect(result.alertTypes).toEqual(new Set(["dews"]));
    expect(result.subscribeAll).toBe(false);
    expect(result.presetIds).toEqual(["usd-top25"]);
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTargets).toEqual([]);
  });

  it("accepts dashed preset aliases and canonicalizes them", () => {
    const result = parseSubscribeArgs("dews usd-top-25");
    expect(result.alertTypes).toEqual(new Set(["dews"]));
    expect(result.subscribeAll).toBe(false);
    expect(result.presetIds).toEqual(["usd-top25"]);
    expect(result.tickers).toEqual([]);
    expect(result.invalidTargets).toEqual([]);
  });

  it("accepts non-USD preset aliases and canonicalizes dashed forms", () => {
    const result = parseSubscribeArgs("dews,depeg non-usd-top-25");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg"]));
    expect(result.subscribeAll).toBe(false);
    expect(result.presetIds).toEqual(["non-usd-top25"]);
    expect(result.tickers).toEqual([]);
    expect(result.invalidTargets).toEqual([]);
  });

  it("classifies unknown tokens as invalidTargets", () => {
    const result = parseSubscribeArgs("foo dews USDC");
    expect(result.alertTypes).toEqual(new Set(["dews"]));
    expect(result.subscribeAll).toBe(false);
    expect(result.presetIds).toEqual([]);
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTargets).toEqual(["foo"]);
  });

  it("classifies completely unknown tokens when no types present", () => {
    const result = parseSubscribeArgs("foo USDC");
    expect(result.alertTypes.size).toBe(0);
    expect(result.subscribeAll).toBe(false);
    expect(result.presetIds).toEqual([]);
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTargets).toEqual(["foo"]);
  });

  it("handles comma-separated alert types", () => {
    const result = parseSubscribeArgs("dews,depeg USDC");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg"]));
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTargets).toEqual([]);
  });

  it("parses depeg-step after preset targets and implies depeg", () => {
    const result = parseSubscribeArgs("usd-top-50 depeg-step 250");
    expect(result.alertTypes).toEqual(new Set(["depeg"]));
    expect(result.presetIds).toEqual(["usd-top50"]);
    expect(result.tickers).toEqual([]);
    expect(result.depegWorseningBpsStep).toBe(250);
    expect(result.invalidTargets).toEqual([]);
  });

  it("parses depeg-step before preset targets", () => {
    const result = parseSubscribeArgs("depeg-step 250 usd-top-50");
    expect(result.alertTypes).toEqual(new Set(["depeg"]));
    expect(result.presetIds).toEqual(["usd-top50"]);
    expect(result.depegWorseningBpsStep).toBe(250);
    expect(result.invalidTargets).toEqual([]);
  });

  it("parses depeg-step off", () => {
    const result = parseSubscribeArgs("depeg-step off USDC");
    expect(result.alertTypes).toEqual(new Set(["depeg"]));
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.depegWorseningBpsStep).toBeNull();
  });

  it("captures invalid depeg-step values", () => {
    const result = parseSubscribeArgs("usd-top-50 depeg-step 75");
    expect(result.alertTypes).toEqual(new Set(["depeg"]));
    expect(result.invalidDepegWorseningBpsStep).toBe("75");
    expect(validateSubscribeArgs(result)).toContain("Depeg-step values");
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

  it("accepts dashed preset aliases for unsubscribe-style commands", () => {
    const result = parseTargetArgs("usd-top-25 USDC");
    expect(result.includeAll).toBe(false);
    expect(result.presetIds).toEqual(["usd-top25"]);
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTargets).toEqual([]);
  });

  it("accepts non-USD preset aliases for unsubscribe-style commands", () => {
    const result = parseTargetArgs("non-usd-top-50");
    expect(result.includeAll).toBe(false);
    expect(result.presetIds).toEqual(["non-usd-top50"]);
    expect(result.tickers).toEqual([]);
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
      name: "names the unknown alert type when no type parsed",
      parsed: { tickers: ["USDC"], invalidTargets: ["foo"] },
      contains: ["Unknown alert type: foo", "Valid types"],
    },
    {
      name: "suggests the closest alert type for a single-token typo",
      parsed: { tickers: ["USDC"], invalidTargets: ["dewz"] },
      contains: ["Unknown alert type: dewz", 'Did you mean "dews"?'],
    },
    {
      name: "omits the suggestion when no alert type is within edit distance 1",
      parsed: { tickers: ["USDC"], invalidTargets: ["xyzzy"] },
      contains: ["Unknown alert type: xyzzy"],
      absent: ["Did you mean"],
    },
    {
      name: "names the unknown ticker when an alert type is present",
      parsed: { alertTypes: new Set(["dews"]), invalidTargets: ["XYZZY"] },
      contains: ["Unknown ticker or preset: XYZZY"],
    },
    {
      name: "rejects mixing all with explicit tickers",
      parsed: { alertTypes: new Set(["dews"]), subscribeAll: true, tickers: ["USDC"] },
      contains: ['either "all" or specific tickers/presets'],
    },
    {
      name: "rejects launch alerts with preset watchlists",
      parsed: { alertTypes: new Set(["launch"]), presetIds: ["usd-top25"] },
      contains: ["Preset watchlists support dews, depeg, and safety only"],
    },
  ];

  it("returns null for valid args", () => {
    expect(validateSubscribeArgs({ ...baseArgs(), alertTypes: new Set(["dews"]), tickers: ["USDC"] })).toBeNull();
  });

  it.each(rejections)("$name", ({ parsed, contains, absent }) => {
    const result = validateSubscribeArgs({ ...baseArgs(), ...parsed });
    for (const fragment of contains) expect(result).toContain(fragment);
    for (const fragment of absent ?? []) expect(result).not.toContain(fragment);
  });
});

describe("suggestClosestToken", () => {
  const candidates = ["dews", "depeg", "safety", "launch"];

  it("returns an exact match", () => {
    expect(suggestClosestToken("dews", candidates)).toBe("dews");
  });

  it("is case-insensitive", () => {
    expect(suggestClosestToken("Dews", candidates)).toBe("dews");
  });

  it("returns the candidate within edit distance 1", () => {
    expect(suggestClosestToken("dewz", candidates)).toBe("dews");
    expect(suggestClosestToken("depig", candidates)).toBe("depeg");
  });

  it("returns null when no candidate is within edit distance 1", () => {
    expect(suggestClosestToken("xyzzy", candidates)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(suggestClosestToken("", candidates)).toBeNull();
  });
});

describe("parseDisambiguationReply", () => {
  it("parses single number", () => {
    expect(parseDisambiguationReply("1", 3)).toEqual([0]);
  });

  it("parses comma-separated numbers", () => {
    expect(parseDisambiguationReply("1,2", 3)).toEqual([0, 1]);
  });

  it("parses space-separated numbers", () => {
    expect(parseDisambiguationReply("1 3", 3)).toEqual([0, 2]);
  });

  it("returns null for out-of-range", () => {
    expect(parseDisambiguationReply("5", 3)).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseDisambiguationReply("abc", 3)).toBeNull();
  });

  it("identifies the offending token for invalid replies", () => {
    expect(findInvalidDisambiguationToken("1 abc", 3)).toBe("abc");
    expect(findInvalidDisambiguationToken("4", 3)).toBe("4");
    expect(findInvalidDisambiguationToken("1,2", 3)).toBeNull();
  });
});
