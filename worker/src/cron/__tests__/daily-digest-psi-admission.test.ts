import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vitest hoists mock factories before static imports; load the shared fixture module inside those factories.
vi.mock("@shared/lib/stablecoins/registry", async () => (await import("./daily-digest.test-support")).mockDailyDigestRegistryModule());
vi.mock("../../lib/stablecoins-cache", async () => (await import("./daily-digest.test-support")).mockDailyDigestStablecoinsCacheModule());
vi.mock("../../lib/safety-score-active-source", async () => (await import("./daily-digest.test-support")).mockDailyDigestSafetySourceModule());
vi.mock("../../lib/flight-to-quality-classification", async () => (await import("./daily-digest.test-support")).mockDailyDigestFlightToQualityModule());

import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import { buildDailyDigestInput } from "../daily-digest/input";
import { buildUserPrompt } from "../daily-digest/prompt";
import { classifyRegime } from "../daily-digest/prompt/regime";
import { BASE_DIGEST_INPUT, makeDailyDigestScenario } from "./daily-digest.test-support";

const NOW = Math.floor(Date.parse("2026-03-30T08:10:00Z") / 1000);
const source = (stored_at: number) => ({ score: 96, band: "BEDROCK", stored_at, components: JSON.stringify({ severity: 0, breadth: 0, trend: 0 }) });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("daily digest PSI source admission", () => {
  it.each([
    ["stale sample", source(NOW - 3 * 3600), null],
    ["old daily-only row", null, source(NOW - 3 * 86400)],
    ["future sample", source(NOW + 1), null],
    ["future daily-only row", null, source(NOW + 1)],
    ["missing observations", null, null],
  ])("withholds %s from current copy and the optimistic regime", async (_label, sample, daily) => {
    const scenario = makeDailyDigestScenario({ db: { prependTables: [
      { match: "SELECT score, band, components, stored_at FROM stability_index_samples", rows: [], first: sample },
      { match: "SELECT score, band, components, computed_at as stored_at", rows: [], first: daily },
      { match: "SELECT AVG(score)", rows: [], first: { avg: null } },
    ] } });
    vi.mocked(loadStablecoinsCache).mockResolvedValue(scenario.sourcePayload);
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValue(scenario.safetySource);
    const built = await buildDailyDigestInput(scenario.db);
    expect(built.inputData.stabilityIndex).toBeNull();
    expect(built.degradedReasons).toContain("psi-unavailable");
    expect(buildUserPrompt(built.inputData)).not.toContain("Pharos Stability Index: 96");
    const quiet = { ...BASE_DIGEST_INPUT, activeDepegCount: 0, topDepegs: [], stabilityIndex: built.inputData.stabilityIndex,
      degradedSources: built.degradedReasons.filter((reason) => reason.startsWith("psi-")) };
    expect(classifyRegime(quiet)).toBe("WATCHFUL");
  });

  it.each([
    ["fresh sample", source(NOW - 600), source(NOW - 3 * 86400)],
    ["fresh daily fallback", source(NOW - 3 * 3600), source(Math.floor(NOW / 86400) * 86400 - 86400)],
  ])("preserves admitted %s behavior", async (_label, sample, daily) => {
    const scenario = makeDailyDigestScenario({ db: { prependTables: [
      { match: "SELECT score, band, components, stored_at FROM stability_index_samples", rows: [], first: sample },
      { match: "SELECT score, band, components, computed_at as stored_at", rows: [], first: daily },
      { match: "SELECT AVG(score)", rows: [], first: { avg: null } },
    ] } });
    vi.mocked(loadStablecoinsCache).mockResolvedValue(scenario.sourcePayload);
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValue(scenario.safetySource);
    const built = await buildDailyDigestInput(scenario.db);
    expect(built.inputData.stabilityIndex).toMatchObject({ score: 96, band: "BEDROCK" });
    expect(built.degradedReasons).not.toContain("psi-unavailable");
    expect(buildUserPrompt(built.inputData)).toContain("Pharos Stability Index: 96");
    expect(classifyRegime({ ...BASE_DIGEST_INPUT, activeDepegCount: 0, topDepegs: [], stabilityIndex: built.inputData.stabilityIndex,
      degradedSources: built.degradedReasons.filter((reason) => reason.startsWith("psi-")) })).toBe("CALM");
  });
});
