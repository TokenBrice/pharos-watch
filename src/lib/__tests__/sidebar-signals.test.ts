import { describe, expect, it } from "vitest";
import type {
  BlacklistSummaryResponse,
  HealthResponse,
  PegSummaryResponse,
  StabilityIndexResponse,
} from "@shared/types";
import {
  getBlacklistNavSignal,
  getDepegNavSignal,
  getDigestNavSignal,
  getStabilityIndexNavSignal,
  getStatusNavSignal,
  hasUnreadDigest,
  parseSidebarDigestSeenAt,
} from "@/lib/sidebar-signals";

describe("sidebar-signals", () => {
  it("shows the active depeg count only when incidents are live", () => {
    const response = {
      summary: { activeDepegCount: 3 },
    } as PegSummaryResponse;

    expect(getDepegNavSignal(response)).toEqual({
      kind: "badge",
      text: "3",
      title: "3 active depeg incidents",
      tone: "danger",
    });
    expect(getDepegNavSignal({ summary: { activeDepegCount: 0 } } as PegSummaryResponse)).toBeNull();
  });

  it("uses the displayed PSI score and severity tone", () => {
    const response = {
      current: {
        score: 82.4,
        band: "BEDROCK",
        avg24h: 77.2,
        avg24hBand: "TREMOR",
        computedAt: 1_777_000_000,
        components: { severity: 0, breadth: 0, trend: 0 },
        methodologyVersion: "1.0",
      },
      history: [],
      methodology: { version: "1.0", versionLabel: "v1.0", currentVersion: "1.0", currentVersionLabel: "v1.0", changelogPath: "/methodology/stability-index-changelog/", asOf: 1_777_000_000, isCurrent: true },
    } as StabilityIndexResponse;

    expect(getStabilityIndexNavSignal(response)).toEqual({
      kind: "badge",
      text: "77.2",
      title: "PSI 77.2 (TREMOR)",
      tone: "warning",
    });
  });

  it("shows a 24h blacklist-event signal only when the new stat is non-zero", () => {
    const response = {
      stats: { recentCount24h: 2 },
    } as BlacklistSummaryResponse;

    expect(getBlacklistNavSignal(response)).toEqual({
      kind: "badge",
      text: "2",
      title: "2 blacklist events in the last 24h",
      tone: "warning",
    });
    expect(getBlacklistNavSignal({ stats: { recentCount24h: 0 } } as BlacklistSummaryResponse)).toBeNull();
  });

  it("maps health status to a persistent dot signal", () => {
    const health = { status: "degraded" } as HealthResponse;

    expect(getStatusNavSignal(health)).toEqual({
      kind: "dot",
      title: "System status: degraded",
      tone: "warning",
    });
  });

  it("tracks unread digest state from the latest generated timestamp", () => {
    expect(parseSidebarDigestSeenAt(null)).toBeNull();
    expect(parseSidebarDigestSeenAt("1777000000")).toBe(1_777_000_000);
    expect(hasUnreadDigest(1_777_000_100, 1_777_000_000)).toBe(true);
    expect(hasUnreadDigest(1_777_000_000, 1_777_000_000)).toBe(false);
    expect(getDigestNavSignal(1_777_000_100, 1_777_000_000)).toEqual({
      kind: "badge",
      text: "new",
      title: "New daily digest available",
      tone: "info",
    });
  });
});
