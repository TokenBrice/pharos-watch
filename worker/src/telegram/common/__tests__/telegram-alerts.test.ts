import { describe, it, expect } from "vitest";
import { emptyConsolidatedAlerts, singleCoinAlerts } from "./telegram-alerts.test-support";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { TELEGRAM_PUBLIC_ALERT_SAMPLES } from "@shared/lib/telegram-alert-samples";
import {
  formatDewsLine,
  formatDepegTriggeredLine,
  formatDepegWorseningLine,
  formatSafetyLine,
  formatConsolidatedMessage,
  formatHourlyFreezeBatchMessage,
  compareFreezeAlerts,
  splitMessage,
  isDewsAlertable,
  isDewsDeescalation,
  buildAlertReplyMarkup,
  resolveAlertLinkPreviewOptions,
  type AlertVia,
  type ConsolidatedAlerts,
  type FreezeAlert,
} from "../alerts-formatting";

describe("formatConsolidatedMessage", () => {
  it("includes all alert sections and links coin symbols in multi-coin alerts", () => {
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
      reserve: [],
    });
    expect(msg).toContain('<a href="https://pharos.watch/stablecoin/usdc-circle"><b>USDC</b></a> DEWS stress rose to ALERT (42/100, was CALM)');
    expect(msg).toContain('▼ <a href="https://pharos.watch/stablecoin/bold-liquity"><b>BOLD</b></a> lost its peg: $0.9770, 2.3% below $1.00');
    expect(msg).not.toContain("<b>DEWS</b>");
    expect(msg).not.toContain("Depeg Detected");
    expect(msg).toContain('href="https://pharos.watch">View on Pharos</a>');
  });

  it("formats reserve drift alerts with #reserves anchor, signed scores or legacy fallback, and non-destructive markup", () => {
    const legacyAlerts: ConsolidatedAlerts = emptyConsolidatedAlerts({ reserve: [
      {
        stablecoinId: "usdc-circle",
        symbol: "USDC",
        name: "Circle USD Coin",
      },
    ] });

    const legacyMsg = formatConsolidatedMessage(legacyAlerts);
    expect(legacyMsg.split("\n")[0]).toBe("<b>USDC</b> reserves no longer match their reviewed profile");
    expect(legacyMsg).toContain("live reserve data for Circle USD Coin now differs");
    expect(legacyMsg).toContain('href="https://pharos.watch/stablecoin/usdc-circle#reserves"');

    const scoredMsg = formatConsolidatedMessage(emptyConsolidatedAlerts({ reserve: [
      { stablecoinId: "usdc-circle", symbol: "USDC", name: "Circle USD Coin", liveScore: 62, curatedScore: 84 },
    ] }));
    expect(scoredMsg).toContain("Live reserve score 62/100 vs reviewed 84/100 (-22 pts). Advisory only; Safety Score unchanged.");
    expect(formatConsolidatedMessage(emptyConsolidatedAlerts({ reserve: [
      { stablecoinId: "usdc-circle", symbol: "USDC", name: "Circle USD Coin", liveScore: 88, curatedScore: 64 },
    ] }))).toContain("Live reserve score 88/100 vs reviewed 64/100 (+24 pts).");

    const markup = buildAlertReplyMarkup(legacyAlerts, 0);
    expect(markup.inline_keyboard.flat().map((button) =>
      "callback_data" in button ? button.callback_data : undefined
    )).toEqual(
      ["coinsnooze:usdc-circle:24h", "snooze:4h", "settings:o:usdc-circle"],
    );
  });

  it("includes depeg worsening with prior-check parity for benchmark and peer-relative events", () => {
    const msg = formatConsolidatedMessage(emptyConsolidatedAlerts({ depegWorsening: [
      {
        stablecoinId: "usdc-circle",
        symbol: "USDC",
        direction: "below",
        previousDeviationBps: 120,
        currentDeviationBps: 260,
        price: 0.974,
        pegReference: 1,
      },
    ] }));
    expect(msg).toContain("▼ <b>USDC</b> depeg deepened to 2.6% below $1.00 ($0.9740)\nWas 1.2% at the previous check");
    expect(formatDepegWorseningLine({
      stablecoinId: "eurc-circle", symbol: "EURC", direction: "below",
      previousDeviationBps: 140, currentDeviationBps: 310, price: 0.969, pegReference: 1, peakBasis: "peer-relative",
    })).toContain("\nWas 1.4% at the previous check");
  });

});

describe("formatDewsLine", () => {
  it("renders DEWS sub-signals with human labels and unitless 0-100 values", () => {
    const line = formatDewsLine({
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      oldBand: "WATCH",
      newBand: "ALERT",
      score: 42,
      topSignals: [
        { name: "pool", value: 61 },
        { name: "supply", value: 48 },
      ],
    });
    expect(line).toBe("\u{1F7E1} <b>USDT</b> DEWS stress rose to ALERT (42/100, was WATCH)\nMain drivers (0-100): Pool Balance Drift 61, Supply Velocity 48");
    expect(line).not.toContain("%");
  });

  it("names a de-escalation and falls back for an unknown prior band", () => {
    expect(formatDewsLine({ stablecoinId: "a", symbol: "A", oldBand: "DANGER", newBand: "WARNING", score: 60, topSignals: [] }))
      .toBe("\u{1F7E0} <b>A</b> DEWS stress eased to WARNING (60/100, was DANGER)");
    expect(formatDewsLine({ stablecoinId: "a", symbol: "A", oldBand: "UNKNOWN", newBand: "ALERT", score: 40, topSignals: [] }))
      .toBe("\u{1F7E1} <b>A</b> DEWS stress is now ALERT (40/100)");
  });

  it.each([
    ["CALM", "WATCH", 20, "\u{1F7E1} "],
    ["WATCH", "ALERT", 42, "\u{1F7E1} "],
    ["ALERT", "WARNING", 65, "\u{1F7E0} "],
    ["WARNING", "DANGER", 85, "\u{1F534} "],
  ] as const)("prefixes %s to %s with its severity glyph", (oldBand, newBand, score, glyph) => {
    const line = formatDewsLine({
      stablecoinId: "usdt-tether", symbol: "USDT", oldBand, newBand, score, topSignals: [],
    });
    expect(line.startsWith(glyph)).toBe(true);
  });
});

describe("formatSafetyLine", () => {
  it.each([
    ["D", "C", "raised"],
    ["C-", "D", "downgraded"],
    ["NR", "B", "changed"],
  ] as const)("states the direction of %s to %s", (oldGrade, newGrade, verb) => {
    expect(formatSafetyLine({ stablecoinId: "x", symbol: "IUSD", oldGrade, newGrade, oldScore: 39, newScore: 42 }))
      .toBe(`<b>IUSD</b> Safety grade ${verb} to ${newGrade} (was ${oldGrade})\nOverall score 42 (was 39)`);
  });
});

describe("public alert samples", () => {
  /** Plain-text render of a Telegram HTML message as the landing bubbles show it. */
  const toPlainSample = (html: string) => html
    .replace(/\n\n<a href="https:\/\/([^"]+)">View on Pharos<\/a>$/, "\n\nView on Pharos: $1")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const buttonRows = (alerts: ConsolidatedAlerts) => buildAlertReplyMarkup(alerts, 0, { privateChat: true })
    .inline_keyboard.map((row) => row.map((button) => button.text));
  const watchlist = { presetIds: [], watchlist: true, allStablecoins: false };
  const usdTop25 = { presetIds: ["usd-top25"], watchlist: false, allStablecoins: false };
  // Every family, reserve included, renders through the live consolidated
  // formatter: reserve drift routes live to direct and global followers.
  const fixtures: Record<keyof typeof TELEGRAM_PUBLIC_ALERT_SAMPLES, { alerts: ConsolidatedAlerts; via: AlertVia }> = {
    dews: {
      alerts: emptyConsolidatedAlerts({ dews: [{
        stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "ALERT", newBand: "WARNING", score: 58,
        topSignals: [{ name: "pool", value: 71 }, { name: "supply", value: 64 }],
      }] }),
      via: usdTop25,
    },
    depeg: {
      alerts: emptyConsolidatedAlerts({ depegTriggered: [{
        stablecoinId: "usdc-circle", symbol: "USDC", direction: "below", deviationBps: 120, price: 0.988, pegReference: 1,
      }] }),
      via: usdTop25,
    },
    safety: {
      alerts: emptyConsolidatedAlerts({ safety: [{
        stablecoinId: "usdr-tangible", symbol: "USDR", oldGrade: "B", newGrade: "D", oldScore: 70, newScore: 44,
        contextLine: "Reason: Exit score fell from 72 to 35. Exit measures how easily holders can redeem or sell near peg.",
      }] }),
      via: watchlist,
    },
    freeze: {
      alerts: emptyConsolidatedAlerts({ freeze: [{
        stablecoinId: "usdc-circle", symbol: "USDC", eventType: "blacklist", chainName: "Ethereum",
        amountUsdAtEvent: 1_000_000, tapeEventId: "t", sourceEventId: "s",
        eventTsSec: Date.parse("2026-11-26T09:12:00Z") / 1000,
      }] }),
      via: watchlist,
    },
    reserve: {
      alerts: emptyConsolidatedAlerts({ reserve: [{
        stablecoinId: "usdc-circle", symbol: "USDC", name: "Circle USD Coin",
        liveScore: 62, curatedScore: 84,
      }] }),
      via: watchlist,
    },
  };

  it.each(Object.keys(fixtures) as Array<keyof typeof fixtures>)("keeps the %s sample verbatim with formatter output", (key) => {
    const { alerts, via } = fixtures[key];
    expect(TELEGRAM_PUBLIC_ALERT_SAMPLES[key].message).toBe(toPlainSample(formatConsolidatedMessage(alerts, { via })));
    expect(TELEGRAM_PUBLIC_ALERT_SAMPLES[key].buttons).toEqual(buttonRows(alerts));
  });
});

describe("alert template", () => {
  const safetyDown = (stablecoinId: string, symbol: string, oldGrade: string, newGrade: string, oldScore: number, newScore: number) =>
    ({ stablecoinId, symbol, oldGrade, newGrade, oldScore, newScore });

  it("opens a single-coin alert with its headline and ends with the provenance footer", () => {
    const msg = formatConsolidatedMessage(emptyConsolidatedAlerts({ safety: [{
      ...safetyDown("wm-m0", "wM", "C-", "D", 51, 44),
      contextLine: "Reason: Control score fell from 69 to 45.",
    }] }), { via: { presetIds: ["usd-top25", "usd-top10"], watchlist: true, allStablecoins: false } });
    expect(msg).toBe([
      "<b>wM</b> Safety grade downgraded to D (was C-)\nWhy: Control score fell from 69 to 45.\nOverall score 44 (was 51)",
      "<i>Via USD Top 25, USD Top 10 and your watchlist · Safety alerts</i>",
      '<a href="https://pharos.watch/stablecoin/wm-m0">View on Pharos</a>',
    ].join("\n\n"));
  });

  it("omits the footer without routing provenance and escapes untrusted text", () => {
    const msg = formatConsolidatedMessage(emptyConsolidatedAlerts({ freeze: [{
      stablecoinId: "usdt-tether", symbol: "US<b>T", eventType: "destroy", chainName: "Tr&n",
      amountUsdAtEvent: null, tapeEventId: "t", sourceEventId: "s",
    }] }));
    expect(msg).not.toContain("<i>Via");
    expect(msg).toContain("<b>US&lt;b&gt;T</b> issuer destroyed funds held by a frozen address on Tr&amp;n");
  });

  it("stacks two events by severity, puts recoveries last, and links multi-coin symbols", () => {
    const msg = formatConsolidatedMessage(emptyConsolidatedAlerts({
      depegResolved: [{ stablecoinId: "usdc-circle", symbol: "USDC", durationMinutes: 192, peakDeviationBps: 260, recoveryPrice: 0.9996 }],
      depegTriggered: [{ stablecoinId: "usde-ethena", symbol: "USDe", direction: "below", deviationBps: 120, price: 0.988, pegReference: 1 }],
    }));
    const [first, second] = msg.split("\n\n");
    expect(first).toBe('▼ <a href="https://pharos.watch/stablecoin/usde-ethena"><b>USDe</b></a> lost its peg: $0.9880, 1.2% below $1.00');
    expect(second).toBe('<a href="https://pharos.watch/stablecoin/usdc-circle"><b>USDC</b></a> is back on peg at $0.9996\nOff peg for 3h 12m · worst point 2.6% from peg');
    expect(msg).toContain('href="https://pharos.watch/depeg/"');
  });

  it("uses a count headline and compact linked family groups for three or more mixed events", () => {
    const msg = formatConsolidatedMessage(emptyConsolidatedAlerts({
      safety: [
        safetyDown("eurc-circle", "EURC", "A-", "A", 89, 94),
        safetyDown("wm-m0", "wM", "C-", "D", 51, 44),
      ],
      dews: [{ stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "WATCH", newBand: "ALERT", score: 40, topSignals: [] }],
    }), { via: { presetIds: [], watchlist: false, allStablecoins: true } });
    expect(msg.split("\n")[0]).toBe("<b>3 alerts</b>, led by \u{1F7E1} USDT stress rose to ALERT (40/100)");
    expect(msg).toContain('<b>Early-warning stress</b>\n\u{1F7E1} <a href="https://pharos.watch/stablecoin/usdt-tether"><b>USDT</b></a> stress rose to ALERT (40/100)');
    expect(msg).toContain('<b>Safety grades</b>\n<a href="https://pharos.watch/stablecoin/wm-m0"><b>wM</b></a> downgraded C- → D\n<a href="https://pharos.watch/stablecoin/eurc-circle"><b>EURC</b></a> raised A- → A');
    expect(msg).toContain("<i>Via all stablecoins · DEWS alerts and Safety alerts</i>");
    expect(msg).toContain('href="https://pharos.watch">View on Pharos</a>');
  });

  it("avoids echoing line 1, includes compact depeg prices, and routes single-family batch footers to hubs", () => {
    const depegBatch = formatConsolidatedMessage(emptyConsolidatedAlerts({
      depegTriggered: [
        { stablecoinId: "usdc-circle", symbol: "USDC", direction: "below", deviationBps: 120, price: 0.988, pegReference: 1 },
        { stablecoinId: "usde-ethena", symbol: "USDe", direction: "below", deviationBps: 180, price: 0.982, pegReference: 1 },
        { stablecoinId: "dai-makerdao", symbol: "DAI", direction: "above", deviationBps: 110, price: 1.011, pegReference: 1 },
      ],
    }));
    const [lead, rest] = depegBatch.split("\n\n");
    expect(lead).toBe('<b>3 depeg alerts</b> · worst: ▼ <a href="https://pharos.watch/stablecoin/usde-ethena"><b>USDe</b></a> $0.9820 (1.8% below)');
    expect(rest).not.toContain("USDe");
    expect(rest).toContain('▼ <a href="https://pharos.watch/stablecoin/usdc-circle"><b>USDC</b></a> $0.9880 (1.2% below)');
    expect(rest).toContain('▲ <a href="https://pharos.watch/stablecoin/dai-makerdao"><b>DAI</b></a> $1.0110 (1.1% above)');
    expect(depegBatch).toContain('href="https://pharos.watch/depeg/"');
    expect(formatConsolidatedMessage(emptyConsolidatedAlerts({
      dews: [
        { stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "CALM", newBand: "ALERT", score: 40, topSignals: [] },
        { stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "CALM", newBand: "WARNING", score: 60, topSignals: [] },
      ],
    }))).toContain('href="https://pharos.watch/stability-index/"');
    expect(formatConsolidatedMessage(emptyConsolidatedAlerts({
      safety: [safetyDown("usdc-circle", "USDC", "A", "B", 85, 70), safetyDown("usdt-tether", "USDT", "B", "D", 70, 45)],
    }))).toContain('href="https://pharos.watch/safety-scores/"');
    expect(formatConsolidatedMessage(emptyConsolidatedAlerts({
      freeze: [
        { stablecoinId: "usdc-circle", symbol: "USDC", eventType: "blacklist", chainName: "Ethereum", amountUsdAtEvent: 1_000_000, tapeEventId: "1", sourceEventId: "s1" },
        { stablecoinId: "usdt-tether", symbol: "USDT", eventType: "blacklist", chainName: "Tron", amountUsdAtEvent: 2_000_000, tapeEventId: "2", sourceEventId: "s2" },
      ],
    }))).toContain('href="https://pharos.watch/freezewatch/"');
  });

  it("orders freezes by destroy, known amount ($0 before null), size, newer timestamp, and id; collapses >4-event hourly bursts", () => {
    const mk = (id: string, extra: Partial<FreezeAlert>): FreezeAlert => ({
      stablecoinId: "usdc-circle", symbol: "USDC", eventType: "blacklist", chainName: "Ethereum",
      amountUsdAtEvent: null, tapeEventId: id, sourceEventId: `s-${id}`, ...extra,
    });
    const ordered = [
      mk("null-old", { amountUsdAtEvent: null, eventTsSec: 100 }),
      mk("zero", { amountUsdAtEvent: 0, eventTsSec: 100 }),
      mk("small-old", { amountUsdAtEvent: 500, eventTsSec: 100 }),
      mk("small-new", { amountUsdAtEvent: 500, eventTsSec: 200 }),
      mk("large", { amountUsdAtEvent: 9_000, eventTsSec: 100 }),
      mk("destroy", { eventType: "destroy", amountUsdAtEvent: null, eventTsSec: 50 }),
    ].sort(compareFreezeAlerts);
    expect(ordered.map((e) => e.tapeEventId)).toEqual(["destroy", "large", "small-new", "small-old", "zero", "null-old"]);

    const summary = formatHourlyFreezeBatchMessage(ordered, { via: { presetIds: [], watchlist: true, allStablecoins: false } });
    expect(summary.split("\n")[0]).toBe("<b>Hourly freeze summary</b>: 6 events ($10,000 known, 2 unpriced)");
    expect(summary).toContain("<i>and 3 more on Ethereum ($500 known, 1 unpriced)</i>");
    expect(summary).toContain('<a href="https://pharos.watch/freezewatch/">Pharos FreezeWatch</a>');
    expect(formatHourlyFreezeBatchMessage([mk("u1", { amountUsdAtEvent: null })]).split("\n")[0])
      .toBe("<b>Hourly freeze summary</b>: 1 event (amount unavailable)");
    const zeroBurst = formatHourlyFreezeBatchMessage([
      mk("b1", { amountUsdAtEvent: 100 }), mk("b2", { amountUsdAtEvent: 50 }), mk("b3", { amountUsdAtEvent: 25 }),
      mk("b4", { eventType: "unblacklist", amountUsdAtEvent: 0 }), mk("b5", { eventType: "unblacklist", amountUsdAtEvent: null }),
    ]);
    expect(zeroBurst).toContain("<i>and 2 more on Ethereum</i>");
    expect(zeroBurst).not.toContain("$0 known");
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

  it("places price and deviation ahead of reopen timing on close-then-reopen triggered lines", () => {
    const line = formatDepegTriggeredLine({
      stablecoinId: "bold-liquity",
      symbol: "BOLD",
      direction: "below",
      deviationBps: 230,
      price: 0.977,
      pegReference: 1.0,
      reopenedAfterMinutes: 65,
    });

    expect(line).toBe("▼ <b>BOLD</b> lost its peg: $0.9770, 2.3% below $1.00 (reopened 1h 5m after recovering)");
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

    expect(line).toContain("€0.9840, 1.6% below €1.00");
  });

  it.each([
    ["vchf-vnx", "VCHF", "CHF", 0.98, 1, "₣0.9800, 2.0% below ₣1.00"],
    ["brl-example", "BRL", "BRL", 0.98, 1, "R$0.9800, 2.0% below R$1.00"],
    ["xaut-tether", "XAUT", "GOLD", 3500, 3550, "$3500.0000, 2.0% below $3550.00"],
    ["idrt-rupiah-token", "IDRT", "USD", 0.00005718, 0.0000592, "$0.00005718, 2.0% below $0.0000592"],
  ] as const)("uses canonical currency formatting for %s", (stablecoinId, symbol, priceCurrency, price, pegReference, expected) => {
    const line = formatDepegTriggeredLine({
      stablecoinId, symbol, direction: "below",
      deviationBps: 200, price, pegReference, priceCurrency,
    });
    expect(line).toContain(expected);
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

    expect(line).toContain("XYZ 0.9800, 2.0% below XYZ 1.00");
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
    expect(line).toContain(`<blockquote expandable>${context.slice("Context: ".length)}</blockquote>`);
    expect(line).not.toContain(`\n${context}\n`);
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
      "<blockquote expandable>&lt;script&gt;alert(1)&lt;/script&gt;</blockquote>",
    );
    expect(line).not.toContain("<script>");
  });

});

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(splitMessage("short")).toEqual(["short"]);
  });

  it("preserves section separators when splitting long messages", () => {
    const sections = Array.from({ length: 100 }, (_, i) => `Section ${i} text here`);
    const long = sections.join("\n\n");
    const chunks = splitMessage(long, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    expect(chunks.join("")).toBe(long);
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
    const longText = "<b>" + "x".repeat(3990) + "</b>" + "\n\n" + "<b>second</b>";
    const chunks = splitMessage(longText, 4000);
    expect(chunks.map((chunk) => chunk.replace(/<\/?b>/g, "")).join(""))
      .toBe("x".repeat(3990) + "\n\nsecond");
    // Every chunk with a <b> must also have </b>
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(4000);
      const opens = (chunk.match(/<b>/g) ?? []).length;
      const closes = (chunk.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("preserves tags and text near hard boundaries", () => {
    // A tag near the limit must move intact, never lose its contents.
    const visible = "PREFIX" + "x".repeat(3989) + "boldSUFFIX";
    const longLine = "PREFIX" + "x".repeat(3989) + "<b>bold</b>SUFFIX";
    const chunks = splitMessage(longLine, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.replace(/<\/?b>/g, "")).join("")).toBe(visible);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(4000);
      const opens = (chunk.match(/<b>/g) ?? []).length;
      const closes = (chunk.match(/<\/b>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });

  it("balances expandable blockquotes across hard chunk boundaries", () => {
    const visible = "PREFIX" + "context ".repeat(900) + "SUFFIX";
    const longContext = `<blockquote expandable>${visible}</blockquote>`;
    const chunks = splitMessage(longContext, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.replace(/<\/?blockquote(?: expandable)?>/g, "")).join("")).toBe(visible);
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
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(4000);
      const opens = countBlockquoteOpen(chunk);
      const closes = (chunk.match(/<\/blockquote>/g) ?? []).length;
      expect(opens).toBe(closes);
      const lastOpen = chunk.lastIndexOf("<blockquote");
      const hasDanglingOpen = lastOpen !== -1 ? chunk.indexOf(">", lastOpen) === -1 : false;
      expect(hasDanglingOpen).toBe(false);
      expect(chunk).not.toMatch(/^expandable>/);
    }
  });

  function decodeValidChunk(chunk: string): string {
    const stack: string[] = [];
    const text = chunk.replace(/<[^>]*>/g, (raw) => {
      const tag = raw.match(/^<(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)[^>]*>$/);
      expect(tag, `Malformed tag: ${raw}`).not.toBeNull();
      if (tag![1]) expect(stack.pop(), `Misnested tag: ${raw}`).toBe(tag![2].toLowerCase());
      else stack.push(tag![2].toLowerCase());
      return "";
    });
    expect(stack, "Every chunk closes its own tags").toEqual([]);
    expect(text).not.toMatch(/[<>]|&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    return text.replace(/&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      return named[entity] ?? String.fromCodePoint(entity.startsWith("#x")
        ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    });
  }

  it.each(["", "b"])("keeps boundary separators with visible text (%s)", (tag) => {
    const text = "x".repeat(tag ? 3992 : 3999) + "\n\n" + "y".repeat(4000);
    const html = tag ? `<${tag}>${text}</${tag}>` : text;
    const chunks = splitMessage(html, 4000);
    const rendered = chunks.map(decodeValidChunk);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(rendered.every((chunk) => chunk.trim().length > 0)).toBe(true);
    expect(rendered.join("")).toBe(text);
  });

  it.each([" \n\t", "<b>\n\n</b>", "&#10;&#32;", "&#xA;&#x20;"])(
    "rejects content without non-whitespace rendered text rather than emitting it: %s",
    (html) => {
      expect(() => splitMessage(html)).toThrow(RangeError);
    },
  );

  it.each(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "tg-spoiler"])(
    "keeps independently valid multiline %s spans and all decoded text",
    (tag) => {
      const text = "first line\nsecond line\n\nthird line\n".repeat(12);
      const chunks = splitMessage(`<${tag}>${text}</${tag}>`, 96);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= 96)).toBe(true);
      expect(chunks.map(decodeValidChunk).join("")).toBe(text);
      expect(chunks.every((chunk) => chunk.startsWith(`<${tag}>`))).toBe(true);
    },
  );

  it("reopens nested links and expandable blockquotes in order with their attributes", () => {
    const open = '<blockquote expandable><b><a href="https://pharos.watch/?a=1&amp;b=2"><i>';
    const text = "line one\nline two\n\nline three\n".repeat(20);
    const chunks = splitMessage(`${open}${text}</i></a></b></blockquote>`, 180);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 180 && chunk.startsWith(open))).toBe(true);
    expect(chunks.map(decodeValidChunk).join("")).toBe(text);
  });

  it.each([17, 18, 19, 20, 21, 22, 23])("keeps entities and surrogate pairs indivisible at limit %i", (limit) => {
    const encoded = "x&amp;&lt;&gt;&quot;&apos;&#128640;&#x1F680;\u{1F680}".repeat(20);
    const chunks = splitMessage(`<b>${encoded}</b>`, limit);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= limit)).toBe(true);
    expect(chunks.map(decodeValidChunk).join("")).toBe("x&<>\"'\u{1F680}\u{1F680}\u{1F680}".repeat(20));
  });

  it("makes bounded forward progress while preserving a deep but representable tag envelope", () => {
    const text = "payload ".repeat(1200);
    const chunks = splitMessage(`${"<b>".repeat(100)}${text}${"</b>".repeat(100)}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks.map(decodeValidChunk).join("")).toBe(text);
  });

  it("fails rather than dropping an indivisible token or its formatting context", () => {
    expect(() => splitMessage("&amp; rest", 4)).toThrow(RangeError);
    expect(() => splitMessage("<b>\u{1F680}</b>suffix", 8)).toThrow(RangeError);
    expect(() => splitMessage('<a href="https://pharos.watch/">text</a>', 20)).toThrow(RangeError);
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


  it("keeps single-coin callback_data within 64 bytes for the longest tracked stablecoin id", () => {
    const longestId = Array.from(TRACKED_META_BY_ID.keys()).reduce((a, b) => (b.length > a.length ? b : a));
    const markup = buildAlertReplyMarkup(singleCoinAlerts(longestId), 0);
    expect(collectCallbackData(markup)).toContain(`settings:o:${longestId}`);
    for (const data of collectCallbackData(markup)) {
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }
  });

  it("offers Snooze top coin 24h, Pause all 4h, and Manage Alerts (no step-down) on a multi-coin first chunk", () => {
    const multiCoin: ConsolidatedAlerts = emptyConsolidatedAlerts({ dews: [
      { stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "CALM", newBand: "WARNING", score: 42, topSignals: [] },
      { stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "CALM", newBand: "ALERT", score: 50, topSignals: [] },
    ] });
    const markup = buildAlertReplyMarkup(multiCoin, 0, { privateChat: true });
    expect(markup.inline_keyboard.length).toBe(2);
    // Top coin (USDC, WARNING) ranks above USDT (ALERT). Multi-coin omits step-down.
    expect(collectCallbackData(markup)).toEqual(["coinsnooze:usdc-circle:24h", "snooze:4h"]);
    expect(collectButtonText(markup)).toEqual(["Snooze USDC 24h", "Pause all 4h", "Manage Alerts"]);
    expect(JSON.stringify(markup)).toContain("web_app");
  });

  it("drops step-down buttons on multi-coin group alerts and uses Group settings", () => {
    const mixed: ConsolidatedAlerts = emptyConsolidatedAlerts({
      depegTriggered: [{ stablecoinId: "usde-ethena", symbol: "USDe", direction: "below", deviationBps: 120, price: 0.988, pegReference: 1 }],
      safety: [
        { stablecoinId: "wm-m0", symbol: "wM", oldGrade: "C-", newGrade: "D", oldScore: 51, newScore: 44 },
        { stablecoinId: "usdc-circle", symbol: "USDC", oldGrade: "A", newGrade: "B", oldScore: 88, newScore: 74 },
      ],
    });
    const markup = buildAlertReplyMarkup(mixed, 0);
    const callbacks = collectCallbackData(markup);
    expect(callbacks).toEqual(["coinsnooze:usde-ethena:24h", "snooze:4h", "settings:home"]);
    expect(collectButtonText(markup)).toEqual(["Snooze USDe 24h", "Pause all 4h", "Group settings"]);
    expect(JSON.stringify(markup)).not.toContain("web_app");
  });

  it.each([
    [{ "depeg:usde-ethena": 100 }, "fewer:usde-ethena:ds:250", "USDe: from 2.5%"],
    [{ "depeg:usde-ethena": 250 }, "fewer:usde-ethena:ds:500", "USDe: from 5%"],
    [{ "depeg:usde-ethena": 500 }, null, null],
    // No step in effect: never emit a one-tap permanent-Off button.
    [{ "depeg:usde-ethena": null }, null, null],
    [undefined, null, null],
  ] as const)("emits non-Off depeg step-down only when a quieter step exists for %j", (fewerBase, expectedCallback, expectedLabel) => {
    const depeg = emptyConsolidatedAlerts({
      depegTriggered: [{ stablecoinId: "usde-ethena", symbol: "USDe", direction: "below", deviationBps: 120, price: 0.988, pegReference: 1 }],
    });
    const markup = buildAlertReplyMarkup(depeg, 0, { privateChat: true, fewerBase });
    const callbacks = collectCallbackData(markup);
    const labels = collectButtonText(markup);
    if (expectedCallback && expectedLabel) {
      expect(callbacks).toContain(expectedCallback);
      expect(labels).toEqual(["Snooze USDe 24h", "Pause all 4h", expectedLabel, "Manage USDe"]);
    } else {
      expect(callbacks.some((c) => c.startsWith("fewer:"))).toBe(false);
      expect(labels).toEqual(["Snooze USDe 24h", "Pause all 4h", "Manage USDe"]);
    }
  });

  it("raises the DEWS floor with explicit <=22-char labels and never emits permanent Off", () => {
    const dews = emptyConsolidatedAlerts({ dews: [
      { stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "ALERT", newBand: "DANGER", score: 80, topSignals: [] },
    ] });
    const warn = buildAlertReplyMarkup(dews, 0, { fewerBase: { "dews:usdc-circle": "ALERT" } });
    expect(collectCallbackData(warn)).toContain("fewer:usdc-circle:db:W");
    expect(collectButtonText(warn)).toEqual(["Snooze USDC 24h", "Pause all 4h", "USDC: Warning+", "Settings: USDC"]);

    const danger = buildAlertReplyMarkup(dews, 0, { privateChat: true, fewerBase: { "dews:usdc-circle": "WARNING" } });
    expect(collectCallbackData(danger)).toContain("fewer:usdc-circle:db:D");
    expect(collectButtonText(danger)).toEqual(["Snooze USDC 24h", "Pause all 4h", "USDC: Danger only", "Manage USDC"]);

    const atFloor = buildAlertReplyMarkup(dews, 0, { privateChat: true, fewerBase: { "dews:usdc-circle": "DANGER" } });
    expect(collectCallbackData(atFloor).some((c) => c.startsWith("fewer:"))).toBe(false);
    expect(collectButtonText(atFloor)).toEqual(["Snooze USDC 24h", "Pause all 4h", "Manage USDC"]);

    const longSym = emptyConsolidatedAlerts({ dews: [
      { stablecoinId: "usdc-circle", symbol: "SUPERLONGSYMBOL", oldBand: "ALERT", newBand: "DANGER", score: 80, topSignals: [] },
    ] });
    const longStepLabel = collectButtonText(buildAlertReplyMarkup(longSym, 0, { fewerBase: { "dews:usdc-circle": "WARNING" } }))[2]!;
    expect(longStepLabel.length).toBeLessThanOrEqual(22);
  });

  it("keeps only the chat-wide pause on overflow chunks", () => {
    const multiCoin: ConsolidatedAlerts = emptyConsolidatedAlerts({ dews: [
      { stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "CALM", newBand: "WARNING", score: 42, topSignals: [] },
      { stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "CALM", newBand: "ALERT", score: 50, topSignals: [] },
    ] });
    expect(collectCallbackData(buildAlertReplyMarkup(multiCoin, 1))).toEqual(["snooze:4h"]);
    expect(collectCallbackData(buildAlertReplyMarkup(singleCoinAlerts("usdc-circle"), 1))).toEqual(["snooze:4h"]);
  });

  it("never emits the retired Status, Depeg 250 or Safety buttons", () => {
    const json = JSON.stringify(buildAlertReplyMarkup(singleCoinAlerts("usdc-circle"), 0, { privateChat: true }));
    expect(json).not.toMatch(/"(status|depegstep|safetydown):/);
  });

  it("keeps multi-coin callback_data within 64 bytes for the longest ids without emitting fewer", () => {
    const ids = Array.from(TRACKED_META_BY_ID.keys());
    const sorted = [...ids].sort((a, b) => b.length - a.length);
    const [a, b] = sorted;
    const multiCoin: ConsolidatedAlerts = emptyConsolidatedAlerts({ dews: [
      { stablecoinId: a, symbol: "AAA", oldBand: "CALM", newBand: "ALERT", score: 10, topSignals: [] },
      { stablecoinId: b, symbol: "BBB", oldBand: "CALM", newBand: "WARNING", score: 10, topSignals: [] },
    ] });
    const markup = buildAlertReplyMarkup(multiCoin, 0);
    const callbacks = collectCallbackData(markup);
    expect(callbacks.some((c) => c.startsWith("coinsnooze:"))).toBe(true);
    expect(callbacks.some((c) => c.startsWith("fewer:"))).toBe(false);
    for (const data of callbacks) {
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }
  });
});

describe("resolveAlertLinkPreviewOptions", () => {

  function multiCoinAlerts(): ConsolidatedAlerts {
    return emptyConsolidatedAlerts({ dews: [
      { stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "CALM", newBand: "ALERT", score: 42, topSignals: [] },
      { stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "CALM", newBand: "ALERT", score: 50, topSignals: [] },
    ] });
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

it("rejects impossible nested envelopes without discarding formatting and rejects invalid limits", () => {
  const html = "<b>".repeat(1500) + "payload" + "</b>".repeat(1500);
  expect(() => splitMessage(html)).toThrow(RangeError);
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => splitMessage("x", limit)).toThrow(RangeError);
  }
});
