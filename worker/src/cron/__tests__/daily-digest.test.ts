import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRiskTape } from "../daily-digest/digest-risk-tape";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { PSI_NATIVE_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/depeg-quote-domain";
import { NATIVE_EVENT_QUOTE_CACHE_PREFIX } from "../../lib/native-peg-quote-cache";
import { PSI_CONDITION_BAND_VALUES } from "@shared/types/stability-constants";

vi.mock("@shared/lib/stablecoins/registry", async () => (await import("./daily-digest.test-support")).mockDailyDigestRegistryModule());
vi.mock("../../lib/stablecoins-cache", async () => (await import("./daily-digest.test-support")).mockDailyDigestStablecoinsCacheModule());
vi.mock("../../lib/safety-score-active-source", async () => (await import("./daily-digest.test-support")).mockDailyDigestSafetySourceModule());
vi.mock("../../lib/safety-score-index", async () => ({
  loadActiveSafetyScoreIndex: (await import("../../lib/safety-score-active-source")).loadActiveSafetyScoreCohort,
}));
vi.mock("../../lib/flight-to-quality-classification", async () => (await import("./daily-digest.test-support")).mockDailyDigestFlightToQualityModule());
vi.mock("../../lib/fetch-retry", async () => (await import("./daily-digest.test-support")).mockDailyDigestFetchRetryModule());
vi.mock("../../lib/twitter", async () => (await import("./daily-digest.test-support")).mockDailyDigestTwitterModule());
vi.mock("../../lib/digest-safety-map", async (importOriginal) => {
  const { mockDigestSafetyMapModule } = await import("./daily-digest.test-support");
  return mockDigestSafetyMapModule(await importOriginal<typeof import("../../lib/digest-safety-map")>());
});
vi.mock("../../telegram/digest/digest-appendices", async () => (await import("./daily-digest.test-support")).mockDailyDigestAppendicesModule());
vi.mock("../../telegram/outbox/digest-outbox", async () => (await import("./daily-digest.test-support")).mockDailyDigestOutboxModule());
vi.mock("../digest/telegram-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../digest/telegram-transport")>();
  return (await import("./daily-digest.test-support")).mockTelegramDigestTransportModule(actual);
});
vi.mock("../../lib/circuit-breaker", async () => (await import("./daily-digest.test-support")).mockDailyDigestCircuitBreakerModule());

import { buildUserPrompt } from "../daily-digest/prompt";
import { buildDailyDigestInput, buildDigestSafetyMapCapture } from "../daily-digest/input";
import { insertDigestRecord } from "../digest/platform";
import { DAILY_EXEMPLAR, SYSTEM_PROMPT } from "../daily-digest/prompt/policy";
import { classifyRegime } from "../daily-digest/prompt/regime";
import { ALLOWED_TONES, hasBlockingDigestQualityIssues, parseDigestModelResponse, validateDigestModelOutput, type DigestValidationProfile, type ParsedDigestResponse } from "../daily-digest/response";
import { collectActiveDepegs, collectLiquidityShifts, collectMintBurnFlows, collectResolvedDepegs, collectSupplyVelocity } from "../daily-digest/collectors-market";
import { collectDewsStress, collectGradeTransitions, collectSafetyScores, collectYieldAnomalies } from "../daily-digest/collectors-risk";
import { collectCrossDayTrends, collectHistoricalContext, collectPsiContributors } from "../daily-digest/collectors-history";
import { buildDigestIntelligence, parseStoredDigestInput } from "../daily-digest/digest-intelligence";
import { buildEditorialCandidates } from "../daily-digest/editorial-candidates";
import { buildForwardLookOutcomes, buildNextTriggers } from "../daily-digest/digest-next-triggers";
import { buildEditorialPrompt, scanEditorialText } from "@shared/lib/editorial-style";
import { getPsiBandStreak } from "@shared/lib/psi-view-model";
import type { DigestInputData } from "@shared/types/digest";
import { loadActiveSafetyScoreCohort } from "../../lib/safety-score-active-source";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { BASE_DIGEST_INPUT, BASE_SAFETY_CONTEXT, canonicalSafetySource, makeCollectorCtx, makeDailyDigestScenario, makeDigestRow, makePublishedDewsTables, missingPublishedGaugeTable, PUBLISHED_GAUGE_SCORE, publishedGaugePayload, publishedGaugeTable, VALID_CAPTURE_MAP_SUMMARY } from "./daily-digest.test-support";

const DEFAULT_EXTENDED = "T. T. T.\n\nT. T. T.\n\nT. T. T.";
const fixture = (opts: { extended?: string; text?: string; lead?: string; leadSignalId?: string; tone?: string } = {}): ParsedDigestResponse => ({ digestTitle: "T", digestText: opts.text ?? "T.", digestExtended: opts.extended ?? DEFAULT_EXTENDED, digestMeta: JSON.stringify({ leadSignalId: opts.leadSignalId, lead: opts.lead ?? "depeg", tone: opts.tone ?? "dry", coins: ["USDT"] }), strippedDashCount: 0, usedRawTextFallback: false });
const issueCodes = (parsed: ParsedDigestResponse, profile: DigestValidationProfile) => validateDigestModelOutput(parsed, profile).map((issue) => issue.code);
const first = (match: string, value: Record<string, unknown> | null): MockTableConfig => ({ match, rows: [], first: value });
const ctxFor = (tables: MockTableConfig[]) => makeCollectorCtx(mockD1(tables));
const depegTable = (rows: Record<string, unknown>[]): MockTableConfig[] => [{ match: "FROM depeg_events e LEFT JOIN depeg_event_provenance", rows }];
const nativeQuoteFixtures = createLatestSchemaFixtureTracker();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  vi.mocked(loadActiveSafetyScoreCohort).mockReset().mockResolvedValue(canonicalSafetySource([]));
});
afterEach(() => { nativeQuoteFixtures.closeAll(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("response and editorial contracts", () => {
  it.each([
    ["natural leads", ["gauge-flip", "psi-band-change", "issuer-concentration", "regime-divergence", "chain-migration", "reserve-event"], "lead"],
    ["natural tones", ["sardonic", "observant", "forensic"], "tone"],
  ] as const)("preserves %s", (_label, values, field) => {
    for (const value of values) {
      const raw = JSON.stringify({ title: "T", text: "T.", extended: DEFAULT_EXTENDED, meta: { lead: field === "lead" ? value : "depeg", tone: field === "tone" ? value : "dry", coins: ["USDT"] } });
      expect((JSON.parse(parseDigestModelResponse(raw).digestMeta!) as Record<string, string>)[field]).toBe(value);
    }
  });

  it("normalizes unknown meta values and enforces lead, look-ahead, and repetition guards", () => {
    const unknown = JSON.parse(parseDigestModelResponse(JSON.stringify({ title: "T", text: "T.", extended: DEFAULT_EXTENDED, meta: { lead: "???", tone: "???" } })).digestMeta!);
    expect(unknown).toMatchObject({ lead: "other", tone: "other" });
    expect(issueCodes(fixture({ extended: "A.\n\nB.\n\nC.", text: "Watch if USDT crosses $185B." }), { kind: "daily", recentMeta: [] })).not.toContain("missing-forward-look");
    expect(issueCodes(fixture({ lead: "psi-streak" }), { kind: "daily", recentMeta: ["psi-regime", "psi-band-change", "supply-reversal"].map((lead) => ({ meta: { lead, tone: "dry" }, title: "x" })) })).toContain("repeated-lead-family");
    expect(issueCodes(fixture({ extended: "PSI ticked to 96 in BEDROCK.\n\nUSDC added $500M.\n\nReal closer." }), { kind: "daily", recentMeta: [{ meta: null, title: "x", rawText: "PSI sits at 95. USDC hit ATH." }] })).toContain("opening-pattern-repetition");
    expect(issueCodes(fixture({ extended: "At tomorrow's 10:00 snapshot, the DAI threshold decides the lead.\n\nUSDC added $500M.\n\nWatch for flows next session." }), { kind: "daily", recentMeta: ["At tomorrow's 08:00 snapshot, the USDT threshold decides the lead.", "At tomorrow's 09:00 snapshot, the USDC threshold decides the lead."].map((rawText, i) => ({ meta: null, title: String(i), rawText })) })).toContain("structural-repetition");
  });

  it.each([
    ["critical lead mismatch", fixture({ leadSignalId: "market:usdc-circle:weekly-supply", extended: "PMUSD stayed 5284 bps below peg on $65M.\n\nUSDC added $2B.\n\nIf PMUSD holds there next session, the peg stress remains the lead." }), "lead-candidate-mismatch"],
    ["critical lead omission", fixture({ leadSignalId: "depeg:pmusd-active", extended: "USDC added $2B.\n\nUSDT held steady.\n\nIf the flow reverses next session, the supply story changes." }), "required-lead-missing"],
  ] as const)("hard-fails %s", (_label, parsed, code) => {
    const issues = validateDigestModelOutput(parsed, { kind: "daily", recentMeta: [], leadRequirements: [{ candidateIds: ["depeg:pmusd-active"], severity: "hard", mentionTokens: ["PMUSD"], reason: "PMUSD critical depeg must lead" }] });
    expect(issues).toContainEqual(expect.objectContaining({ code, severity: "hard" }));
  });

  const extended = (quote: string): ParsedDigestResponse => parseDigestModelResponse(JSON.stringify({ title: "Calm Market", text: "USDT held its peg.", extended: `${quote}\n\n${"USDT supply stayed near the prior print while the next observable trigger remained unchanged. ".repeat(6).trim()}\n\n${"The market snapshot kept its measured shape as flows and prices moved within the stated range. ".repeat(5).trim()}`, meta: { lead: "depeg", tone: "dry", coins: ["USDT"] } }));
  it("keeps editorial dashes soft in shadow, hard in enforce, and repairs the full dash range", () => {
    const shadow = validateDigestModelOutput(extended("USDT moved — the next trigger is tomorrow."), { kind: "daily" });
    expect(shadow).toContainEqual(expect.objectContaining({ code: "editorial-style", severity: "soft", ruleId: "no-clause-dash" }));
    expect(hasBlockingDigestQualityIssues(shadow)).toBe(false);
    expect(validateDigestModelOutput(extended("USDT moved — the next trigger is tomorrow."), { kind: "daily", styleGateMode: "enforce" })).toContainEqual(expect.objectContaining({ severity: "hard", ruleId: "no-clause-dash" }));
    for (const dash of ["‒", "―"]) { const parsed = extended(`USDT moved ${dash} the next trigger is tomorrow.`); expect(parsed.digestExtended).not.toContain(dash); expect(parsed.editorialFindings).toContainEqual(expect.objectContaining({ ruleId: "no-clause-dash", excerpt: dash, severity: "hard" })); }
    expect(validateDigestModelOutput(extended("USDT held.\n\nThe plumbing flinched.\n\nWatch the next trigger."), { kind: "daily" })).toContainEqual(expect.objectContaining({ ruleId: "scoped-decorative-word", severity: "soft" }));
  });

  it.each(["daily", "weekly"] as const)("keeps raw hard findings separate from advisories in %s enforce mode", (kind) => {
    const parsed = parseDigestModelResponse(JSON.stringify({
      title: "Calm Market",
      text: "USDT held — watch the next print tomorrow.",
      extended: "The plumbing flinched.\n\nUSDT held its peg.\n\nWatch the next trigger.",
    }), { register: kind, styleGateMode: "enforce" });
    expect(parsed.digestText).toContain("—");
    const findings = validateDigestModelOutput(parsed, { kind, styleGateMode: "enforce" })
      .filter((issue) => issue.code === "editorial-style");
    expect(findings).toContainEqual(expect.objectContaining({ ruleId: "no-clause-dash", severity: "hard" }));
    expect(findings).toContainEqual(expect.objectContaining({ ruleId: "scoped-decorative-word", severity: "soft" }));
  });

  it.each([
    ["sardonic streak", fixture({ tone: "sardonic" }), [{ meta: { lead: "depeg", tone: "sardonic" }, title: "Prior" }], "consecutive-sardonic-tone"],
    ["tone cluster", fixture({ tone: "dry" }), ["dry", "dry", "dry", "dry", "dry"].map((tone, i) => ({ meta: { lead: "depeg", tone }, title: String(i) })), "tone-cluster"],
  ] as const)("finds %s", (_label, parsed, recentMeta, code) => {
    const history = recentMeta.map(({ meta, title }) => ({ meta: { ...meta }, title }));
    expect(issueCodes(parsed, { kind: "daily", recentMeta: history })).toContain(code);
  });

  it("covers mention-only and factual editorial guard boundaries", () => {
    const profile = { kind: "daily" as const, recentMeta: [], leadRequirements: [{ candidateIds: [], severity: "soft" as const, mentionTokens: ["PMUSD"], reason: "ongoing critical" }] };
    expect(issueCodes(fixture({ leadSignalId: "yield:usdc", extended: `PMUSD remains 2,950 bps under peg, unchanged. ${DEFAULT_EXTENDED}` }), profile)).not.toContain("required-lead-missing");
    expect(issueCodes(fixture({ leadSignalId: "yield:usdc" }), profile)).toContain("required-lead-missing");
    const facts = (text: string, extra: Partial<DigestValidationProfile>) => issueCodes(fixture({ extended: `${text} ${DEFAULT_EXTENDED}` }), { kind: "daily", recentMeta: [], ...extra });
    expect(facts("USX sits 5,783 bps below peg while the quote reads $0.997 as a courtesy.", { depegFacts: [{ symbol: "USX", currentPriceUsd: 0.4217, currentBps: -5783 }] })).toContain("price-bps-mismatch");
    expect(facts("USX sits 5,783 bps below peg at $0.42 with no bid in sight.", { depegFacts: [{ symbol: "USX", currentPriceUsd: 0.4217, currentBps: -5783 }] })).not.toContain("price-bps-mismatch");
    expect(facts("APXUSD narrowed from 3,650 bps yesterday.", { prevDepegFacts: [{ symbol: "APXUSD", currentBps: -3159, bps: -3159 }] })).toContain("unverifiable-movement-claim");
    expect(facts("APXUSD widened from 3,159 bps to 3,410 bps overnight.", { prevDepegFacts: [{ symbol: "APXUSD", currentBps: -3159 }] })).not.toContain("unverifiable-movement-claim");
    expect(facts("APXUSD narrowed from 3,159 bps overnight.", { prevDepegFacts: [{ symbol: "APXUSD", currentBps: -420 }, { symbol: "OTHER", currentBps: -3159 }] })).toContain("unverifiable-movement-claim");
    expect(facts("APXUSD narrowed from 3,159 bps overnight.", { prevDepegFacts: [{ symbol: "APXUSD", bps: -3159, peakBps: -3159 }] })).toContain("unverifiable-movement-claim");
    expect(facts("APXUSD narrowed from 3,159 bps overnight.", { prevDepegFacts: [{ symbol: "APXUSD", currentBps: -420, bps: -3159, peakBps: -3159 }] })).toContain("unverifiable-movement-claim");
    expect(issueCodes(fixture({ leadSignalId: "yield:usdc", extended: `USDTB remains 2,950 bps under peg, unchanged. ${DEFAULT_EXTENDED}` }), { kind: "daily", recentMeta: [], leadRequirements: [{ candidateIds: [], severity: "hard" as const, mentionTokens: ["USDT"], reason: "ongoing critical" }] })).toContain("required-lead-missing");
    const titles = [{ meta: null, title: "USX Turns Twenty Days Old" }, { meta: null, title: "USX Passes 450 Hours Broken" }];
    expect(issueCodes({ ...fixture(), digestTitle: "USX Enters Week Four" }, { kind: "daily", recentMeta: titles })).toEqual(expect.arrayContaining(["title-symbol-streak", "title-day-counting"]));
    expect(issueCodes({ ...fixture(), digestTitle: "USDC Touches Its Ceiling" }, { kind: "daily", recentMeta: [], recentTitles: ["USDC Touches Its Ceiling"] })).toContain("repeated-title");
  });

  it.each([
    ["contradictory hook", "USDC trades at $0.90, 50 bps below peg.", "hard"],
    ["self-consistent false pair", "USDC trades at $0.90, 1,000 bps below peg.", "hard"],
    ["false deviation with current price", "USDC trades at $0.995, 1,000 bps below peg.", "hard"],
    ["historical pair", "USDC was at $0.90, 1,000 bps below peg yesterday.", "soft"],
    ["consistent quote", "USDC trades at $0.995, 50 bps below peg.", null],
    ["rounded quote", "USDC trades at $1.00, 50 bps below peg.", null],
    ["supply before price", "USDC has $50B in supply, trades at $0.995, and sits 50 bps below peg.", null],
    ["contradiction after supply", "USDC has $50B in supply, trades at $0.90, and sits 50 bps below peg.", "hard"],
    ["unscaled supply", "USDC has supply at $500,000 and sits 50 bps below peg.", "soft"],
    ["multi-coin sentence", "USDC trades at $0.995 while USDT sits 1,000 bps below peg at $0.90.", "soft"],
    ["coin without a depeg fact", "USDC trades at $0.995 while DAI sits 1,000 bps below peg.", "soft"],
    ["competing deviations", "USDC trades at $0.995, 50 bps below peg after a peak of 1,000 bps.", "soft"],
  ] as const)("binds numeric claims conservatively: %s", (_label, text, severity) => {
    const parsed = { ...extended("USDT held its peg; watch the next print tomorrow."), digestText: text };
    const issues = validateDigestModelOutput(parsed, {
      kind: "daily",
      depegFacts: [
        { symbol: "USDC", currentPriceUsd: 0.995, currentBps: -50 },
        { symbol: "USDT", currentPriceUsd: 0.9, currentBps: -1000 },
      ],
    }).filter((issue) => issue.code.startsWith("price-bps-"));
    if (severity) expect(issues).toContainEqual(expect.objectContaining({ severity }));
    else expect(issues).toEqual([]);
    expect(hasBlockingDigestQualityIssues(issues)).toBe(severity === "hard");
  });

  it.each([
    ["above", 0.995, -50, "0.995", true],
    ["over", 0.995, -50, "0.995", true],
    ["below", 1.005, 50, "1.005", true],
    ["under", 1.005, 50, "1.005", true],
    ["below", 0.995, -50, "0.995", false],
    ["under", 0.995, -50, "1.00", false],
    ["above", 1.005, 50, "1.00", false],
    ["over", 1.1055, 50, "1.106", false],
    ["under", 1.1055, 50, "1.106", true],
    ["below", 1.0945, -50, "1.09", false],
    ["above", 1.0945, -50, "1.09", true],
  ] as const)("checks signed %s peg claims at %s with rounded quote %s", (direction, price, bps, quote, blocked) => {
    const parsed = { ...extended("USDT held its peg; watch the next print tomorrow."), digestText: `USDC trades at $${quote}, 50 bps ${direction} peg.` };
    const issues = validateDigestModelOutput(parsed, {
      kind: "daily", depegFacts: [{ symbol: "USDC", currentPriceUsd: price, currentBps: bps }],
    }).filter((issue) => issue.code.startsWith("price-bps-"));
    expect(issues.some((issue) => issue.code === "price-bps-direction-mismatch" && issue.severity === "hard")).toBe(blocked);
    expect(hasBlockingDigestQualityIssues(issues)).toBe(blocked);
  });

  it("never binds a dollar claim to native-unit event evidence", () => {
    const issues = validateDigestModelOutput(fixture({ text: "EURC trades at $1.10, 200 bps below peg." }), {
      kind: "daily",
      depegFacts: [{ symbol: "EURC", quoteMode: "native-peg", currentPriceUsd: 0.98, currentBps: -200, pegReference: 1 }],
    }).filter((issue) => issue.code.startsWith("price-bps-"));
    expect(issues).toEqual([]);
  });
});

describe("intelligence, prompt, and regime contracts", () => {
  const current: DigestInputData = { ...BASE_DIGEST_INPUT, editorialCandidates: [{ id: "depeg:usdt-tether:active", kind: "depeg", title: "USDT active 175 bps below peg", symbols: ["USDT"], impactScore: 17.5, novelty: "worsening", confidence: "high", artifactRisk: "low", headlineFacts: ["175 bps below peg"], whyItMatters: "Active peg stress is relevant." }, { id: "supply:usdc:accelerating", kind: "supply", title: "USDC supply accelerating", symbols: ["USDC"], impactScore: 12, novelty: "accelerating", confidence: "high", artifactRisk: "low", headlineFacts: ["+$12M in 1d"], whyItMatters: "Supply velocity shows allocation." }] };
  current.dataQuality = { generatedAt: 200_000, stablecoinsCacheUpdatedAt: 200_000, stablecoinsCacheAgeSec: 0, windows: { blacklistActivity: { label: "24h", start: 113_600, end: 200_000 }, mintBurnFlows: { label: "24h", start: 113_600, end: 200_000 }, supplyVelocity: { label: "UTC", dates: [] }, psi: { label: "latest", sampleAt: 200_000, dailySnapshotAt: null } } };
  current.topDepegs = [{ ...current.topDepegs[0], currentBps: -175, severityBasis: "current", startedAt: 1, pegReference: 1, priceObservedAt: 200_000 }];
  const previous: DigestInputData = { ...current, topDepegs: [{ ...current.topDepegs[0], bps: -100 }], stabilityIndex: { score: 91, band: "BEDROCK", components: { severity: 2, breadth: 1, trend: 0 } }, nextTriggers: [{ id: "trigger:depeg:usdt", label: "USDT depeg widening", metric: "depeg-bps", comparator: "abs-gte", thresholdValue: 125, thresholdLabel: "125 bps off peg", symbol: "USDT", rationale: "Wider deviation raises severity.", detail: "If USDT reaches 125 bps off peg, severity rises." }] };
  previous.dataQuality = { ...current.dataQuality, generatedAt: 113_600 };
  previous.topDepegs = [{ ...current.topDepegs[0], currentBps: -100, priceObservedAt: 113_600 }];
  it("builds change, trigger, risk, and calm-frame intelligence and expires stale triggers", () => {
    const intelligence = buildDigestIntelligence(current, previous);
    expect(intelligence.calmNarrativeFrame).toMatchObject({ label: "Supply rotation" }); expect(intelligence.nextTriggers?.[0]).toMatchObject({ metric: "depeg-bps" });
    expect(intelligence.changeSummary?.worsenedSignals[0]).toMatchObject({ label: "USDT depeg widened" });
    expect(intelligence.forwardLookOutcomes?.[0]).toMatchObject({ status: "hit", triggerId: "trigger:depeg:usdt" });
    let prior: DigestInputData | null = null;
    const editions = Array.from({ length: 4 }, (_, index) => {
      const generatedAt = 200_000 + index * 86_400;
      const observed = { ...current, dataQuality: { ...current.dataQuality!, generatedAt }, topDepegs: [{ ...current.topDepegs[0], priceObservedAt: generatedAt }] };
      const data = { ...observed, nextTriggers: buildNextTriggers(observed, prior) };
      prior = data;
      return data;
    });
    expect(editions.slice(0, 3).map((data) => data.nextTriggers?.[0]?.repeatedCount ?? 0)).toEqual([0, 1, 2]);
    expect(editions[3].nextTriggers?.some((trigger) => trigger.id === "trigger:depeg:usdt-tether")).toBe(false);
    expect(buildForwardLookOutcomes(editions[3], editions[2])).toContainEqual(expect.objectContaining({ status: "expired" }));
  });
  it("renders a sticky trigger's detail from the kept threshold, not today's re-derived one", () => {
    const armed: DigestInputData = { ...previous, nextTriggers: [{ id: "trigger:depeg:usdt-tether", label: "USDT depeg widening", metric: "depeg-bps", comparator: "abs-gte", thresholdValue: 300, thresholdLabel: "300 bps off peg", symbol: "USDT", rationale: "Wider deviation raises severity.", detail: "If USDT reaches 225 bps off peg, the next digest should treat it as a stronger peg-stress signal." }] };
    const trigger = buildNextTriggers(current, armed).find((entry) => entry.id === "trigger:depeg:usdt-tether");
    expect(trigger).toMatchObject({ thresholdValue: 300, thresholdLabel: "300 bps off peg", repeatedCount: 1 });
    expect(trigger?.detail).toBe("If USDT reaches 300 bps off peg, the next digest should treat it as a stronger peg-stress signal.");
  });
  const liquidityInput = (scoreDelta: number, currentScore = 68): DigestInputData => ({
    ...current, topDepegs: [], stabilityIndex: null,
    editorialCandidates: [{ id: `liquidity:usdt:${scoreDelta}`, kind: "liquidity", title: "USDT liquidity shift", symbols: ["USDT"], impactScore: 10, novelty: "new", confidence: "high", artifactRisk: "low", headlineFacts: ["Liquidity shifted"], whyItMatters: "Depth changed." }],
    liquidityShifts: [{ symbol: "USDT", currentScore, previousScore: currentScore - scoreDelta, scoreDelta, currentTvl: 20e6, previousTvl: 20e6, mcapUsd: 100e6, tvlChangePct: 0, expectedScoreDeltaFromTvl: 0, coverageClass: "primary", coverageConfidence: 1 }],
  });
  const liquidityEvidence = (currentScore: number, stablecoinId = "usdt-tether") => ({
    liquidity: [{ stablecoinId, symbol: "USDT", currentScore }],
  });
  it.each([
    ["decay to recovery", -8, 60, 8, "lte", 52, "falls to 52"],
    ["recovery to decay", 8, 76, -8, "gte", 84, "climbs to 84"],
    ["continued decay", -8, 60, -8, "lte", 52, "falls to 52"],
    ["continued recovery", 8, 76, 8, "gte", 84, "climbs to 84"],
  ] as const)("preserves the whole armed liquidity condition through %s", (_label, priorDelta, priorScore, nextDelta, comparator, thresholdValue, detail) => {
    const prior = liquidityInput(priorDelta, priorScore);
    const armed = { ...prior, nextTriggers: buildNextTriggers(prior, null, liquidityEvidence(priorScore)) };
    const today = liquidityInput(nextDelta);
    const nextTriggers = buildNextTriggers(today, armed, liquidityEvidence(68));
    expect(nextTriggers[0]).toEqual({ ...armed.nextTriggers[0], repeatedCount: 1 });
    expect(nextTriggers[0]).toMatchObject({ metric: "liquidity-score", comparator, thresholdValue, stablecoinId: "usdt-tether" });
    expect(nextTriggers[0].detail).toContain(detail);
    expect(buildForwardLookOutcomes(today, armed, liquidityEvidence(68))[0].status).toBe("pending");
    expect(buildForwardLookOutcomes(today, { ...today, nextTriggers }, liquidityEvidence(68))[0].status).toBe("pending");
  });
  it.each([
    [-8, 60, 52, 8, "gte", 60],
    [8, 76, 84, -8, "lte", 76],
  ] as const)("re-arms a hit liquidity condition at score %s/%s/%s", (priorDelta, priorScore, hitScore, nextDelta, comparator, thresholdValue) => {
    const prior = liquidityInput(priorDelta, priorScore);
    const armed = { ...prior, nextTriggers: buildNextTriggers(prior, null, liquidityEvidence(priorScore)) };
    const today = liquidityInput(nextDelta, hitScore);
    expect(buildForwardLookOutcomes(today, armed, liquidityEvidence(hitScore))[0].status).toBe("hit");
    const fresh = buildNextTriggers(today, null, liquidityEvidence(hitScore))[0];
    expect(buildNextTriggers(today, armed, liquidityEvidence(hitScore))[0]).toEqual(fresh);
    expect(fresh).toMatchObject({ id: "trigger:liquidity:usdt", comparator, thresholdValue });
    expect(fresh.repeatedCount).toBeUndefined();
  });
  it("expires a reversed liquidity condition at the existing pending-edition TTL", () => {
    const prior = liquidityInput(-8, 60);
    let armed = { ...prior, nextTriggers: buildNextTriggers(prior, null, liquidityEvidence(60)) };
    const today = liquidityInput(8);
    for (const repeatedCount of [1, 2]) {
      armed = { ...today, nextTriggers: buildNextTriggers(today, armed, liquidityEvidence(68)) };
      expect(armed.nextTriggers[0]).toMatchObject({ comparator: "lte", thresholdValue: 52, repeatedCount });
    }
    expect(buildForwardLookOutcomes(today, armed, liquidityEvidence(68))[0].status).toBe("expired");
    expect(buildNextTriggers(today, armed, liquidityEvidence(68))).toEqual([]);
  });
  it("retains the armed target and condition when its evidence is unavailable", () => {
    const prior = liquidityInput(-8, 60);
    const armed = { ...prior, nextTriggers: buildNextTriggers(prior, null, liquidityEvidence(60)) };
    const today = liquidityInput(8);
    const replacement = liquidityEvidence(68, "different-usdt");
    expect(buildForwardLookOutcomes(today, armed, replacement)[0].status).toBe("unavailable");
    const nextTriggers = buildNextTriggers(today, armed, replacement);
    expect(nextTriggers[0]).toEqual({ ...armed.nextTriggers[0], repeatedCount: 1 });
    expect(buildForwardLookOutcomes(today, { ...today, nextTriggers }, replacement)[0].status).toBe("unavailable");
  });
  const supplyTriggerCases: Array<[string, DigestInputData, string]> = [
    ["weekly fallback", { ...current, supplyVelocity: [], supplyChanges7d: [{ coin: "USDC", change7d: 40_000_000 }] }, "USDC"],
    ["coin-specific velocity", { ...current, biggestSupplyChange: { id: "usdt-tether", symbol: "USDT", name: "Tether", changeUsd: 90_000_000, currentMcap: 100_000_000 } }, "USDC"],
  ];
  it.each(supplyTriggerCases)("evaluates %s trigger against %s", (_label, today, symbol) => {
    const prior: DigestInputData = { ...current, dataQuality: { generatedAt: 1_772_668_800, stablecoinsCacheUpdatedAt: null, stablecoinsCacheAgeSec: null, windows: { blacklistActivity: { label: "x", start: 0, end: 0 }, mintBurnFlows: { label: "x", start: 0, end: 0 }, supplyVelocity: { label: "x", dates: [] }, psi: { label: "x", sampleAt: null, dailySnapshotAt: null } } }, nextTriggers: [{ id: "trigger:supply-7d:usdc", label: "USDC weekly supply move", metric: "supply-7d-usd", comparator: "abs-gte", thresholdValue: 30_000_000, thresholdLabel: "$30M 7d move", symbol, rationale: "Follow-through matters.", detail: "The move has follow-through." }] };
    expect(buildDigestIntelligence(today, prior).forwardLookOutcomes?.[0]).toMatchObject({ status: "hit", triggerId: "trigger:supply-7d:usdc" });
  });
  it("makes unavailable FTQ explicit and emits the canonical safety-map prompt", () => {
    const unavailable: DigestInputData = { ...current, mintBurnFlows: { gaugeScore: 0, gaugeBand: "NEUTRAL", classificationSource: "unavailable", classificationReason: "identity-missing", safetyScoreIdentity: null, flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 }, topPressure: [] } };
    expect(buildUserPrompt(unavailable)).toContain("Flight-to-Quality: unavailable (identity-missing)");
    expect(buildDigestIntelligence(unavailable, null).riskTape).toContainEqual(expect.objectContaining({ detail: expect.stringContaining("unavailable") }));
    const mapSummary = VALID_CAPTURE_MAP_SUMMARY;
    const data: DigestInputData = { totalMcapUsd: 100e9, mcap7dDelta: 0, activeDepegCount: 0, topDepegs: [], biggestSupplyChange: null, stabilityIndex: null, yesterdayIndex: null, safetyContext: BASE_SAFETY_CONTEXT };
    const resolution = { kind: "available" as const, imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-08-30", freshness: "carried-forward" as const, ageDays: 2, manifest: { date: "2026-08-30", asOfSec: 1_788_000_000, renderedAtSec: 1_788_001_000, edition: "daily" as const, bytes: { png: 1_000_000 }, mapSummary } };
    const capture = buildDigestSafetyMapCapture(data, resolution);
    expect(capture).not.toBeNull();
    expect(capture).toMatchObject({ manifest: { mapSummary: { date: "2026-08-30" } } });
    expect(buildUserPrompt({ ...data, safetyMap: capture! })).toContain("A tier: 2 coins, 70.0% of known mapped supply");
    expect(buildDigestSafetyMapCapture(data, { ...resolution, manifest: { ...resolution.manifest, date: "2026-08-29" } })).toBeNull();
    const unavailableSafetyData: DigestInputData = { ...data, safetyContext: { status: "unavailable", expectedModel: "v9", identity: null, publishedAt: null, reason: "held" } };
    expect(buildDigestSafetyMapCapture(unavailableSafetyData, resolution)).toBeNull();
  });
  it.each([["CALM", { ...BASE_DIGEST_INPUT, activeDepegCount: 0, topDepegs: [] }], ["CRISIS", { ...BASE_DIGEST_INPUT, mintBurnFlows: { gaugeScore: -20, gaugeBand: "CAUTIOUS", flightToQuality: { active: true, safeNetUsd: 200e6, riskyNetUsd: -200e6 }, topPressure: [] } }], ["CRISIS", { ...BASE_DIGEST_INPUT, stabilityIndex: { score: 65, band: "TREMOR", components: { severity: 30, breadth: 5, trend: -3 } } }], ["TENSION", { ...BASE_DIGEST_INPUT, dewsStress: { bandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 }, yesterdayBandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 }, bandChangeCount: 0, alertPlusMcapUsd: 2e9, alertPlusSupplyCoverage: { complete: true, observedCount: 3, unavailableCount: 0 }, bandChanges: [], elevatedCoins: [{ symbol: "USDT", band: "ALERT", score: 50, mcapUsd: 2e9 }] } }], ["WATCHFUL", { ...BASE_DIGEST_INPUT, activeDepegCount: 1, topDepegs: [{ symbol: "USDT", bps: 5, mcapUsd: 100e9 }] }]] as const)("classifies %s regime", (expected, data) => expect(classifyRegime(data as DigestInputData)).toBe(expected));
  it.each(PSI_CONDITION_BAND_VALUES)("classifies PSI band %s and its reader-facing tape tone", (band) => {
    const input: DigestInputData = {
      ...BASE_DIGEST_INPUT, activeDepegCount: 0, topDepegs: [], mintBurnFlows: undefined, dewsStress: undefined,
      stabilityIndex: { score: 50, band, components: { severity: 0, breadth: 0, trend: 0 } },
    };
    expect(classifyRegime(input)).toBe(band === "BEDROCK" || band === "STEADY" ? "CALM" : "CRISIS");
    const psi = buildRiskTape(input).find((item) => item.id === "risk-tape:psi");
    expect(psi?.value).toContain(band);
    expect(psi?.tone).toBe(band === "BEDROCK" ? "positive" : band === "STEADY" ? "neutral" : band === "TREMOR" ? "warning" : "critical");
    expect(buildUserPrompt(input)).toContain(`Market regime: ${classifyRegime(input)}`);
  });
  it.each([
    [110e9, "10.00% above", "10% above"],
    [100e9, "at", "at"],
    [90e9, "10.00% below", "10% below"],
  ] as const)("renders total and coin ATH distances at current cap %s", (currentMcap, totalComparison, coinComparison) => {
    const prompt = buildUserPrompt({
      ...BASE_DIGEST_INPUT,
      totalMcapUsd: currentMcap, supplyCoverage: { complete: true, observedCount: 1, unavailableCount: 0 },
      totalMcapAth: { value: 100e9, date: 1_770_000_000, daysAgo: 10 },
      biggestSupplyChange: { id: "usdt-tether", symbol: "USDT", name: "Tether", changeUsd: 1e9, currentMcap },
      historicalContext: {
        psiPrecedent: null, psiBandStreak: 1, digestTrackingDays: 30,
        supplyMoverContext: { allTimeHighMcap: 100e9, allTimeHighDate: 1_770_000_000, largestWeeklyChange: 2e9, largestWeeklyChangeDate: 1_770_000_000, largestWeeklyChangeDaysAgo: 10 },
      },
    });
    expect(prompt).toContain(`total mcap is ${totalComparison} its Digest-window ATH`);
    expect(prompt).toContain(`Current mcap is ${coinComparison} ATH`);
    expect(prompt).not.toMatch(/-\d+\.\d+% (?:above|below).*ATH|-\d+% (?:above|below).*ATH/);
  });
  it("keeps the prompt register and V9 pillars canonical", () => {
    expect(SYSTEM_PROMPT.startsWith(buildEditorialPrompt("daily"))).toBe(true);
    expect(SYSTEM_PROMPT).toContain(`Allowed tones: ${ALLOWED_TONES.join(", ")}.`);
    expect(SYSTEM_PROMPT).not.toContain("FORBIDDEN TICS");
    expect(scanEditorialText(DAILY_EXEMPLAR, { register: "daily" }).filter(({ severity }) => severity === "hard")).toEqual([]);
    const pillar = { score: 91, evidenceLevel: "strong" as const, freshness: "current" as const, reasons: [] };
    const safetyPromptData: DigestInputData = { ...BASE_DIGEST_INPUT, safetyScores: { model: "v9", mentionedCoins: [{ symbol: "USDT", grade: "A+", score: 88, pillars: { backing: pillar, exit: { ...pillar, score: 86 }, control: { ...pillar, score: 84 } }, reasonCodes: ["bounded-mechanism-review"], caps: [], bindingCap: null }], gradeDistribution: { "A+": 1 }, provenance: { ...BASE_SAFETY_CONTEXT.identity, publishedAt: BASE_SAFETY_CONTEXT.publishedAt } } };
    expect(buildUserPrompt(safetyPromptData)).toContain("backing=91, exit=86, control=84");
  });
});

describe("market and risk collectors", () => {
  it.each(["complete", "page-failure", "count-mismatch"] as const)(
    "drains indexed 500-row organic identity pages before stamping %s accounting",
    async (mode) => {
      const snapshot = canonicalSafetySource([
        { id: "usdt-tether", overallGrade: "A", overallScore: 88 },
        { id: "dai-makerdao", overallGrade: "B", overallScore: 70 },
      ]);
      vi.mocked(loadActiveSafetyScoreCohort).mockResolvedValueOnce(snapshot);
      const scores = await collectSafetyScores(ctxFor([]), new Set(["USDT"]));
      expect(scores.value.safetyContext).toMatchObject({ status: "available", expectedModel: "v9" });
      expect(scores.value.safetyScores).toMatchObject({
        model: "v9", mentionedCoins: [{ symbol: "USDT", grade: "A", score: 88 }],
      });
      const identity = scores.value.safetyIdentity!;
      const { sqlite } = nativeQuoteFixtures.open();
      const now = Math.floor(Date.now() / 1000);
      const insert = sqlite.prepare(`INSERT INTO safety_score_history_v2 (
        history_id, stablecoin_id, recorded_at, model, identity_schema_version,
        methodology_version, policy_id, policy_digest, evaluation_build_digest,
        base_input_generation_id, model_publication_generation_id, transition_kind,
        grade, score, prev_grade, prev_score, created_at
      ) VALUES (?, ?, ?, 'v9', ?, ?, ?, ?, ?, ?, ?, ?, 'A-', ?, ?, ?, ?)`);
      const add = (id: string, at: number, coin = "usdt-tether", score = 80, prior = 85,
        build = identity.evaluationBuildDigest, kind = "organic-grade-change", policy = identity.policyDigest) =>
        insert.run(id, coin, at, identity.schemaVersion, identity.methodologyVersion, identity.policyId,
          policy, build, identity.baseInputGenerationId, identity.publicationGenerationId, kind, score,
          kind === "organic-grade-change" ? "A" : null, kind === "organic-grade-change" ? prior : null, now);
      // A same-time tie spans three pages, without activating the unchanged 80% bump rule.
      for (let index = 0; index < 1003; index++) {
        add(`eligible:${String(index).padStart(4, "0")}`, now - 60, "usdt-tether", index % 2 ? 80 : 90);
      }
      // The raw top ten are ineligible; they must not crowd out eligible detail or census rows.
      for (let index = 0; index < 12; index++) add(`small:${index}`, now - 120 - index, "dai-makerdao", 0, 100);
      for (let index = 0; index < 16; index++) add(`bump:${index}`, now - 300, "usdt-tether", 100, 0);
      add("wrong-build", now - 400, "usdt-tether", 0, 100, "1".repeat(64));
      add("wrong-policy", now - 401, "usdt-tether", 0, 100, undefined, undefined, "2".repeat(64));
      add("baseline", now - 402, "usdt-tether", 0, 100, undefined, "methodology-boundary-baseline");
      add("outside-start", now - 172801);
      add("at-start", now - 172800);
      add("at-end", now);
      let pages = 0;
      const plans: string[] = [];
      const db = createSqliteD1(sqlite, { onAll(sql) {
        if (!sql.includes("SELECT history_id, recorded_at")) return;
        pages++;
        if (pages === 1) {
          const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...Array(sql.split("?").length - 1).fill(null));
          plans.push(...plan.map((row) => String(row.detail)));
          if (mode === "count-mismatch") add("concurrent-insert", now - 30);
        }
        if (mode === "page-failure" && pages === 2) throw new Error("second D1 page failed");
      } });
      const result = await collectGradeTransitions(makeCollectorCtx(db), scores.value.safetyGrades, identity);
      if (mode === "complete") {
        expect(result.degradedReasons).toEqual([]);
        expect(result.value.gradeTransitions).toHaveLength(5);
        expect(result.value.gradeTransitions?.every((row) => row.symbol === "USDT")).toBe(true);
        expect(result.value.gradeTransitions?.[0]).toMatchObject({ symbol: "USDT", fromGrade: "A", toGrade: "A-" });
        const accounting = result.value.gradeTransitionAccounting!;
        expect(accounting).toMatchObject({ complete: true, count: 1004, window: { start: now - 172800, end: now } });
        if (accounting.complete) {
          expect(new Set(accounting.identities.map((row) => row.historyId)).size).toBe(1004);
          expect(accounting.identities[0]).toEqual({ historyId: "at-start", recordedAt: now - 172800 });
        }
        expect(pages).toBe(3);
      } else {
        expect(result.degradedReasons).toEqual(["grade-transitions-query"]);
        expect(result.value.gradeTransitionAccounting).toMatchObject({ complete: false, reason: "grade-transitions-query" });
        expect(result.value.gradeTransitionAccounting).not.toHaveProperty("identities");
        expect(result.value.gradeTransitions).toBeUndefined();
        expect(pages).toBe(mode === "page-failure" ? 2 : 3);
      }
      expect(plans.some((detail) =>
        /SEARCH safety_score_history_v2 USING INDEX idx_safety_score_history_v2_recorded_at.*recorded_at>.*recorded_at</.test(detail))).toBe(true);
    },
  );
  it.each([["missing", () => missingPublishedGaugeTable(), undefined, [], ["mint-burn-gauge-missing"]], ["malformed", () => publishedGaugeTable({ value: '{"gauge":{"score":"nope"}}' }), undefined, ["mint-burn-gauge-malformed"], []], ["expired", () => publishedGaugeTable({ ageSec: 25 * 3600 }), undefined, ["mint-burn-gauge-expired"], []], ["stale", () => publishedGaugeTable({ ageSec: 3 * 3600 }), PUBLISHED_GAUGE_SCORE, ["mint-burn-gauge-stale"], []]] as const)("handles %s published gauge", async (_label, table, score, reasons, qualityReasons) => { const result = await collectMintBurnFlows(ctxFor([table()])); expect(result.value?.gaugeScore).toBe(score); expect(result.degradedReasons).toEqual(reasons); expect(result.qualityReasons ?? []).toEqual(qualityReasons); });
  it("re-bins the published gauge, includes FTQ chains, and never reads hourly rows", async () => {
    const db = mockD1([publishedGaugeTable()]); const result = await collectMintBurnFlows(makeCollectorCtx(db));
    expect(result.value).toMatchObject({ gaugeScore: PUBLISHED_GAUGE_SCORE, gaugeBand: "HEALTHY", classificationSource: "safety-score-v9-publication", topChains: [{ chainId: "ethereum", netUsd: 150e6 }, { chainId: "arbitrum", netUsd: -3e6 }] });
    expect(result.value?.topPressure.map(({ symbol }) => symbol)).toEqual(["USDT", "USDC"]); expect(buildUserPrompt({ ...BASE_DIGEST_INPUT, mintBurnFlows: result.value! })).toContain("Top chains by net flow"); expect(db.getHistory().some(({ sql }) => sql.includes("mint_burn_hourly"))).toBe(false);
  });
  it.each([
    ["USG idle inventory burn", 3_860_000, 3_860_000, false],
    ["confirmed redemption", 40_710_000, 3_860_000, true],
    ["missing supply evidence", undefined, undefined, false],
    ["opposite supply move", 3_860_000, 40_710_000, false],
  ] as const)("admits pressure against independent history: %s", async (_label, before, after, admitted) => {
    const ctx = ctxFor([]);
    const end = ctx.todayTs + 8 * 3600;
    const baseCoins = publishedGaugePayload().coins as Record<string, unknown>[];
    const usg = { ...baseCoins[0], stablecoinId: "usg-tangent", symbol: "USG",
      pressureShiftScore: -100, netFlow24hUsd: -36_850_000, gaugeWeightUsd: 3_860_000 };
    const small = { ...usg, stablecoinId: "small", symbol: "SMALL", pressureShiftScore: 50, netFlow24hUsd: -10_000 };
    const db = mockD1([
      publishedGaugeTable({ value: JSON.stringify(publishedGaugePayload({
        gauge: { score: -15.5, partialValuationInputs: 0, scoredMcapUsd: 67.7e9 },
        window: { start: end - 86400, end, semantics: "closed-utc-hours" },
        coins: [usg, ...baseCoins, small],
      })) }),
      { match: "FROM supply_history WHERE stablecoin_id IN", matchBinds: ["usg-tangent", ctx.todayTs - 86400, ctx.todayTs],
        rows: before == null ? [] : [
          { stablecoin_id: "usg-tangent", snapshot_date: ctx.todayTs - 86400, circulating_usd: before },
          { stablecoin_id: "usg-tangent", snapshot_date: ctx.todayTs, circulating_usd: after },
        ] },
    ]);
    const result = await collectMintBurnFlows({ ...ctx, db });
    const symbols = result.value!.topPressure.map((coin) => coin.symbol);
    expect(symbols.includes("USG")).toBe(admitted);
    expect(symbols).toHaveLength(3);
    expect(symbols.includes("SMALL")).toBe(!admitted);
    expect(result.degradedReasons).toEqual([]);
    if (admitted) {
      expect(result.value!.topPressure.find((coin) => coin.symbol === "USG")?.gaugeWeightShare).toBeCloseTo(3.86e6 / 67.7e9);
    } else {
      expect(result.qualityReasons).toContain(before == null
        ? "mint-burn-pressure-supply-unavailable" : "mint-burn-pressure-supply-unconfirmed");
      const input = { ...BASE_DIGEST_INPUT, mintBurnFlows: result.value };
      expect(buildUserPrompt(input)).not.toContain("USG");
      expect(buildEditorialCandidates(input).some((candidate) => candidate.symbols.includes("USG"))).toBe(false);
    }
  });

  it("isolates a failed supply confirmation query from small pressure and the gauge", async () => {
    const ctx = ctxFor([]);
    const baseCoins = publishedGaugePayload().coins as Record<string, unknown>[];
    const result = await collectMintBurnFlows({ ...ctx, db: mockD1([
      publishedGaugeTable({ value: JSON.stringify(publishedGaugePayload({
        window: { start: ctx.todayTs - 86400, end: ctx.todayTs, semantics: "closed-utc-hours" },
        coins: [...baseCoins, { ...baseCoins[0], stablecoinId: "usg-tangent", symbol: "USG",
          pressureShiftScore: -100, netFlow24hUsd: -36_850_000, gaugeWeightUsd: 3_860_000 }],
      })) }),
      { match: "FROM supply_history WHERE stablecoin_id IN", rows: [], throwError: new Error("D1 unavailable") },
    ]) });
    expect(result.value?.gaugeScore).toBe(PUBLISHED_GAUGE_SCORE);
    expect(result.value?.topPressure.map((coin) => coin.symbol)).toEqual(["USDT", "USDC"]);
    expect(result.degradedReasons).toContain("mint-burn-pressure-supply-query");
    expect(result.qualityReasons).toContain("mint-burn-pressure-supply-unavailable");
  });

  it.each([[3.86e6 / 67.7e9, false], [0.009999, false], [0.01, true], [undefined, false], [null, false]] as const)(
    "gates per-coin gauge facts and next triggers at scored weight share %s", (gaugeWeightShare, material) => {
      const input: DigestInputData = { ...BASE_DIGEST_INPUT, topDepegs: [], stabilityIndex: null,
        mintBurnFlows: { gaugeScore: -15.5, gaugeBand: "CAUTIOUS",
          flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 },
          topPressure: [{ symbol: "USG", intensity: -100, net24hUsd: -100_000, gaugeWeightShare }],
        } };
      const candidates = buildEditorialCandidates(input).filter((candidate) => candidate.kind === "mint-burn");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].headlineFacts.some((fact) => fact.includes("Bank Run Gauge"))).toBe(material);
      if (gaugeWeightShare != null && !material) expect(candidates[0].headlineFacts.join(" ")).toContain("negligible");
      if (gaugeWeightShare == null) expect(candidates[0].headlineFacts.join(" ")).toContain("unavailable");
      expect(buildUserPrompt(input)).toContain(candidates[0].headlineFacts.find((fact) => fact.includes("weight share"))!);
      expect(buildNextTriggers({ ...input, editorialCandidates: candidates })
        .some((trigger) => trigger.metric === "bank-run-gauge")).toBe(material);
      expect(SYSTEM_PROMPT).toContain("never link its flow to aggregate gauge movement");
    },
  );
  it.each(["2026-03-06T11:59:59Z", "2026-03-06T12:00:01Z"])(
    "persists the retained producer window rather than the collection hour at %s", async (collectedAt) => {
      vi.setSystemTime(new Date(collectedAt));
      const window = { start: 1_772_697_600, end: 1_772_784_000, semantics: "closed-utc-hours" };
      const publishedAt = Math.floor(new Date("2026-03-06T08:05:00Z").getTime() / 1000);
      const updatedAt = publishedAt - 600;
      const ageSec = Math.floor(Date.now() / 1000) - publishedAt;
      const scenario = makeDailyDigestScenario({ db: { prependTables: [publishedGaugeTable({
        ageSec, value: JSON.stringify(publishedGaugePayload({ window, updatedAt })),
      })] } });
      vi.mocked(loadStablecoinsCache).mockResolvedValue(scenario.sourcePayload);
      const { inputData } = await buildDailyDigestInput(scenario.db);
      const { sqlite } = nativeQuoteFixtures.open();
      const generatedAt = Math.floor(Date.now() / 1000);
      await insertDigestRecord({ db: createSqliteD1(sqlite), generatedAt, inputData,
        digestText: "Retained source capture.", digestTitle: "Source capture", digestExtended: null, digestMeta: null });
      const stored = sqlite.prepare("SELECT input_data FROM daily_digest WHERE generated_at = ?").get(generatedAt) as
        { input_data: string };
      const captured = parseStoredDigestInput(stored.input_data)!;
      expect(captured.mintBurnFlows?.provenance).toEqual({ window, publishedAt, updatedAt });
      expect(JSON.stringify(captured.mintBurnFlows?.provenance?.window)).toBe(JSON.stringify(window));
      expect(captured.dataQuality?.windows.mintBurnFlows).toEqual({
        label: "24 closed UTC hours", start: window.start, end: window.end,
      });
      expect(captured.dataQuality?.degradedSources).toContain("mint-burn-gauge-stale");
    },
  );
  it.each([undefined, { start: "unreadable", end: 123, semantics: "closed-utc-hours" }])(
    "leaves legacy or unreadable producer windows unavailable: %j", async (window) => {
      const scenario = makeDailyDigestScenario({ db: { prependTables: [publishedGaugeTable({
        value: JSON.stringify(publishedGaugePayload({ window })),
      })] } });
      vi.mocked(loadStablecoinsCache).mockResolvedValue(scenario.sourcePayload);
      const { inputData } = await buildDailyDigestInput(scenario.db);
      expect(inputData.mintBurnFlows?.provenance).toMatchObject({ window: null, updatedAt: null });
      expect(inputData.dataQuality?.windows.mintBurnFlows).toEqual({
        label: "unavailable", start: null, end: null,
      });
      const prompt = buildUserPrompt(inputData);
      expect(prompt).toContain("Mint/burn window: unavailable");
      expect(prompt).not.toContain("1970-01-01");
    },
  );
  it.each([
    ["no prior-week buckets", () => undefined, null, 0],
    ["every prior-week bucket zero-delta (measured flat)", (c: number) => c, 0, 2],
    ["partial prior-week coverage", (c: number, i: number) => (i === 0 ? c - 5_000_000 : undefined), 5_000_000, 1],
  ])("%s: seven-day change is null only when no comparison pair exists", async (_name, prior, expected, coveredCoins) => {
    const scenario = makeDailyDigestScenario();
    const source = scenario.sourcePayload as unknown as { payload: { peggedAssets: Array<Record<string, unknown> & { circulating: { peggedUSD: number } }> } };
    source.payload.peggedAssets = source.payload.peggedAssets.map((asset, index) => {
      const previous = prior(asset.circulating.peggedUSD, index);
      const { circulatingPrevWeek: _drop, ...rest } = asset;
      return previous === undefined ? rest : { ...rest, circulatingPrevWeek: { peggedUSD: previous } };
    });
    vi.mocked(loadStablecoinsCache).mockResolvedValue(scenario.sourcePayload);
    const { inputData } = await buildDailyDigestInput(scenario.db);
    expect(inputData.mcap7dDelta).toBe(expected);
    expect(inputData.mcap7dDeltaCoverage?.coveredCoins).toBe(coveredCoins);
    const line = buildUserPrompt(inputData).split("\n").find((l) => l.startsWith("7-day market cap change:"))!;
    if (expected === null) expect(line).toBe("7-day market cap change: unavailable (no-7d-comparison-pairs)");
    else expect(line).toContain(expected === 0 ? "+$0" : "+$5.00M");
  });
  it("records the cache-fallback seven-day change as unavailable, never zero", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValue({ kind: "unavailable", reason: "stablecoins-cache-missing" } as never);
    const { inputData } = await buildDailyDigestInput(makeDailyDigestScenario().db);
    expect(inputData.mcap7dDelta).toBeNull();
  });
  it("never restates flow claims that missing valuation could alter", async () => {
    const partialMint = {
      window24h: { completeness: "partial", mintCompleteness: "partial", burnCompleteness: "complete", unpricedMintEventCount: 1, unpricedBurnEventCount: 0 },
      baseline: "complete", netFlow7d: "partial", netFlow30d: "partial", netFlow90d: "partial",
    };
    const base = publishedGaugePayload();
    const coins = base.coins as Record<string, unknown>[];
    // Mixed USDC: unpriced mint plus priced burns; USDT's baseline is partial.
    const mixed = publishedGaugePayload({
      coins: [{ ...coins[0], valuation: { ...(coins[0].valuation as object), baseline: "partial" } }, { ...coins[1], valuation: partialMint }, coins[2]],
      chains: [{ chainId: "ethereum", netFlow24hUsd: 150_000_000, valuation: "partial" }, { chainId: "arbitrum", netFlow24hUsd: -3_000_000, valuation: "complete" }],
    });
    const result = await collectMintBurnFlows(ctxFor([publishedGaugeTable({ value: JSON.stringify(mixed) })]));
    expect(result.value?.topPressure).toEqual([]);
    expect(result.value?.topChains).toEqual([{ chainId: "arbitrum", netUsd: -3e6 }]);

    // Withheld weight is judged by whether it could move the score (37.5, HEALTHY) across a band edge.
    const withWithheld = (gauge: Record<string, unknown>) => collectMintBurnFlows(ctxFor([publishedGaugeTable({
      value: JSON.stringify(publishedGaugePayload({ gauge: { ...(base.gauge as object), ...gauge } })),
    })]));
    // ~$58M withheld beside ~$300B scored moves the score by at most ~0.03: the gauge is kept, named.
    const small = await withWithheld({ partialValuationInputs: 3, partialValuationMcapUsd: 58e6, scoredMcapUsd: 300e9 });
    expect(small.value).toMatchObject({ gaugeScore: PUBLISHED_GAUGE_SCORE, gaugeBand: "HEALTHY" });
    expect(small.qualityReasons).toContain("mint-burn-gauge-valuation-partial-band-stable");
    // Equal withheld and scored weight could lift the score to 68.75 (CONFIDENT): withheld as a named quality finding.
    const large = await withWithheld({ partialValuationInputs: 1, partialValuationMcapUsd: 100e9, scoredMcapUsd: 100e9 });
    // A withheld count without published weights (pre-v6.23 producer) is unbounded.
    const unweighted = await withWithheld({ partialValuationInputs: 1 });
    for (const withheld of [large, unweighted]) {
      expect(withheld.value).toBeUndefined();
      expect(withheld.degradedReasons).toEqual(["mint-burn-gauge-valuation-partial"]);
      expect(withheld.qualityReasons).toEqual(["mint-burn-gauge-valuation-partial"]);
    }

    // Band-stable uncertainty still cannot cross numeric regime/tape cutoffs.
    for (const score of [-48, -19, -10, 20]) {
      const withheld = await withWithheld({ score, partialValuationInputs: 1, partialValuationMcapUsd: 5, scoredMcapUsd: 100 });
      expect(withheld.value).toBeUndefined();
      expect(withheld.qualityReasons).toEqual(["mint-burn-gauge-valuation-partial"]);
      const input: DigestInputData = { ...BASE_DIGEST_INPUT, topDepegs: [], dewsStress: undefined, mintBurnFlows: withheld.value, degradedSources: withheld.degradedReasons };
      expect(classifyRegime(input)).toBe("WATCHFUL");
      expect(buildRiskTape(input).some((item) => item.id === "risk-tape:gauge")).toBe(false);
    }
    const robustStress = await withWithheld({ score: -60, partialValuationInputs: 1, partialValuationMcapUsd: 1, scoredMcapUsd: 100 });
    expect(robustStress.value?.gaugeScore).toBe(-60);

    // A publication predating completeness is unknown: nets and pressure are not restated.
    const legacy = publishedGaugePayload({
      gauge: { score: PUBLISHED_GAUGE_SCORE, band: "HEALTHY", flightToQuality: false, flightIntensity: 0 },
      coins: coins.map(({ valuation: _valuation, ...coin }) => coin),
      chains: [{ chainId: "ethereum", netFlow24hUsd: 150_000_000 }],
    });
    const legacyResult = await collectMintBurnFlows(ctxFor([publishedGaugeTable({ value: JSON.stringify(legacy) })]));
    expect(legacyResult.value).toMatchObject({ gaugeScore: PUBLISHED_GAUGE_SCORE, topPressure: [], topChains: [] });
    expect(legacyResult.qualityReasons).toContain("mint-burn-valuation-unknown");
  });
  const activeRows = { usdc: { stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below", peak_deviation_bps: -100, started_at: 0 }, usdt: { stablecoin_id: "usdt-tether", symbol: "USDT", direction: "below", peak_deviation_bps: -500, peak_price: 0.95, peg_reference: 1, started_at: 0 } };
  it.each([["sorts and suppresses", [{ ...activeRows.usdc }, { stablecoin_id: "dai-makerdao", symbol: "DAI", direction: "above", peak_deviation_bps: 500, started_at: 0 }], { first: "USDC", suppressed: true }], ["keeps critical", [activeRows.usdt, { ...activeRows.usdc, peak_deviation_bps: -5200 }, { ...activeRows.usdc, stablecoin_id: "dai-makerdao", symbol: "DAI2", peak_deviation_bps: 150 }, { stablecoin_id: "dai-makerdao", symbol: "DAI", direction: "above", peak_deviation_bps: 500, started_at: 0 }], { count: 4, unsuppressed: true }], ["uses peak", [activeRows.usdc], { bps: -100 }], ["filters frozen", [{ ...activeRows.usdc, stablecoin_id: "usr-resolv", symbol: "USR", peak_deviation_bps: -9025 }, activeRows.usdc], { count: 1 }], ["uses stale peak", [{ ...activeRows.usdc, peak_deviation_bps: -3000, peak_price: 0.7, peg_reference: 1 }], { bps: -3000, basis: "peak-fallback" }]] as const)("%s", async (_label, rows, expected) => {
    const ctx = ctxFor(depegTable(rows.map((row) => ({ ...row, started_at: Math.floor(Date.now() / 1000) - 3600 }))));
    if ("basis" in expected) ctx.stablecoinsCacheIsFresh = false;
    if ("unsuppressed" in expected && expected.unsuppressed) ctx.stablecoinAssetById.set("usdc-circle", { ...ctx.stablecoinAssetById.get("usdc-circle")!, price: 0.48 });
    const result = await collectActiveDepegs(ctx);
    if ("first" in expected) expect(result.value.topDepegs[0].symbol).toBe(expected.first);
    if ("suppressed" in expected && expected.suppressed) expect(result.value.topDepegs[1].suppressReason).toContain("sub-$20M");
    if ("count" in expected) expect(result.value.topDepegs).toHaveLength(expected.count);
    if ("unsuppressed" in expected && expected.unsuppressed) expect(result.value.topDepegs[0].suppressReason).toBeUndefined();
    if ("bps" in expected) expect(result.value.topDepegs[0].bps).toBe(expected.bps);
    if ("basis" in expected) expect(result.value.topDepegs[0].severityBasis).toBe(expected.basis);
  });
  it("tracks a monitored variant without putting it in core aggregates", async () => {
    const ctx = ctxFor(depegTable([{ stablecoin_id: "susds-sky", symbol: "sUSDS", direction: "below", peak_deviation_bps: -125, started_at: 0 }])); const variant = makeAsset({ id: "susds-sky", symbol: "sUSDS", circulating: { peggedUSD: 1e9 } });
    ctx.trackedStablecoinAssets.push(variant); (ctx.trackedStablecoinIds as Set<string>).add(variant.id); ctx.stablecoinAssetById.set(variant.id, variant); ctx.mcapById.set(variant.id, 1e9);
    const result = await collectActiveDepegs(ctx); expect(ctx.coreAggregateStablecoinIds.has(variant.id)).toBe(false); expect(result.value.topDepegs[0]).toMatchObject({ stablecoinId: "susds-sky", symbol: "sUSDS" });
  });

  it.each([
    ["persisted native", "live", "native-peg", "fresh", false, 1],
    ["inferred live native", "live", null, "fresh", false, 1],
    ["historical native provenance", "backfill", "native-peg", "fresh", false, 1],
    ["native start observation", "live", "native-peg", "missing", true, 1],
    ["missing native", "live", "native-peg", "missing", false, 1],
    ["expired native", "live", "native-peg", "expired", false, 1],
    ["future native", "live", "native-peg", "future", false, 1],
    ["malformed native", "live", "native-peg", "malformed", false, 1],
    ["legacy USD reference", "backfill", null, "fresh", false, 1.1],
    ["explicit USD provenance", "live", "usd", "fresh", false, 1],
  ] as const)("keeps %s event facts and clocks in their quote domain", async (_label, source, quoteMode, quoteState, recentStart, pegReference) => {
    const { db, sqlite } = nativeQuoteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const startedAt = now - (recentStart ? 60 : 86400);
    sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
      VALUES (101, 'eurc-circle', 'EURC', 'peggedEUR', 'below', -500, ?, 0.98, 0.95, ?, ?)`)
      .run(startedAt, pegReference, source);
    if (quoteMode != null) sqlite.prepare(`INSERT INTO depeg_event_provenance
      (event_id, source_kind, quote_mode, created_at, updated_at) VALUES (101, ?, ?, ?, ?)`)
      .run(source, quoteMode, now, now);
    const quoteAt = quoteState === "expired" ? now - PSI_NATIVE_EVIDENCE_MAX_AGE_SEC
      : quoteState === "future" ? now + 60 : now - 30;
    if (quoteState !== "missing") sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(`${NATIVE_EVENT_QUOTE_CACHE_PREFIX}101`,
        quoteState === "malformed" ? "{invalid" : JSON.stringify({ value: 0.98, observedAt: quoteAt, source: "coingecko" }), quoteAt);
    const ctx = makeCollectorCtx(db);
    const asset = makeAsset({ id: "eurc-circle", symbol: "EURC", pegType: "peggedEUR", price: 1.1, priceObservedAt: now });
    (ctx.trackedStablecoinIds as Set<string>).add(asset.id);
    ctx.stablecoinAssetById.set(asset.id, asset);
    ctx.mcapById.set(asset.id, 100e6);
    const result = await collectActiveDepegs(ctx);
    expect(result.degradedReasons).toEqual([]);
    expect(result.value.activeDepegCount).toBe(1);
    const fact = result.value.topDepegs[0];
    const native = quoteMode === "native-peg" || (quoteMode == null && source === "live");
    if (!native) {
      expect(fact).toMatchObject({ quoteMode: "usd", currentPriceUsd: 1.1, currentBps: pegReference === 1 ? 1000 : 0, priceObservedAt: now, severityBasis: "current" });
      expect(fact.currentPriceNative).toBeUndefined();
    } else {
      expect(fact).toMatchObject({ quoteMode: "native-peg", peakPriceNative: 0.95 });
      expect(fact.currentPriceUsd).toBeUndefined();
      expect(fact.peakPriceUsd).toBeUndefined();
      if (quoteState === "fresh" || recentStart) {
        expect(fact).toMatchObject({ currentPriceNative: 0.98, currentBps: -200, priceObservedAt: recentStart ? startedAt : quoteAt, severityBasis: "current" });
      } else {
        expect(fact).toMatchObject({ bps: -500, severityBasis: "peak-fallback" });
        expect(fact.currentBps).toBeUndefined();
        expect(fact.currentPriceNative).toBeUndefined();
        expect(fact.priceObservedAt).toBeUndefined();
      }
    }
  });
  it("covers velocity and silent collector failures", async () => {
    const now = ctxFor([]).todayTs; const rows = [{ stablecoin_id: "usdt-tether", snapshot_date: now, circulating_usd: 101.4e9 }, { stablecoin_id: "usdt-tether", snapshot_date: now - 86_400, circulating_usd: 101.35e9 }, { stablecoin_id: "usdt-tether", snapshot_date: now - 7 * 86_400, circulating_usd: 100e9 }];
    expect((await collectSupplyVelocity(ctxFor([{ match: "FROM supply_history WHERE stablecoin_id IN", rows }]))).value).toEqual([expect.objectContaining({ coin: "USDT", signal: "decelerating" })]);
    expect((await collectResolvedDepegs(ctxFor([{ match: "depeg_events", rows: [], throwError: new Error("boom") }]))).degradedReasons).toContain("resolved-depegs-query");
    expect((await collectLiquidityShifts(ctxFor([{ match: "dex_liquidity", rows: [], throwError: new Error("boom") }]))).degradedReasons).toContain("liquidity-shifts-query");
  });
  it("collects PSI contributors across empty, stale, malformed, and query-failure boundaries", async () => {
    const query = "SELECT input_snapshot, stored_at FROM stability_index_samples"; const contributors = [{ id: "usdt-tether", symbol: "USDT", bps: 10, mcapUsd: 100e9, ageDays: 1, factor: 1.5 }, { id: "usdc-circle", symbol: "USDC", bps: 20, mcapUsd: 50e9, ageDays: 2, factor: 1.2 }, { id: "frax-finance", symbol: "FRAX", bps: 30, mcapUsd: 1e9, ageDays: 3, factor: 2 }];
    const good = await collectPsiContributors(ctxFor([{ match: query, first: { stored_at: Math.floor(Date.now() / 1000) - 600, input_snapshot: JSON.stringify({ contributors }) }, rows: [] }])); expect(good.value).toHaveLength(3); expect(good.value![0].symbol).toBe("USDT");
    for (const firstValue of [null, { stored_at: Math.floor(Date.now() / 1000) - 600, input_snapshot: JSON.stringify({ contributors: [] }) }]) expect((await collectPsiContributors(ctxFor([{ match: query, first: firstValue, rows: [] }]))).value).toBeUndefined();
    expect((await collectPsiContributors(ctxFor([{ match: query, first: { stored_at: Math.floor(Date.now() / 1000) - 3 * 3600, input_snapshot: JSON.stringify({ contributors }) }, rows: [] }]))).degradedReasons).toContain("psi-contributors-stale");
    expect((await collectPsiContributors(ctxFor([{ match: query, rows: [], throwError: new Error("down") }]))).degradedReasons).toContain("psi-contributors-query");
  });
  it("ranks finite signed PSI contributors by absolute impact without a 10000-bps ceiling", async () => {
    const contributors = [
      { symbol: "NEG", bps: -200, mcapUsd: 100e9, factor: 1 },
      { symbol: "ABOVE", bps: 15000, mcapUsd: 1e9, factor: 1 },
      { symbol: "POS", bps: 100, mcapUsd: 20e9, factor: 1 },
      { symbol: "SMALL", bps: -20, mcapUsd: 1e9, factor: 1 },
      ...[{ bps: "nonfinite" }, { bps: null }, { bps: "200" }, { mcapUsd: "nonfinite" }, { factor: "nonfinite" }, { factor: -1 }, { mcapUsd: 0 }].map((invalid) => ({
        symbol: "INVALID", bps: 50000, mcapUsd: 100e9, factor: 1, ...invalid,
      })),
    ];
    const result = await collectPsiContributors(ctxFor([{
      match: "SELECT input_snapshot, stored_at FROM stability_index_samples", rows: [],
      first: { stored_at: Math.floor(Date.now() / 1000) - 600, input_snapshot: JSON.stringify({ contributors }).replaceAll('"nonfinite"', "1e999") },
    }]));
    expect(result.degradedReasons).toEqual([]);
    expect(result.value).toEqual([
      { symbol: "NEG", bps: -200, mcapUsd: 100e9, marketImpact: 20000 },
      { symbol: "ABOVE", bps: 15000, mcapUsd: 1e9, marketImpact: 15000 },
      { symbol: "POS", bps: 100, mcapUsd: 20e9, marketImpact: 2000 },
    ]);
  });
  it("filters yield anomalies and caps the result", async () => {
    const rows = ["USDT", "USDC", "DAI"].map((symbol, i) => ({ stablecoin_id: symbol === "USDT" ? "usdt-tether" : symbol === "USDC" ? "usdc-circle" : "dai-makerdao", symbol, current_apy: 8 + i, apy_7d: 4, apy_30d: 3, warning_signals: JSON.stringify(i === 2 ? [] : ["spike"]) }));
    expect((await collectYieldAnomalies(ctxFor([{ match: "FROM yield_data", rows }]))).value?.map(({ symbol }) => symbol)).toEqual(["USDT", "USDC"]);
    const many = Array.from({ length: 8 }, (_, i) => ({ stablecoin_id: `coin-${i}`, symbol: `C${i}`, current_apy: 10, apy_7d: 5, apy_30d: 4, warning_signals: '["spike"]' })); const ctx = ctxFor([{ match: "FROM yield_data", rows: many }]); for (let i = 0; i < 8; i++) ctx.mcapById.set(`coin-${i}`, 20e9);
    expect((await collectYieldAnomalies(ctx)).value).toHaveLength(5); expect((await collectYieldAnomalies(ctxFor([{ match: "FROM yield_data", rows: [{ ...rows[0], warning_signals: "[]" }] }]))).value).toBeUndefined();
  });
  it("drops operational advisories before the yield anomaly top-N cut", async () => {
    const aged = Array.from({ length: 6 }, (_, i) => ({ stablecoin_id: `aged-${i}`, symbol: `A${i}`, current_apy: 10, apy_7d: 5, apy_30d: 4, warning_signals: '["aging","data-stale"]' }));
    const real = { stablecoin_id: "real-0", symbol: "REAL", current_apy: 10, apy_7d: 5, apy_30d: 4, warning_signals: '["aging","yield-spike"]' };
    const ctx = ctxFor([{ match: "FROM yield_data", rows: [...aged, real] }]);
    for (const row of [...aged, real]) ctx.mcapById.set(row.stablecoin_id, row === real ? 1e9 : 90e9);
    const result = (await collectYieldAnomalies(ctx)).value;
    expect(result?.map(({ symbol }) => symbol)).toEqual(["REAL"]);
    expect(result?.[0].warnings).toEqual(["yield-spike"]);
  });
  const coverage = { coverage_class: "primary", coverage_confidence: 0.9, methodology_version: "6.1" };
  const liquidityPair = (current: number, previous: number, currentTvl = 500e6, previousTvl = 480e6, extra = {}) => [{ stablecoin_id: "usdt-tether", liquidity_score: current, total_tvl_usd: currentTvl, snapshot_date: 1_772_755_200, ...coverage, ...extra }, { stablecoin_id: "usdt-tether", liquidity_score: previous, total_tvl_usd: previousTvl, snapshot_date: 1_772_668_800, ...coverage }];
  it("skips malformed newest coverage before choosing the digest pair", async () => {
    const pair = liquidityPair(85, 75);
    const invalid = { ...pair[0], snapshot_date: pair[0].snapshot_date + 1, coverage_confidence: 1.1 };
    const result = await collectLiquidityShifts(ctxFor([{ match: "FROM dex_liquidity_history", rows: [invalid, ...pair] }]));
    expect(result.value).toHaveLength(1);
    expect(result.degradedReasons).toContain("liquidity-invalid-coverage-evidence");
  });

  it.each([["material", liquidityPair(85, 75), 0.0417, []], ["threshold", liquidityPair(80, 78), undefined, []], ["collapse", liquidityPair(75, 85, 13.72e6, 152e6), -0.9097, []], ["methodology", liquidityPair(71, 85, 480e6, 500e6, { methodology_version: "6.0" }).map((row, i) => i ? { ...row, methodology_version: "5.91" } : row), undefined, ["liquidity-shift-methodology-basis-change"]], ["fallback", liquidityPair(75, 85, 400e6, 500e6, { coverage_class: "fallback", coverage_confidence: 0.5 }), undefined, ["liquidity-shift-non-trendworthy-coverage"]]] as const)("handles %s liquidity pair", async (_label, rows, change, withheldStories) => { const result = await collectLiquidityShifts(ctxFor([{ match: "FROM dex_liquidity_history", rows }])); if (change == null) expect(result.value).toBeUndefined(); else expect(result.value?.[0].tvlChangePct).toBeCloseTo(change, 4); expect(result.degradedReasons).toEqual([]); expect(result.qualityReasons ?? []).toEqual(withheldStories); });
  it("withholds monetary candidates for absent supply without erasing observed incident counts", async () => {
    const activeCtx = ctxFor(depegTable([activeRows.usdc]));
    activeCtx.mcapById.delete("usdc-circle");
    const active = await collectActiveDepegs(activeCtx);
    expect(active.value).toMatchObject({ activeDepegCount: 1, topDepegs: [] });
    expect(active.qualityReasons).toContain("active-depeg-supply-unavailable");

    const recoveredCtx = ctxFor([{ match: "FROM depeg_events", rows: [{
      ...activeRows.usdc, ended_at: activeCtx.nowSec, close_reason: "recovered-primary", recovery_price: 1,
    }] }]);
    recoveredCtx.mcapById.delete("usdc-circle");
    const recovered = await collectResolvedDepegs(recoveredCtx);
    expect(recovered.value).toMatchObject({ resolvedDepegCount: 1, resolvedDepegs: undefined });
    expect(recovered.qualityReasons).toContain("resolved-depeg-supply-unavailable");

    const liquidityCtx = ctxFor([{ match: "FROM dex_liquidity_history", rows: liquidityPair(85, 75) }]);
    liquidityCtx.mcapById.delete("usdt-tether");
    const liquidity = await collectLiquidityShifts(liquidityCtx);
    expect(liquidity.value).toBeUndefined();
    expect(liquidity.qualityReasons).toContain("liquidity-shift-supply-unavailable");
  });
});

describe("history and DEWS collectors", () => {
  it("builds cross-day trajectories and covers null and insufficient history", async () => {
    const now = Math.floor(Date.now() / 1000); const full = await collectCrossDayTrends(ctxFor([{ match: "FROM daily_digest", rows: [makeDigestRow(now, 0, 92, "BEDROCK", 200e9, -5), makeDigestRow(now, 1, 91, "BEDROCK", 199e9, -3), makeDigestRow(now, 2, 90, "STEADY", 198e9, -1), makeDigestRow(now, 3, 89, "STEADY", 197e9), makeDigestRow(now, 4, 88, "STEADY", 196e9)] }]));
    const psiTrajectory = full.value?.psiTrajectory ?? [];
    expect(psiTrajectory[0]).toMatchObject({ score: 88 }); expect(psiTrajectory[psiTrajectory.length - 1]).toMatchObject({ score: 92 }); expect(full.value?.gaugeTrajectory).toEqual(expect.any(Array));
    const short = await collectCrossDayTrends(ctxFor([{ match: "FROM daily_digest", rows: [makeDigestRow(now, 0, 92, "BEDROCK", 200e9, -5), makeDigestRow(now, 1, 91, "BEDROCK", 199e9), makeDigestRow(now, 2, 90, "STEADY", 198e9), makeDigestRow(now, 3, 89, "STEADY", 197e9)] }])); expect(short.value?.gaugeTrajectory).toBeNull();
    expect((await collectCrossDayTrends(ctxFor([{ match: "FROM daily_digest", rows: [makeDigestRow(now, 1, 92, "BEDROCK", 200e9), makeDigestRow(now, 2, 91, "BEDROCK", 199e9)] }]))).value).toBeUndefined();
  });
  it("collects historical PSI and market context", async () => {
    const today = 1_772_755_200; const db = mockD1([first("SELECT COUNT(*) as cnt FROM stability_index", { cnt: 90 }), first("SELECT MIN(generated_at) as oldest FROM daily_digest", null), first("FROM daily_digest\n           WHERE json_extract(input_data", { generated_at: today - 30 * 86_400 + 8 * 3600, psi_score: 89, psi_band: "STEADY" }), { match: "ORDER BY computed_at DESC LIMIT 90", rows: [0, 1, 2].map((daysAgo) => ({ date: today - daysAgo * 86_400, score: 91.2, band: "BEDROCK" })) }, first("SELECT circulating_usd AS ath_mcap, snapshot_date FROM supply_history", { ath_mcap: 120e6, snapshot_date: today - 60 * 86_400 }), first("ABS(s1.circulating_usd - s2.circulating_usd)", { snapshot_date: today - 45 * 86_400, abs_change: 8e6 })]);
    expect((await collectHistoricalContext(makeCollectorCtx(db), 91.2, "BEDROCK", today, { id: "usdt-tether", symbol: "USDT", name: "Tether", changeUsd: 5e6, currentMcap: 100e6 })).value).toMatchObject({ psiBandStreak: 3, psiPrecedent: { lastSeenDaysAgo: 30 } });
  });
  it.each([
    { name: "missing yesterday", days: [0, 2], changedYesterday: false, currentDayOffset: 0, expected: 1 },
    { name: "changed yesterday band", days: [0, 1, 2], changedYesterday: true, currentDayOffset: 0, expected: 1 },
    { name: "uninterrupted days", days: [0, 1, 2], changedYesterday: false, currentDayOffset: 0, expected: 3 },
    { name: "daily fallback observation", days: [0, 1, 2], changedYesterday: false, currentDayOffset: 1, expected: 3 },
  ])("uses canonical calendar PSI streaks for $name", async ({ days, changedYesterday, currentDayOffset, expected }) => {
    const today = 1_772_755_200;
    const computedAt = today - currentDayOffset * 86_400 + (currentDayOffset === 0 ? 8 * 3600 : 0);
    const observationDay = today - currentDayOffset * 86_400;
    const history = days.map((daysAgo) => ({
      date: observationDay - daysAgo * 86_400,
      score: 91.2,
      band: changedYesterday && daysAgo === 1 ? "STEADY" : "BEDROCK",
    }));
    const db = mockD1([
      first("SELECT COUNT(*) as cnt FROM stability_index", { cnt: 90 }),
      first("SELECT MIN(generated_at) as oldest FROM daily_digest", null),
      first("FROM daily_digest\n           WHERE json_extract(input_data", null),
      { match: "ORDER BY computed_at DESC LIMIT 90", rows: history },
    ]);
    const ctx = makeCollectorCtx(db);
    ctx.todayTs = today;
    const result = await collectHistoricalContext(ctx, 91.2, "BEDROCK", computedAt, null);

    expect(result.degradedReasons).toEqual([]);
    expect(result.value?.psiBandStreak).toBe(expected);
    expect(result.value?.psiBandStreak).toBe(getPsiBandStreak(history, computedAt, "BEDROCK"));
  });
  it("accepts flat and wrapped DEWS signals, records malformed input, and rejects partial publication", async () => {
    const at = Math.floor(Date.now() / 1000) - 600; const signals = { supply: { value: 30, available: true }, pool: { value: 80, available: true }, liq: { value: 45, available: true }, price: { value: 10, available: true } };
    const run = (signalsJson: string, history: Record<string, unknown>[] = []) => collectDewsStress(ctxFor([...makePublishedDewsTables([{ stablecoin_id: "usdt-tether", score: 65, band: "ALERT", signals_json: signalsJson, computed_at: at }]), { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: history }]));
    const flat = await run(JSON.stringify(signals), [{ stablecoin_id: "usdt-tether", score: 25, band: "WATCH" }]); const wrapped = await run(JSON.stringify({ signals, amplifiers: { psi: 1, contagion: 1 } }));
    expect(flat.value?.elevatedCoins[0].topSignals?.[0].name).toBe("pool balance drift"); expect(wrapped.value?.elevatedCoins[0].topSignals).toEqual(flat.value?.elevatedCoins[0].topSignals);
    expect((await run('{"pool":', [{ stablecoin_id: "usdt-tether", score: 25, band: "WATCH" }])).degradedReasons).toContain("dews-stress-signals-json"); expect((await run("{}")).value?.elevatedCoins[0].topSignals).toEqual([]);
    const rows = ["usdt-tether", "usdc-circle"].map((id) => ({ stablecoin_id: id, score: 65, band: "ALERT", signals_json: "{}", computed_at: at }));
    const tables = makePublishedDewsTables(rows);
    tables[1] = { ...tables[1], rows: [rows[0]] };
    const partial = await collectDewsStress(ctxFor(tables));
    expect(partial.value).toBeUndefined();
    expect(partial.degradedReasons).toContain("dews-published-generation");
  });
  it.each([false, true])("keeps the full DEWS census independent of five displayed coins (missing supply: %s)", async (missingSupply) => {
    const at = Math.floor(Date.now() / 1000) - 600;
    const assets = Array.from({ length: 9 }, (_, index) => makeAsset({
      id: `coin-${index}`, symbol: `C${index}`,
      circulating: index === 8 ? (missingSupply ? {} : { peggedUSD: 0 }) : { peggedUSD: index === 7 ? 5e6 : 20e6 },
    }));
    const rows = assets.map((asset) => ({ stablecoin_id: asset.id, score: 65, band: "ALERT", signals_json: "{}", computed_at: at }));
    const ctx = ctxFor([
      ...makePublishedDewsTables(rows),
      { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: rows.map((row) => ({ ...row, band: "WATCH", score: 25 })) },
    ]);
    ctx.trackedStablecoinAssets = assets;
    ctx.trackedStablecoinIds = new Set(assets.map((asset) => asset.id));
    ctx.stablecoinAssetById = new Map(assets.map((asset) => [asset.id, asset]));
    const dewsStress = (await collectDewsStress(ctx)).value!;
    expect(dewsStress).toMatchObject({
      bandCounts: { alert: 9 }, alertPlusMcapUsd: 145e6, bandChangeCount: 9,
      alertPlusSupplyCoverage: { complete: !missingSupply, observedCount: missingSupply ? 8 : 9, unavailableCount: missingSupply ? 1 : 0 },
    });
    expect(dewsStress.elevatedCoins).toHaveLength(5);
    expect(dewsStress.bandChanges).toHaveLength(5);
    for (const limit of [0, 1, 5]) {
      const input: DigestInputData = {
        ...BASE_DIGEST_INPUT, activeDepegCount: 0, topDepegs: [],
        dewsStress: { ...dewsStress, elevatedCoins: dewsStress.elevatedCoins.slice(0, limit), bandChanges: dewsStress.bandChanges.slice(0, limit) },
      };
      expect(classifyRegime(input)).toBe("TENSION");
      expect(buildRiskTape(input).find((item) => item.id === "risk-tape:dews")?.detail).toContain("9 band changes");
      expect(buildUserPrompt(input)).toContain("Full band-change count (last 24h): 9");
      expect(buildUserPrompt(input)).toContain(missingSupply ? "ALERT+ known supply subtotal: $145.00M" : "ALERT+ supply: $145.00M");
      const breadth = buildEditorialCandidates(input, null).find((candidate) => candidate.id === "dews:alert-plus-breadth");
      expect(breadth?.impactScore).toBe(0.1);
      expect(breadth?.headlineFacts).toContain(missingSupply ? "$145.00M ALERT+ known supply subtotal (incomplete coverage)" : "$145.00M ALERT+ market cap");
    }
  });
});
