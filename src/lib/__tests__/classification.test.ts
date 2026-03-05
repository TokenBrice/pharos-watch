import { describe, it, expect } from "vitest";
import {
  GOVERNANCE_LABELS,
  GOVERNANCE_LABELS_SHORT,
  BACKING_LABELS,
  BACKING_LABELS_SHORT,
  PEG_LABELS,
  PEG_LABELS_SHORT,
  PEG_CURRENCY_COUNT,
  GOVERNANCE_COLORS,
  BACKING_COLORS,
} from "@shared/lib/classification";

// ---------------------------------------------------------------------------
// GOVERNANCE_LABELS
// ---------------------------------------------------------------------------
describe("GOVERNANCE_LABELS", () => {
  it('has an entry for "centralized"', () => {
    expect(GOVERNANCE_LABELS.centralized).toBe("Centralized (CeFi)");
  });

  it('has an entry for "centralized-dependent"', () => {
    expect(GOVERNANCE_LABELS["centralized-dependent"]).toBe("CeFi-Dependent");
  });

  it('has an entry for "decentralized"', () => {
    expect(GOVERNANCE_LABELS.decentralized).toBe("Decentralized (DeFi)");
  });

  it("has exactly 3 keys", () => {
    expect(Object.keys(GOVERNANCE_LABELS)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// GOVERNANCE_LABELS_SHORT
// ---------------------------------------------------------------------------
describe("GOVERNANCE_LABELS_SHORT", () => {
  it("has the same keys as GOVERNANCE_LABELS", () => {
    expect(Object.keys(GOVERNANCE_LABELS_SHORT).sort()).toEqual(
      Object.keys(GOVERNANCE_LABELS).sort()
    );
  });

  it("has short-form values", () => {
    expect(GOVERNANCE_LABELS_SHORT.centralized).toBe("CeFi");
    expect(GOVERNANCE_LABELS_SHORT["centralized-dependent"]).toBe("CeFi-Dep");
    expect(GOVERNANCE_LABELS_SHORT.decentralized).toBe("DeFi");
  });
});

// ---------------------------------------------------------------------------
// BACKING_LABELS
// ---------------------------------------------------------------------------
describe("BACKING_LABELS", () => {
  it('has an entry for "rwa-backed"', () => {
    expect(BACKING_LABELS["rwa-backed"]).toBe("Real-World Asset Backed");
  });

  it('has an entry for "crypto-backed"', () => {
    expect(BACKING_LABELS["crypto-backed"]).toBe("Crypto-Collateralized");
  });

  it('has an entry for "algorithmic"', () => {
    expect(BACKING_LABELS.algorithmic).toBe("Algorithmic");
  });

  it("has exactly 3 keys", () => {
    expect(Object.keys(BACKING_LABELS)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// BACKING_LABELS_SHORT
// ---------------------------------------------------------------------------
describe("BACKING_LABELS_SHORT", () => {
  it("has the same keys as BACKING_LABELS", () => {
    expect(Object.keys(BACKING_LABELS_SHORT).sort()).toEqual(
      Object.keys(BACKING_LABELS).sort()
    );
  });
});

// ---------------------------------------------------------------------------
// PEG_LABELS
// ---------------------------------------------------------------------------
describe("PEG_LABELS", () => {
  it("has entries for common currencies", () => {
    expect(PEG_LABELS.USD).toBe("the US Dollar");
    expect(PEG_LABELS.EUR).toBe("the Euro");
    expect(PEG_LABELS.GBP).toBe("the British Pound");
  });

  it("has entries for commodity pegs", () => {
    expect(PEG_LABELS.GOLD).toBe("Gold");
    expect(PEG_LABELS.SILVER).toBe("Silver");
  });

  it("has entries for less common currencies", () => {
    expect(PEG_LABELS.JPY).toBe("the Japanese Yen");
    expect(PEG_LABELS.BRL).toBe("the Brazilian Real");
    expect(PEG_LABELS.IDR).toBe("the Indonesian Rupiah");
  });
});

// ---------------------------------------------------------------------------
// PEG_LABELS_SHORT
// ---------------------------------------------------------------------------
describe("PEG_LABELS_SHORT", () => {
  it("has the same keys as PEG_LABELS", () => {
    expect(Object.keys(PEG_LABELS_SHORT).sort()).toEqual(
      Object.keys(PEG_LABELS).sort()
    );
  });
});

// ---------------------------------------------------------------------------
// PEG_CURRENCY_COUNT
// ---------------------------------------------------------------------------
describe("PEG_CURRENCY_COUNT", () => {
  it("is a positive number", () => {
    expect(PEG_CURRENCY_COUNT).toBeGreaterThan(0);
  });

  it("is an integer", () => {
    expect(Number.isInteger(PEG_CURRENCY_COUNT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Color maps exist and have matching keys
// ---------------------------------------------------------------------------
describe("Color maps", () => {
  it("GOVERNANCE_COLORS has the same keys as GOVERNANCE_LABELS", () => {
    expect(Object.keys(GOVERNANCE_COLORS).sort()).toEqual(
      Object.keys(GOVERNANCE_LABELS).sort()
    );
  });

  it("BACKING_COLORS has the same keys as BACKING_LABELS", () => {
    expect(Object.keys(BACKING_COLORS).sort()).toEqual(
      Object.keys(BACKING_LABELS).sort()
    );
  });

  it("all GOVERNANCE_COLORS values are non-empty strings", () => {
    for (const v of Object.values(GOVERNANCE_COLORS)) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it("all BACKING_COLORS values are non-empty strings", () => {
    for (const v of Object.values(BACKING_COLORS)) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
    }
  });
});
