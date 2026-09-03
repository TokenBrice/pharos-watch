import { describe, it, expect } from "vitest";
import { FROZEN_STABLECOINS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  resolveTicker,
  parseTargetArgs,
  parseSubscribeArgs,
  validateSubscribeArgs,
  formatDisambiguation,
  formatDewsLine,
  formatDepegTriggeredLine,
  formatDepegWorseningLine,
  formatLaunchLine,
  parseDisambiguationReply,
  formatConsolidatedMessage,
  splitMessage,
  formatListOutput,
  findInvalidDisambiguationToken,
  isDewsAlertable,
  isDewsDeescalation,
  suggestClosestToken,
  buildAlertReplyMarkup,
  rankAlertCoins,
  resolveAlertLinkPreviewOptions,
  SNOOZE_REPLY_MARKUP,
  type ConsolidatedAlerts,
} from "../telegram/alerts";

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
  it("returns null for valid args", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      subscribeAll: false,
      presetIds: [],
      tickers: ["USDC"],
      invalidTargets: [],
    });
    expect(result).toBeNull();
  });

  it("returns error when no types", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(),
      subscribeAll: false,
      presetIds: [],
      tickers: ["USDC"],
      invalidTargets: [],
    });
    expect(result).toContain("alert type");
  });

  it("returns error when no tickers", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      subscribeAll: false,
      presetIds: [],
      tickers: [],
      invalidTargets: [],
    });
    expect(result).toContain("ticker or preset");
  });

  it("returns unknown alert type error when no types and invalidTypes present", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(),
      subscribeAll: false,
      presetIds: [],
      tickers: ["USDC"],
      invalidTargets: ["foo"],
    });
    expect(result).toContain("Unknown alert type: foo");
    expect(result).toContain("Valid types");
  });

  it("suggests the closest alert type for a single-token typo", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(),
      subscribeAll: false,
      presetIds: [],
      tickers: ["USDC"],
      invalidTargets: ["dewz"],
    });
    expect(result).toContain("Unknown alert type: dewz");
    expect(result).toContain('Did you mean "dews"?');
  });

  it("omits the suggestion when no alert type is within edit distance 1", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(),
      subscribeAll: false,
      presetIds: [],
      tickers: ["USDC"],
      invalidTargets: ["xyzzy"],
    });
    expect(result).toContain("Unknown alert type: xyzzy");
    expect(result).not.toContain("Did you mean");
  });

  it("returns unknown ticker error when types present and invalidTypes present", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      subscribeAll: false,
      presetIds: [],
      tickers: [],
      invalidTargets: ["XYZZY"],
    });
    expect(result).toContain("Unknown ticker or preset: XYZZY");
  });

  it("rejects mixing all with explicit tickers", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      subscribeAll: true,
      presetIds: [],
      tickers: ["USDC"],
      invalidTargets: [],
    });
    expect(result).toContain('either "all" or specific tickers/presets');
  });

  it("rejects launch alerts with preset watchlists", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["launch"]),
      subscribeAll: false,
      presetIds: ["usd-top25"],
      tickers: [],
      invalidTargets: [],
    });
    expect(result).toContain("Preset watchlists support dews, depeg, and safety only");
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

describe("formatDisambiguation", () => {
  it("formats numbered list", () => {
    const result = formatDisambiguation("GUSD", [
      { id: "gusd-gate", symbol: "GUSD", name: "Gate USD" },
      { id: "gusd-gemini", symbol: "GUSD", name: "Gemini Dollar" },
    ]);
    expect(result).toContain("1. GUSD — Gate USD");
    expect(result).toContain("2. GUSD — Gemini Dollar");
  });
});

describe("formatConsolidatedMessage", () => {
  it("includes all alert sections", () => {
    const msg = formatConsolidatedMessage({
      dews: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          oldBand: "CALM",
          newBand: "ALERT",
          score: 42,
          topSignals: [{ name: "supply", value: 45 }],
        },
      ],
      depegTriggered: [
        {
          stablecoinId: "bold-liquity",
          symbol: "BOLD",
          direction: "below",
          deviationBps: 230,
          price: 0.977,
          pegReference: 1.0,
        },
      ],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    });
    expect(msg).toContain("DEWS");
    expect(msg).toContain("Depeg Detected");
    expect(msg).not.toContain("Pharos Alerts");
    expect(msg).toContain("View on Pharos");
  });

  it("formats reserve drift alerts with a coin page link and reply markup", () => {
    const alerts: ConsolidatedAlerts = {
      dews: [],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          name: "Circle USD Coin",
        },
      ],
    };

    const msg = formatConsolidatedMessage(alerts);
    expect(msg).toContain("<b>Reserve Drift</b>");
    expect(msg).toContain("<b>USDC</b> — Circle USD Coin live reserve mix has drifted");
    expect(msg).toContain('href="https://pharos.watch/stablecoin/usdc-circle"');

    const markup = buildAlertReplyMarkup(alerts, 0);
    expect(markup.inline_keyboard.flat().map((button) =>
      "callback_data" in button ? button.callback_data : undefined
    )).toEqual(
      expect.arrayContaining(["status:usdc-circle", "coinsnooze:usdc-circle:4h"]),
    );
  });

  it("includes depeg worsening when present", () => {
    const msg = formatConsolidatedMessage({
      dews: [],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          direction: "below",
          previousDeviationBps: 120,
          currentDeviationBps: 260,
          price: 0.974,
          pegReference: 1,
        },
      ],
      safety: [],
      launch: [],
      reserve: [],
    });
    expect(msg).toContain("Depeg Worsening");
    expect(msg).toContain("1.2% → 2.6%");
  });

  it("links to coin page when all alerts are for a single coin", () => {
    const msg = formatConsolidatedMessage({
      dews: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          oldBand: "CALM",
          newBand: "ALERT",
          score: 42,
          topSignals: [],
        },
      ],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    });
    expect(msg).toContain("https://pharos.watch/stablecoin/usdc-circle");
  });

  it("links to root when alerts span multiple coins", () => {
    const msg = formatConsolidatedMessage({
      dews: [
        {
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          oldBand: "CALM",
          newBand: "ALERT",
          score: 42,
          topSignals: [],
        },
      ],
      depegTriggered: [
        {
          stablecoinId: "usdt-tether",
          symbol: "USDT",
          direction: "below",
          deviationBps: 100,
          price: 0.99,
          pegReference: 1.0,
        },
      ],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    });
    expect(msg).toContain('href="https://pharos.watch"');
  });
});

describe("formatDewsLine", () => {
  it("renders DEWS sub-signal values as percentages", () => {
    const line = formatDewsLine({
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      oldBand: "WATCH",
      newBand: "ALERT",
      score: 42,
      topSignals: [
        { name: "pool_balance_drift", value: 61 },
        { name: "supply_velocity", value: 48 },
      ],
    });
    expect(line).toContain("pool_balance_drift (61%)");
    expect(line).toContain("supply_velocity (48%)");
  });

  it("omits the Top signals line when no signals are available", () => {
    const line = formatDewsLine({
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      oldBand: "WATCH",
      newBand: "ALERT",
      score: 42,
      topSignals: [],
    });
    expect(line).not.toContain("Top signals");
  });

  it("prefixes the line with a severity glyph derived from newBand", () => {
    const watch = formatDewsLine({
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      oldBand: "CALM",
      newBand: "WATCH",
      score: 20,
      topSignals: [],
    });
    const alert = formatDewsLine({
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      oldBand: "WATCH",
      newBand: "ALERT",
      score: 42,
      topSignals: [],
    });
    const warning = formatDewsLine({
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      oldBand: "ALERT",
      newBand: "WARNING",
      score: 65,
      topSignals: [],
    });
    const danger = formatDewsLine({
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      oldBand: "WARNING",
      newBand: "DANGER",
      score: 85,
      topSignals: [],
    });
    expect(watch.startsWith("🟡 ")).toBe(true);
    expect(alert.startsWith("🟡 ")).toBe(true);
    expect(warning.startsWith("🟠 ")).toBe(true);
    expect(danger.startsWith("🔴 ")).toBe(true);
  });
});

describe("depeg direction glyphs", () => {
  it("prefixes triggered lines with ▼ below or ▲ above", () => {
    const below = formatDepegTriggeredLine({
      stablecoinId: "bold-liquity",
      symbol: "BOLD",
      direction: "below",
      deviationBps: 230,
      price: 0.977,
      pegReference: 1.0,
    });
    const above = formatDepegTriggeredLine({
      stablecoinId: "bold-liquity",
      symbol: "BOLD",
      direction: "above",
      deviationBps: 230,
      price: 1.023,
      pegReference: 1.0,
    });
    expect(below.startsWith("▼ ")).toBe(true);
    expect(above.startsWith("▲ ")).toBe(true);
  });

  it("adds recovery timing to close-then-reopen triggered lines", () => {
    const line = formatDepegTriggeredLine({
      stablecoinId: "bold-liquity",
      symbol: "BOLD",
      direction: "below",
      deviationBps: 230,
      price: 0.977,
      pegReference: 1.0,
      reopenedAfterMinutes: 65,
    });

    expect(line).toContain("Re-depegged after 1h 5m recovery");
  });

  it("formats native-currency event prices with the matching symbol", () => {
    const line = formatDepegTriggeredLine({
      stablecoinId: "eurq-quantoz",
      symbol: "EURQ",
      direction: "below",
      deviationBps: 160,
      price: 0.984,
      pegReference: 1,
      priceCurrency: "EUR",
    });

    expect(line).toContain("Price: €0.9840 (peg: €1.00)");
  });

  it("uses the canonical peg taxonomy for expanded fiat and commodity symbols", () => {
    const chf = formatDepegTriggeredLine({
      stablecoinId: "vchf-vnx",
      symbol: "VCHF",
      direction: "below",
      deviationBps: 200,
      price: 0.98,
      pegReference: 1,
      priceCurrency: "CHF",
    });
    const brl = formatDepegTriggeredLine({
      stablecoinId: "brl-example",
      symbol: "BRL",
      direction: "below",
      deviationBps: 200,
      price: 0.98,
      pegReference: 1,
      priceCurrency: "BRL",
    });
    const gold = formatDepegTriggeredLine({
      stablecoinId: "xaut-tether",
      symbol: "XAUT",
      direction: "below",
      deviationBps: 200,
      price: 3_500,
      pegReference: 3_550,
      priceCurrency: "GOLD",
    });

    expect(chf).toContain("Price: ₣0.9800 (peg: ₣1.00)");
    expect(brl).toContain("Price: R$0.9800 (peg: R$1.00)");
    expect(gold).toContain("Price: $3500.0000 (peg: $3550.00)");
  });

  it("keeps an ISO-style fallback for unknown external currencies", () => {
    const line = formatDepegTriggeredLine({
      stablecoinId: "external",
      symbol: "EXT",
      direction: "below",
      deviationBps: 200,
      price: 0.98,
      pegReference: 1,
      priceCurrency: "xyz",
    });

    expect(line).toContain("Price: XYZ 0.9800 (peg: XYZ 1.00)");
  });

  it("prefixes worsening lines with the same direction glyph", () => {
    const below = formatDepegWorseningLine({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      direction: "below",
      previousDeviationBps: 120,
      currentDeviationBps: 260,
      price: 0.974,
      pegReference: 1,
    });
    expect(below.startsWith("▼ ")).toBe(true);
  });
});

describe("formatLaunchLine", () => {
  it("prefixes launch lines with the ✦ promotion glyph", () => {
    const line = formatLaunchLine({
      stablecoinId: "usdpt-western-union",
      symbol: "USDPT",
      name: "Western Union USD",
    });
    expect(line.startsWith("✦ ")).toBe(true);
  });
});

describe("context line blockquote (P1-U13)", () => {
  const context = "Context: Safety A 85 · Liquidity 90, DEX TVL $12M · Supply $1.2B";

  it("wraps DEWS contextLine in <blockquote expandable>", () => {
    const line = formatDewsLine({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      oldBand: "WATCH",
      newBand: "ALERT",
      score: 42,
      topSignals: [],
      contextLine: context,
    });
    expect(line).toContain(`<blockquote expandable>${context}</blockquote>`);
    expect(line).not.toContain(`\n${context}\n`);
  });

  it("wraps depeg-triggered contextLine in <blockquote expandable>", () => {
    const line = formatDepegTriggeredLine({
      stablecoinId: "bold-liquity",
      symbol: "BOLD",
      direction: "below",
      deviationBps: 230,
      price: 0.977,
      pegReference: 1.0,
      contextLine: context,
    });
    expect(line).toContain(`<blockquote expandable>${context}</blockquote>`);
  });

  it("wraps depeg-worsening contextLine in <blockquote expandable>", () => {
    const line = formatDepegWorseningLine({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      direction: "below",
      previousDeviationBps: 120,
      currentDeviationBps: 260,
      price: 0.974,
      pegReference: 1,
      contextLine: context,
    });
    expect(line).toContain(`<blockquote expandable>${context}</blockquote>`);
  });

  it("escapes HTML inside the blockquote", () => {
    const malicious = "Context: <script>alert(1)</script>";
    const line = formatDewsLine({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      oldBand: "WATCH",
      newBand: "ALERT",
      score: 42,
      topSignals: [],
      contextLine: malicious,
    });
    expect(line).toContain(
      "<blockquote expandable>Context: &lt;script&gt;alert(1)&lt;/script&gt;</blockquote>",
    );
    expect(line).not.toContain("<script>");
  });

  it("omits the blockquote entirely when no contextLine is provided", () => {
    const line = formatDewsLine({
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      oldBand: "WATCH",
      newBand: "ALERT",
      score: 42,
      topSignals: [],
    });
    expect(line).not.toContain("<blockquote");
  });

  it("threads through formatConsolidatedMessage for a single DEWS alert", () => {
    const msg = formatConsolidatedMessage({
      dews: [{
        stablecoinId: "usdc-circle",
        symbol: "USDC",
        oldBand: "WATCH",
        newBand: "ALERT",
        score: 42,
        topSignals: [],
        contextLine: context,
      }],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    });
    expect(msg).toContain(`<blockquote expandable>${context}</blockquote>`);
  });
});

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(splitMessage("short")).toEqual(["short"]);
  });

  it("splits long messages at section boundaries", () => {
    const long = Array(100).fill("Section text here").join("\n\n");
    const chunks = splitMessage(long, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200 + 100); // allow single oversized section
    }
  });
});

describe("formatListOutput", () => {
  it("formats active subscriptions", () => {
    const output = formatListOutput(
      { dews: true, depeg: true, safety: false, launch: false },
      [
        { symbol: "USDC", id: "usdc-circle" },
        { symbol: "BOLD", id: "bold-liquity" },
      ],
    );
    expect(output).toContain("DEWS, Depeg");
    expect(output).toContain("Coins (2)");
    expect(output).toContain("USDC (usdc-circle)");
  });

  it("shows None when no types or coins", () => {
    const output = formatListOutput({ dews: false, depeg: false, safety: false, launch: false }, []);
    expect(output).toContain("Alert types: None");
    expect(output).toContain("Coins (0):\nNone");
  });
});

describe("isDewsAlertable", () => {
  it("returns true for ALERT, WARNING, DANGER", () => {
    expect(isDewsAlertable("ALERT")).toBe(true);
    expect(isDewsAlertable("WARNING")).toBe(true);
    expect(isDewsAlertable("DANGER")).toBe(true);
  });

  it("returns false for CALM and WATCH", () => {
    expect(isDewsAlertable("CALM")).toBe(false);
    expect(isDewsAlertable("WATCH")).toBe(false);
  });
});

describe("isDewsDeescalation", () => {
  it("detects de-escalation", () => {
    expect(isDewsDeescalation("DANGER", "WARNING")).toBe(true);
    expect(isDewsDeescalation("WARNING", "ALERT")).toBe(true);
  });

  it("detects escalation", () => {
    expect(isDewsDeescalation("ALERT", "WARNING")).toBe(false);
    expect(isDewsDeescalation("CALM", "DANGER")).toBe(false);
  });
});

describe("splitMessage HTML safety", () => {
  it("does not break HTML tags at character boundaries", () => {
    // Build a long line with an HTML tag near the split boundary
    const longText = "<b>" + "x".repeat(3990) + "</b>" + "\n\n" + "<b>second</b>";
    const chunks = splitMessage(longText, 4000);
    // Every chunk with a <b> must also have </b>
    for (const chunk of chunks) {
      const opens = (chunk.match(/<b>/g) ?? []).length;
      const closes = (chunk.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("strips tags from chunks that would have broken HTML", () => {
    // A single long line that forces character-boundary splitting mid-tag
    const longLine = "x".repeat(3995) + "<b>bold</b>";
    const chunks = splitMessage(longLine, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const opens = (chunk.match(/<b>/g) ?? []).length;
      const closes = (chunk.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("balances expandable blockquotes across hard chunk boundaries", () => {
    const longContext = `<blockquote expandable>${"context ".repeat(900)}</blockquote>`;
    const chunks = splitMessage(longContext, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    const countBlockquoteOpen = (value: string): number => {
      let count = 0;
      let cursor = 0;
      const openTag = "<blockquote";
      while (true) {
        const hit = value.indexOf(openTag, cursor);
        if (hit === -1) break;
        if (!value.startsWith("</blockquote", hit)) {
          count++;
        }
        cursor = hit + openTag.length;
      }
      return count;
    };

    for (const chunk of chunks) {
      const opens = countBlockquoteOpen(chunk);
      const closes = (chunk.match(/<\/blockquote>/g) ?? []).length;
      expect(opens).toBe(closes);
      const lastOpen = chunk.lastIndexOf("<blockquote");
      const hasDanglingOpen = lastOpen !== -1 ? chunk.indexOf(">", lastOpen) === -1 : false;
      expect(hasDanglingOpen).toBe(false);
      expect(chunk).not.toMatch(/^expandable>/);
    }
  });
});

describe("buildAlertReplyMarkup callback_data 64-byte boundary", () => {
  const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

  function collectCallbackData(markup: { inline_keyboard: ReadonlyArray<ReadonlyArray<unknown>> }): string[] {
    return markup.inline_keyboard.flatMap((row) =>
      row
        .map((btn) =>
          typeof btn === "object" && btn !== null && "callback_data" in btn
            ? (btn as { callback_data?: unknown }).callback_data
            : undefined,
        )
        .filter((data): data is string => typeof data === "string"),
    );
  }

  function collectButtonText(markup: { inline_keyboard: ReadonlyArray<ReadonlyArray<unknown>> }): string[] {
    return markup.inline_keyboard.flatMap((row) =>
      row
        .map((btn) =>
          typeof btn === "object" && btn !== null && "text" in btn
            ? (btn as { text?: unknown }).text
            : undefined,
        )
        .filter((text): text is string => typeof text === "string"),
    );
  }

  function singleCoinAlerts(stablecoinId: string): ConsolidatedAlerts {
    return {
      dews: [
        {
          stablecoinId,
          symbol: "XXX",
          oldBand: "CALM",
          newBand: "ALERT",
          score: 42,
          topSignals: [],
        },
      ],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    };
  }

  it("keeps every snooze callback_data within Telegram's 64-byte limit", () => {
    for (const data of collectCallbackData(SNOOZE_REPLY_MARKUP)) {
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }
  });

  it("keeps callback_data within 64 bytes for the longest tracked stablecoin id", () => {
    const ids = Array.from(TRACKED_META_BY_ID.keys());
    expect(ids.length).toBeGreaterThan(0);
    const longestId = ids.reduce((a, b) => (b.length > a.length ? b : a));
    const markup = buildAlertReplyMarkup(singleCoinAlerts(longestId), 0);
    const callbacks = collectCallbackData(markup);
    // Sanity: longest id should have produced the per-coin markup, not just the snooze row.
    expect(callbacks.some((c) => c.startsWith("status:"))).toBe(true);
    for (const data of callbacks) {
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }
  });

  it("keeps callback_data within 64 bytes for every tracked stablecoin id", () => {
    for (const id of TRACKED_META_BY_ID.keys()) {
      const markup = buildAlertReplyMarkup(singleCoinAlerts(id), 0);
      for (const data of collectCallbackData(markup)) {
        expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
      }
    }
  });

  it("returns the snooze-only markup for non-first chunks and stays within the limit", () => {
    const ids = Array.from(TRACKED_META_BY_ID.keys());
    const longestId = ids.reduce((a, b) => (b.length > a.length ? b : a));
    const markup = buildAlertReplyMarkup(singleCoinAlerts(longestId), 1);
    for (const data of collectCallbackData(markup)) {
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }
  });

  it("keeps single-coin alert keyboards to two rows with compact snooze controls (P1-U10)", () => {
    const markup = buildAlertReplyMarkup(singleCoinAlerts("usdc-circle"), 0);
    const callbacks = collectCallbackData(markup);
    expect(markup.inline_keyboard.length).toBeLessThanOrEqual(2);
    expect(callbacks).toContain("status:usdc-circle");
    expect(callbacks).toContain("depegstep:usdc-circle:250");
    expect(callbacks).toContain("safetydown:usdc-circle");
    expect(callbacks).toContain("coinsnooze:usdc-circle:4h");
    expect(callbacks).toContain("snooze:4h");
    expect(callbacks.some((c) => c === "coinsnooze:usdc-circle:1h")).toBe(false);
    expect(callbacks.some((c) => c === "coinsnooze:usdc-circle:24h")).toBe(false);
    expect(callbacks.some((c) => c === "snooze:1h")).toBe(false);
    expect(callbacks.some((c) => c === "snooze:24h")).toBe(false);
  });

  it("uses a compact depeg-step label for the one-tap tuning button", () => {
    const markup = buildAlertReplyMarkup(singleCoinAlerts("usdc-circle"), 0);
    expect(collectButtonText(markup)).toContain("Depeg 250");
  });

  it("folds the private Mini App button into the compact single-coin action row", () => {
    const markup = buildAlertReplyMarkup(singleCoinAlerts("usdc-circle"), 0, { privateChat: true });
    expect(markup.inline_keyboard.length).toBeLessThanOrEqual(2);
    expect(collectButtonText(markup)).toContain("Open app");
    expect(JSON.stringify(markup)).toContain("web_app");
  });

  it("adds a compact per-coin snooze row for the top coins on the first multi-coin chunk (C118)", () => {
    const multiCoin: ConsolidatedAlerts = {
      dews: [
        { stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "CALM", newBand: "WARNING", score: 42, topSignals: [] },
        { stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "CALM", newBand: "ALERT", score: 50, topSignals: [] },
      ],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    };
    const markup = buildAlertReplyMarkup(multiCoin, 0, { privateChat: true });
    const callbacks = collectCallbackData(markup);
    expect(markup.inline_keyboard.length).toBeLessThanOrEqual(2);
    // Top coin (USDC, WARNING) ranks above USDT (ALERT); both appear (top 2).
    expect(callbacks).toContain("coinsnooze:usdc-circle:4h");
    expect(callbacks).toContain("coinsnooze:usdt-tether:4h");
    // Only the 4h per-coin snooze is offered in the compact row.
    expect(callbacks.some((c) => c === "coinsnooze:usdc-circle:1h")).toBe(false);
    expect(callbacks.some((c) => c === "coinsnooze:usdc-circle:24h")).toBe(false);
    // The chat-level snooze row is preserved.
    expect(callbacks).toContain("snooze:1h");
    // The displayed symbol drives the button text; callback_data is id-only.
    expect(collectButtonText(markup)).toContain("Snooze USDC 4h");
    expect(JSON.stringify(markup)).not.toContain("web_app");
  });

  it("omits the per-coin snooze row on overflow chunks of multi-coin alerts (C118)", () => {
    const multiCoin: ConsolidatedAlerts = {
      dews: [
        { stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "CALM", newBand: "WARNING", score: 42, topSignals: [] },
        { stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "CALM", newBand: "ALERT", score: 50, topSignals: [] },
      ],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    };
    const markup = buildAlertReplyMarkup(multiCoin, 1);
    const callbacks = collectCallbackData(markup);
    expect(markup.inline_keyboard.length).toBeLessThanOrEqual(2);
    expect(callbacks.some((c) => c.startsWith("coinsnooze:"))).toBe(false);
    expect(callbacks).toContain("snooze:1h");
  });

  it("keeps the multi-coin per-coin snooze callback_data within 64 bytes for the longest ids", () => {
    const ids = Array.from(TRACKED_META_BY_ID.keys());
    const sorted = [...ids].sort((a, b) => b.length - a.length);
    const [a, b] = sorted;
    const multiCoin: ConsolidatedAlerts = {
      dews: [
        { stablecoinId: a, symbol: "AAA", oldBand: "CALM", newBand: "ALERT", score: 10, topSignals: [] },
        { stablecoinId: b, symbol: "BBB", oldBand: "CALM", newBand: "WARNING", score: 10, topSignals: [] },
      ],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    };
    const markup = buildAlertReplyMarkup(multiCoin, 0);
    const callbacks = collectCallbackData(markup);
    // Sanity: the multi-coin branch produced per-coin snooze callbacks.
    expect(callbacks.some((c) => c.startsWith("coinsnooze:"))).toBe(true);
    for (const data of callbacks) {
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }
  });
});

describe("rankAlertCoins (C118)", () => {
  const empty = {
    dews: [],
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safety: [],
    launch: [],
    reserve: [],
  };

  it("ranks a depeg bps severity above a DEWS WATCH band", () => {
    const ranked = rankAlertCoins({
      ...empty,
      dews: [{ stablecoinId: "a", symbol: "A", oldBand: "CALM", newBand: "WATCH", score: 1, topSignals: [] }],
      depegTriggered: [
        { stablecoinId: "b", symbol: "B", direction: "below", deviationBps: 300, price: 0.97, pegReference: 1 },
      ],
    });
    expect(ranked.map((c) => c.stablecoinId)).toEqual(["b", "a"]);
  });

  it("ranks a DANGER DEWS band above a WARNING DEWS band", () => {
    const ranked = rankAlertCoins({
      ...empty,
      dews: [
        { stablecoinId: "warn", symbol: "W", oldBand: "CALM", newBand: "WARNING", score: 1, topSignals: [] },
        { stablecoinId: "danger", symbol: "D", oldBand: "CALM", newBand: "DANGER", score: 1, topSignals: [] },
      ],
    });
    expect(ranked.map((c) => c.stablecoinId)).toEqual(["danger", "warn"]);
  });

  it("dedupes a coin appearing in multiple families, keeping its highest severity", () => {
    const ranked = rankAlertCoins({
      ...empty,
      dews: [{ stablecoinId: "dup", symbol: "DUP", oldBand: "CALM", newBand: "WATCH", score: 1, topSignals: [] }],
      depegTriggered: [
        { stablecoinId: "dup", symbol: "DUP", direction: "below", deviationBps: 500, price: 0.95, pegReference: 1 },
      ],
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ stablecoinId: "dup", severity: 500 });
  });

  it("preserves first-seen order on ties and returns at most two coins", () => {
    const ranked = rankAlertCoins({
      ...empty,
      dews: [
        { stablecoinId: "x", symbol: "X", oldBand: "CALM", newBand: "ALERT", score: 1, topSignals: [] },
        { stablecoinId: "y", symbol: "Y", oldBand: "CALM", newBand: "ALERT", score: 1, topSignals: [] },
        { stablecoinId: "z", symbol: "Z", oldBand: "CALM", newBand: "ALERT", score: 1, topSignals: [] },
      ],
    });
    expect(ranked).toHaveLength(2);
    expect(ranked.map((c) => c.stablecoinId)).toEqual(["x", "y"]);
  });
});

describe("resolveAlertLinkPreviewOptions", () => {
  function singleCoinAlerts(stablecoinId: string): ConsolidatedAlerts {
    return {
      dews: [
        {
          stablecoinId,
          symbol: "USDC",
          oldBand: "CALM",
          newBand: "ALERT",
          score: 42,
          topSignals: [],
        },
      ],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    };
  }

  function multiCoinAlerts(): ConsolidatedAlerts {
    return {
      dews: [
        { stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "CALM", newBand: "ALERT", score: 42, topSignals: [] },
        { stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "CALM", newBand: "ALERT", score: 50, topSignals: [] },
      ],
      depegTriggered: [],
      depegResolved: [],
      depegWorsening: [],
      safety: [],
      launch: [],
      reserve: [],
    };
  }

  it("enables a small preview on the first chunk of a single-coin alert", () => {
    const options = resolveAlertLinkPreviewOptions(singleCoinAlerts("usdc-circle"), 0);
    expect(options).toEqual({
      is_disabled: false,
      url: "https://pharos.watch/stablecoin/usdc-circle",
      prefer_small_media: true,
      show_above_text: false,
    });
  });

  it("returns null for chunks after the first chunk of a single-coin alert", () => {
    expect(resolveAlertLinkPreviewOptions(singleCoinAlerts("usdc-circle"), 1)).toBeNull();
    expect(resolveAlertLinkPreviewOptions(singleCoinAlerts("usdc-circle"), 2)).toBeNull();
  });

  it("returns null for multi-coin alerts even on the first chunk", () => {
    expect(resolveAlertLinkPreviewOptions(multiCoinAlerts(), 0)).toBeNull();
  });
});
