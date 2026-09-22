import { describe, it, expect } from "vitest";
import { emptyConsolidatedAlerts, singleCoinAlerts } from "./telegram-alerts.test-support";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  formatDisambiguation,
  formatDewsLine,
  formatDepegTriggeredLine,
  formatDepegWorseningLine,
  formatLaunchLine,
  formatConsolidatedMessage,
  splitMessage,
  isDewsAlertable,
  isDewsDeescalation,
  buildAlertReplyMarkup,
  rankAlertCoins,
  resolveAlertLinkPreviewOptions,
  SNOOZE_REPLY_MARKUP,
  type ConsolidatedAlerts,
} from "../telegram/alerts-formatting";

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
    const alerts: ConsolidatedAlerts = emptyConsolidatedAlerts({ reserve: [
      {
        stablecoinId: "usdc-circle",
        symbol: "USDC",
        name: "Circle USD Coin",
      },
    ] });

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
    expect(msg).toContain("Depeg Worsening");
    expect(msg).toContain("1.2% → 2.6%");
  });

  it("links to coin page when all alerts are for a single coin", () => {
    const msg = formatConsolidatedMessage(emptyConsolidatedAlerts({ dews: [
      {
        stablecoinId: "usdc-circle",
        symbol: "USDC",
        oldBand: "CALM",
        newBand: "ALERT",
        score: 42,
        topSignals: [],
      },
    ] }));
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

  it.each([
    ["vchf-vnx", "VCHF", "CHF", 0.98, 1, "Price: ₣0.9800 (peg: ₣1.00)"],
    ["brl-example", "BRL", "BRL", 0.98, 1, "Price: R$0.9800 (peg: R$1.00)"],
    ["xaut-tether", "XAUT", "GOLD", 3500, 3550, "Price: $3500.0000 (peg: $3550.00)"],
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
    const msg = formatConsolidatedMessage(emptyConsolidatedAlerts({ dews: [{
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      oldBand: "WATCH",
      newBand: "ALERT",
      score: 42,
      topSignals: [],
      contextLine: context,
    }] }));
    expect(msg).toContain(`<blockquote expandable>${context}</blockquote>`);
  });
});

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(splitMessage("short")).toEqual(["short"]);
  });

  it("splits long messages at section boundaries", () => {
    const sections = Array.from({ length: 100 }, (_, i) => `Section ${i} text here`);
    const long = sections.join("\n\n");
    const chunks = splitMessage(long, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    expect(chunks.join("\n\n")).toBe(long);
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
    expect(chunks.map((chunk) => chunk.replace(/<\/?b>/g, "")).join("\n\n"))
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

  it("strips tags from chunks that would have broken HTML", () => {
    // A single long line that forces character-boundary splitting mid-tag
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
    const multiCoin: ConsolidatedAlerts = emptyConsolidatedAlerts({ dews: [
      { stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "CALM", newBand: "WARNING", score: 42, topSignals: [] },
      { stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "CALM", newBand: "ALERT", score: 50, topSignals: [] },
    ] });
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
    const multiCoin: ConsolidatedAlerts = emptyConsolidatedAlerts({ dews: [
      { stablecoinId: "usdc-circle", symbol: "USDC", oldBand: "CALM", newBand: "WARNING", score: 42, topSignals: [] },
      { stablecoinId: "usdt-tether", symbol: "USDT", oldBand: "CALM", newBand: "ALERT", score: 50, topSignals: [] },
    ] });
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
    const multiCoin: ConsolidatedAlerts = emptyConsolidatedAlerts({ dews: [
      { stablecoinId: a, symbol: "AAA", oldBand: "CALM", newBand: "ALERT", score: 10, topSignals: [] },
      { stablecoinId: b, symbol: "BBB", oldBand: "CALM", newBand: "WARNING", score: 10, topSignals: [] },
    ] });
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
  it("ranks a depeg bps severity above a DEWS WATCH band", () => {
    const ranked = rankAlertCoins({
      ...emptyConsolidatedAlerts(),
      dews: [{ stablecoinId: "a", symbol: "A", oldBand: "CALM", newBand: "WATCH", score: 1, topSignals: [] }],
      depegTriggered: [
        { stablecoinId: "b", symbol: "B", direction: "below", deviationBps: 300, price: 0.97, pegReference: 1 },
      ],
    });
    expect(ranked.map((c) => c.stablecoinId)).toEqual(["b", "a"]);
  });

  it("ranks a DANGER DEWS band above a WARNING DEWS band", () => {
    const ranked = rankAlertCoins({
      ...emptyConsolidatedAlerts(),
      dews: [
        { stablecoinId: "warn", symbol: "W", oldBand: "CALM", newBand: "WARNING", score: 1, topSignals: [] },
        { stablecoinId: "danger", symbol: "D", oldBand: "CALM", newBand: "DANGER", score: 1, topSignals: [] },
      ],
    });
    expect(ranked.map((c) => c.stablecoinId)).toEqual(["danger", "warn"]);
  });

  it("dedupes a coin appearing in multiple families, keeping its highest severity", () => {
    const ranked = rankAlertCoins({
      ...emptyConsolidatedAlerts(),
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
      ...emptyConsolidatedAlerts(),
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

it("splits deeply nested HTML with forward progress and rejects invalid limits", () => {
  const html = "<b>".repeat(1500) + "payload" + "</b>".repeat(1500);
  const chunks = splitMessage(html);
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
  expect(() => splitMessage("x", 0)).toThrow(RangeError);
});
