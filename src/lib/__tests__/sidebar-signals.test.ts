import { describe, expect, it } from "vitest";
import type {
  BlacklistSummaryResponse,
  HealthResponse,
  PegSummaryResponse,
} from "@shared/types";
import {
  getBlacklistNavSignal,
  getDepegNavSignal,
  getDigestNavSignal,
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

  it("shows a 24h blacklist-event signal only when the new stat is non-zero", () => {
    const response = {
      stats: { recentCount24h: 2 },
    } as BlacklistSummaryResponse;

    expect(getBlacklistNavSignal(response)).toEqual({
      kind: "badge",
      text: "2",
      title: "2 blacklist events in the last 24h",
      tone: "warning",
      showIcon: false,
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
