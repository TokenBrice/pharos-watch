import { describe, expect, it } from "vitest";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  fingerprintReportCardRegistryRows,
  type ReportCardRegistryRows,
} from "../lib/report-card-registry-fingerprint";

function registryRows(
  activeIds: string[],
  frozenIds: string[],
  deadIds: string[],
): ReportCardRegistryRows {
  return {
    activeStablecoins: activeIds.map((id) => ({ id })),
    frozenStablecoins: frozenIds.map((id) => ({ id })),
    deadStablecoins: deadIds.map((id) => ({ id })),
  } as unknown as ReportCardRegistryRows;
}

describe("report-card registry fingerprint", () => {
  it("orders registry rows by locale-independent code units", () => {
    const rows = registryRows(["a", "ä", "Z", "A"], ["z", "B"], ["é", "e"]);
    const expected = sha256Hex(stableJsonStringifyV1({
      domain: "report-cards.fixed-input.registry.v1",
      activeStablecoins: [{ id: "A" }, { id: "Z" }, { id: "a" }, { id: "ä" }],
      frozenStablecoins: [{ id: "B" }, { id: "z" }],
      deadStablecoins: [{ id: "e" }, { id: "é" }],
    }));

    expect(fingerprintReportCardRegistryRows(rows)).toBe(expected);
    expect(fingerprintReportCardRegistryRows(registryRows(
      ["Z", "A", "ä", "a"],
      ["B", "z"],
      ["e", "é"],
    ))).toBe(expected);
  });
});
