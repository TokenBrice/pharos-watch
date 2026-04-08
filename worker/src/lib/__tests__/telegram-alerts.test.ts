import { describe, it, expect } from "vitest";
import {
  resolveTicker,
  parseSubscribeArgs,
  validateSubscribeArgs,
  formatDisambiguation,
  parseDisambiguationReply,
  formatConsolidatedMessage,
  splitMessage,
  formatListOutput,
  isDewsAlertable,
  isDewsDeescalation,
} from "../telegram-alerts";

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
});

describe("parseSubscribeArgs", () => {
  it("separates alert types from tickers", () => {
    const result = parseSubscribeArgs("dews depeg USDC BOLD");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg"]));
    expect(result.subscribeAll).toBe(false);
    expect(result.tickers).toEqual(["USDC", "BOLD"]);
  });

  it("is order-independent", () => {
    const result = parseSubscribeArgs("USDC dews BOLD depeg");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg"]));
    expect(result.subscribeAll).toBe(false);
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
    expect(result.tickers).toEqual([]);
    expect(result.invalidTypes).toEqual([]);
  });

  it("classifies unknown tokens as invalidTypes", () => {
    const result = parseSubscribeArgs("foo dews USDC");
    expect(result.alertTypes).toEqual(new Set(["dews"]));
    expect(result.subscribeAll).toBe(false);
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTypes).toEqual(["foo"]);
  });

  it("classifies completely unknown tokens when no types present", () => {
    const result = parseSubscribeArgs("foo USDC");
    expect(result.alertTypes.size).toBe(0);
    expect(result.subscribeAll).toBe(false);
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTypes).toEqual(["foo"]);
  });

  it("handles comma-separated alert types", () => {
    const result = parseSubscribeArgs("dews,depeg USDC");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg"]));
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTypes).toEqual([]);
  });
});

describe("validateSubscribeArgs", () => {
  it("returns null for valid args", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      subscribeAll: false,
      tickers: ["USDC"],
      invalidTypes: [],
    });
    expect(result).toBeNull();
  });

  it("returns error when no types", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(),
      subscribeAll: false,
      tickers: ["USDC"],
      invalidTypes: [],
    });
    expect(result).toContain("alert type");
  });

  it("returns error when no tickers", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      subscribeAll: false,
      tickers: [],
      invalidTypes: [],
    });
    expect(result).toContain("ticker");
  });

  it("returns unknown alert type error when no types and invalidTypes present", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(),
      subscribeAll: false,
      tickers: ["USDC"],
      invalidTypes: ["foo"],
    });
    expect(result).toContain("Unknown alert type: foo");
    expect(result).toContain("Valid types");
  });

  it("returns unknown ticker error when types present and invalidTypes present", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      subscribeAll: false,
      tickers: [],
      invalidTypes: ["XYZZY"],
    });
    expect(result).toContain("Unknown ticker: XYZZY");
  });

  it("rejects mixing all with explicit tickers", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      subscribeAll: true,
      tickers: ["USDC"],
      invalidTypes: [],
    });
    expect(result).toContain('either "all" or specific tickers');
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
    });
    expect(msg).toContain("DEWS");
    expect(msg).toContain("Depeg Detected");
    expect(msg).toContain("Pharos Alerts");
    expect(msg).toContain("View on Pharos");
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
    });
    expect(msg).toContain('href="https://pharos.watch"');
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
});
