import { describe, expect, it } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import type {
  PegSummaryResponse,
  StressSignalsAllResponse,
} from "@shared/types/market";
import {
  buildCurrentMap,
  extractFindings,
  type Current,
} from "../build-ai-summary-staleness-candidates";
import { buildMaintenanceApiRequest } from "../../lib/maintenance-api";

describe("maintenance API access", () => {
  it("builds an authenticated request to the public API", () => {
    const request = buildMaintenanceApiRequest(API_PATHS.reportCardsV9(), "test-api-key");

    expect(request).toEqual({
      url: `${API_ORIGIN}/api/report-cards/v9`,
      headers: {
        accept: "application/json",
        "X-API-Key": "test-api-key",
      },
    });
    expect(request.headers).not.toHaveProperty("Origin");
  });

  it("rejects live requests without an API credential", () => {
    expect(() => buildMaintenanceApiRequest(API_PATHS.events(), "  ")).toThrow(
      "PHAROS_API_KEY is required",
    );
  });
});

describe("AI summary V9 current-value projection", () => {
  it("uses the current report-card pillars and peg-summary identity", () => {
    const cards = [{
      id: "usdt-tether",
      grade: "B+",
      score: 75,
      pillars: {
        backing: { score: 85 },
        exit: { score: 55 },
        control: { score: 45 },
      },
    }] as unknown as ReportCardsV9CurrentResponse["cards"];
    const stress = {
      "usdt-tether": { band: "WATCH", score: 23 },
    } as unknown as StressSignalsAllResponse["signals"];
    const peg = [{
      id: "usdt-tether",
      name: "Wrong fallback name",
      symbol: "WRONG",
      pegScore: 92,
      eventCount: 8,
    }] as unknown as PegSummaryResponse["coins"];

    expect(buildCurrentMap(cards, stress, peg).get("usdt-tether")).toEqual({
      name: "Tether",
      symbol: "USDT",
      overallGrade: "B+",
      overallScore: 75,
      pegGrade: "A+",
      pegScore: 92,
      backingGrade: "A",
      backingScore: 85,
      exitGrade: "C",
      exitScore: 55,
      controlGrade: "D",
      controlScore: 45,
      dewsBand: "WATCH",
      dewsScore: 23,
      depegCount: 8,
    });
  });

  it("compares V9 pillar claims and flags retired V8 dimension vocabulary", () => {
    const current: Current = {
      name: "Test Coin",
      symbol: "TEST",
      overallGrade: "B+",
      overallScore: 75,
      pegGrade: "A+",
      pegScore: 92,
      backingGrade: "A",
      backingScore: 85,
      exitGrade: "C",
      exitScore: 55,
      controlGrade: "D",
      controlScore: 45,
      dewsBand: "WATCH",
      dewsScore: 23,
      depegCount: 8,
    };

    const findings = extractFindings(
      "It has an A safety grade at 90, backing grade of B, exit grade of A, " +
        "economic control grade of C, dependency risk grade of D, and a liquidity score of 72.",
      current,
    );

    expect(findings.map((finding) => finding.kind)).toEqual(expect.arrayContaining([
      "overall-grade",
      "overall-score",
      "backing-grade",
      "exit-grade",
      "control-grade",
      "legacy-dependency-grade",
      "legacy-liquidity-score",
    ]));
    expect(findings.filter((finding) => finding.kind.startsWith("legacy-"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ current: "retired in Safety Score v9", severity: "medium" }),
      ]),
    );
  });
});
