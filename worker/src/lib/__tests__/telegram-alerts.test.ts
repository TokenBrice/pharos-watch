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
    expect(result.tickers).toEqual(["USDC", "BOLD"]);
  });

  it("is order-independent", () => {
    const result = parseSubscribeArgs("USDC dews BOLD depeg");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg"]));
    expect(result.tickers).toEqual(["USDC", "BOLD"]);
  });

  it("handles all three types", () => {
    const result = parseSubscribeArgs("dews depeg safety USDT");
    expect(result.alertTypes).toEqual(new Set(["dews", "depeg", "safety"]));
  });

  it("classifies unknown tokens as invalidTypes", () => {
    const result = parseSubscribeArgs("foo dews USDC");
    expect(result.alertTypes).toEqual(new Set(["dews"]));
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTypes).toEqual(["foo"]);
  });

  it("classifies completely unknown tokens when no types present", () => {
    const result = parseSubscribeArgs("foo USDC");
    expect(result.alertTypes.size).toBe(0);
    expect(result.tickers).toEqual(["USDC"]);
    expect(result.invalidTypes).toEqual(["foo"]);
  });
});

describe("validateSubscribeArgs", () => {
  it("returns null for valid args", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      tickers: ["USDC"],
      invalidTypes: [],
    });
    expect(result).toBeNull();
  });

  it("returns error when no types", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(),
      tickers: ["USDC"],
      invalidTypes: [],
    });
    expect(result).toContain("alert type");
  });

  it("returns error when no tickers", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      tickers: [],
      invalidTypes: [],
    });
    expect(result).toContain("ticker");
  });

  it("returns unknown alert type error when no types and invalidTypes present", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(),
      tickers: ["USDC"],
      invalidTypes: ["foo"],
    });
    expect(result).toContain("Unknown alert type: foo");
    expect(result).toContain("Valid types");
  });

  it("returns unknown ticker error when types present and invalidTypes present", () => {
    const result = validateSubscribeArgs({
      alertTypes: new Set(["dews"]),
      tickers: [],
      invalidTypes: ["XYZZY"],
    });
    expect(result).toContain("Unknown ticker: XYZZY");
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
      safety: [],
    });
    expect(msg).toContain("DEWS");
    expect(msg).toContain("Depeg Detected");
    expect(msg).toContain("Pharos Alerts");
    expect(msg).toContain("View on Pharos");
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
      { dews: true, depeg: true, safety: false },
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
    const output = formatListOutput({ dews: false, depeg: false, safety: false }, []);
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
