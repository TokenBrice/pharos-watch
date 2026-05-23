import { describe, expect, it } from "vitest";
import {
  buildMicaViewModel,
  normalizeMicaStatusFilter,
  normalizeMicaTokenTypeFilter,
} from "./model";

describe("MiCA model", () => {
  it("builds current MiCA rows without frozen assets and preserves all references", () => {
    const { rows } = buildMicaViewModel({
      status: "all",
      tokenType: "all",
      peg: "all",
      search: "",
    });

    expect(rows.some((row) => row.id === "euroe-membrane")).toBe(false);
    expect(rows.find((row) => row.id === "usdt-tether")?.references.length).toBeGreaterThan(1);
  });

  it("filters by status, token type, peg, and search", () => {
    const { rows } = buildMicaViewModel({
      status: "authorized",
      tokenType: "EMT",
      peg: "EUR",
      search: "eur",
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "authorized")).toBe(true);
    expect(rows.every((row) => row.tokenType === "EMT")).toBe(true);
    expect(rows.every((row) => row.peg === "EUR")).toBe(true);
    expect(rows.every((row) => `${row.name} ${row.symbol}`.toLowerCase().includes("eur"))).toBe(true);
  });

  it("normalizes unknown URL filter values to all", () => {
    expect(normalizeMicaStatusFilter("bogus")).toBe("all");
    expect(normalizeMicaTokenTypeFilter("bogus")).toBe("all");
  });
});
