import { describe, expect, it } from "vitest";
import { parseReserveCompositionRow } from "../live-reserves/store-row-decoding";

function row(slices: unknown[]) {
  return {
    stablecoin_id: "iusd-infinifi",
    slices: JSON.stringify(slices),
    fetched_at: 1_700_000_000,
    source: "infinifi",
    metadata: "{}",
    warnings: null,
    warning_count: 0,
    adapter_source_model: "dynamic-mix",
    adapter_evidence_class: "independent",
  } as never;
}

describe("stored live reserve dependency validation", () => {
  it.each([
    ["self target", [{ name: "Self", pct: 100, risk: "low", coinId: "iusd-infinifi" }]],
    ["unknown target", [{ name: "Unknown", pct: 100, risk: "low", coinId: "not-tracked" }]],
    ["depType without target", [{ name: "Missing", pct: 100, risk: "low", depType: "mechanism" }]],
  ])("rejects %s on D1 read", (_label, slices) => {
    expect(parseReserveCompositionRow(row(slices), null)).toEqual({
      record: null,
      issue: {
        code: "invalid-slice",
        message: "stored reserve snapshot contains invalid slice entries",
      },
    });
  });

  it("accepts a known tracked dependency target", () => {
    const parsed = parseReserveCompositionRow(
      row([{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle", depType: "collateral" }]),
      null,
    );
    expect(parsed.issue).toBeNull();
    expect(parsed.record?.slices[0]).toMatchObject({ coinId: "usdc-circle", depType: "collateral" });
  });
});
