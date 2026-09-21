import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { DigestInputData } from "@shared/types/digest";
import { BASE_DIGEST_INPUT, makeCollectorCtx } from "./daily-digest.test-support";
import { classifyRegime } from "../daily-digest/prompt/regime";
import { buildRiskTape } from "../daily-digest/digest-risk-tape";
import { rollupDigestInputs } from "../daily-digest/collectors-shared";
import { buildUserPrompt } from "../daily-digest/prompt";
import { buildEditorialCandidates } from "../daily-digest/editorial-candidates";
import { collectBlacklistActivity, collectResolvedDepegs } from "../daily-digest/collectors-market";
import { resolveDailyDigestEditionNumber } from "../digest/publish";

const QUIET_INPUT: DigestInputData = {
  ...BASE_DIGEST_INPUT,
  activeDepegCount: 0,
  topDepegs: [],
};

function dayInput(overrides: Partial<DigestInputData> = {}): DigestInputData {
  return { ...QUIET_INPUT, ...overrides };
}

describe("digest publishes unavailable inputs as unavailable", () => {
  it("never classifies a day CALM when a regime-critical collector could not read", () => {
    expect(classifyRegime(QUIET_INPUT)).toBe("CALM");
    expect(classifyRegime({ ...QUIET_INPUT, degradedSources: ["active-depegs-query"] })).toBe("WATCHFUL");
    expect(classifyRegime({ ...QUIET_INPUT, degradedSources: ["dews-published-generation"] })).toBe("WATCHFUL");
  });

  it("does not assert an absence of peg breaks on a failed active-depeg query", () => {
    const clean = buildRiskTape(QUIET_INPUT).find((item) => item.id === "risk-tape:depegs");
    expect(clean?.detail).toBe("No active peg breaks in the digest input.");

    const degraded = buildRiskTape({ ...QUIET_INPUT, degradedSources: ["active-depegs-query"] })
      .find((item) => item.id === "risk-tape:depegs");
    expect(degraded?.value).toBe("Unavailable");
    expect(degraded?.detail).not.toContain("No active peg breaks");
  });

  it("publishes null weekly totals below full daily coverage", () => {
    const day = dayInput({ activeDepegCount: 2, blacklistActivity: { eventCount: 1, totalAmountUsd: 5, topEvents: [] } });
    const partial = rollupDigestInputs(Array.from({ length: 5 }, () => day));
    expect(partial.activeDepegObs).toBeNull();
    expect(partial.blacklistEvents).toBeNull();
    expect(partial.blacklistUsd).toBeNull();
    expect(partial.days).toBe(5);

    const full = rollupDigestInputs(Array.from({ length: 7 }, () => day));
    expect(full.activeDepegObs).toBe(14);
    expect(full.blacklistEvents).toBe(7);
  });

  it("renders an absent prior DEWS generation as unavailable rather than an all-calm day", () => {
    const prompt = buildUserPrompt(dayInput({
      dewsStress: {
        bandCounts: { calm: 3, watch: 1, alert: 0, warning: 0, danger: 0 },
        yesterdayBandCounts: null,
        bandChanges: [],
        elevatedCoins: [],
      },
    }));
    expect(prompt).toContain("(vs yesterday: unavailable)");
    expect(prompt).not.toContain("vs yesterday: 0/0/0/0/0");
  });

  it("never prints Infinity for a 7-day change without a baseline", () => {
    const prompt = buildUserPrompt(dayInput({
      totalMcapUsd: 1_000_000,
      mcap7dDelta: 1_000_000,
      mcap7dDeltaCoverage: { coveredCoins: 1, totalCoins: 3, coveredMcapUsd: 1_000_000 },
    }));
    expect(prompt).not.toContain("Infinity");
    expect(prompt).toContain("n/a (no 7d baseline)");
    expect(prompt).toContain("baseline covers 1 of 3 core coins");
  });

  it("keeps a non-finite depeg impact from defusing the regime thresholds", () => {
    const regime = classifyRegime(dayInput({
      activeDepegCount: 1,
      topDepegs: [{ symbol: "USDX", bps: -900, mcapUsd: Number.NaN, impactScore: Number.NaN }],
      stabilityIndex: { score: 65, band: "TREMOR", components: { severity: 30, breadth: 5, trend: -3 } },
    }));
    expect(regime).toBe("CRISIS");
  });

  it("counts the daily edition number from the rows readers actually saw", async () => {
    const db = mockD1([{ match: "COUNT(*) as cnt FROM daily_digest", rows: [{ cnt: 209 }] }]);
    await expect(resolveDailyDigestEditionNumber(db)).resolves.toBe(209);
    const sql = db.getHistory().find((entry) => entry.sql.includes("COUNT(*) as cnt"))?.sql ?? "";
    expect(sql).toContain("$.qualityGate");
    expect(sql).toContain("$.type");
  });

  it("bounds resolved-depeg evidence to the 24h window it is published as", async () => {
    const db = mockD1([{ match: "FROM depeg_events", rows: [] }]);
    const ctx = makeCollectorCtx(db);
    await collectResolvedDepegs(ctx);
    const query = db.getHistory().find((entry) => entry.sql.includes("FROM depeg_events"));
    expect(query?.binds[0]).toBe(ctx.nowSec - 86_400);
    expect(query?.sql).toContain("ABS(peak_deviation_bps) > 100");
    expect(query?.sql).toContain("json_each(?)");
    expect(JSON.parse(String(query?.binds[1]))).toEqual(["usdt-tether", "usdc-circle"]);
  });

  it("publishes an unknown blacklist amount as unknown and does not suppress it", async () => {
    const collected = await collectBlacklistActivity(makeCollectorCtx(mockD1([{
      match: "FROM blacklist_events",
      rows: [
        { symbol: "USDC", chain_name: "Ethereum", event_type: "blacklist", amount_usd_at_event: null },
        { symbol: "USDT", chain_name: "Ethereum", event_type: "blacklist", amount_usd_at_event: 5_000_000 },
      ],
    }])));
    const blacklistActivity = collected.value;
    expect(blacklistActivity).toMatchObject({ eventCount: 2, totalAmountUsd: 5_000_000, unpricedEventCount: 1 });
    expect(blacklistActivity?.topEvents[0]?.amountUsd).toBeNull();

    const data = dayInput({ blacklistActivity });
    const prompt = buildUserPrompt(data);
    expect(prompt).toContain("USDC on Ethereum: blacklist (amount unknown)");
    expect(prompt).not.toContain("blacklist ($0)");

    const candidate = buildEditorialCandidates(data, null).find((entry) => entry.kind === "blacklist");
    expect(candidate?.suppressReason).toBeUndefined();
    expect(candidate?.artifactRisk).not.toBe("high");
  });

  it("still suppresses a fully priced zero-dollar blacklist day", () => {
    const data = dayInput({
      blacklistActivity: {
        eventCount: 2,
        totalAmountUsd: 0,
        unpricedEventCount: 0,
        topEvents: [{ symbol: "USDC", chain: "Ethereum", type: "blacklist", amountUsd: 0 }],
      },
    });
    const candidate = buildEditorialCandidates(data, null).find((entry) => entry.kind === "blacklist");
    expect(candidate?.suppressReason).toContain("zero-dollar");
    expect(candidate?.artifactRisk).toBe("high");
  });
});
