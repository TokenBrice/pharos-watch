import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";

vi.mock("@shared/lib/stablecoins/registry", async () => (await import("./daily-digest.test-support")).mockDailyDigestRegistryModule());
vi.mock("../../lib/stablecoins-cache", async () => (await import("./daily-digest.test-support")).mockDailyDigestStablecoinsCacheModule());
vi.mock("../../lib/safety-score-active-source", async () => (await import("./daily-digest.test-support")).mockDailyDigestSafetySourceModule());
vi.mock("../../lib/flight-to-quality-classification", async () => (await import("./daily-digest.test-support")).mockDailyDigestFlightToQualityModule());
vi.mock("../../lib/fetch-retry", async () => (await import("./daily-digest.test-support")).mockDailyDigestFetchRetryModule());
vi.mock("../../lib/twitter", async () => (await import("./daily-digest.test-support")).mockDailyDigestTwitterModule());
vi.mock("../../lib/digest-safety-map", async (importOriginal) => {
  const { mockDigestSafetyMapModule } = await import("./daily-digest.test-support");
  return mockDigestSafetyMapModule(await importOriginal<typeof import("../../lib/digest-safety-map")>());
});
vi.mock("../../lib/telegram-digest-appendices", async () => (await import("./daily-digest.test-support")).mockDailyDigestAppendicesModule());
vi.mock("../../lib/telegram-digest-outbox", async () => (await import("./daily-digest.test-support")).mockDailyDigestOutboxModule());
vi.mock("../telegram-digest-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram-digest-transport")>();
  return (await import("./daily-digest.test-support")).mockTelegramDigestTransportModule(actual);
});
vi.mock("../../lib/circuit-breaker", async () => (await import("./daily-digest.test-support")).mockDailyDigestCircuitBreakerModule());

import { buildUserPrompt } from "../daily-digest/prompt";
import { buildDigestSafetyMapCapture } from "../daily-digest/input";
import { DAILY_EXEMPLAR, SYSTEM_PROMPT } from "../daily-digest/prompt/policy";
import { classifyRegime } from "../daily-digest/prompt/regime";
import { ALLOWED_TONES, hasBlockingDigestQualityIssues, parseDigestModelResponse, validateDigestModelOutput, type DigestValidationProfile, type ParsedDigestResponse } from "../daily-digest/response";
import { collectActiveDepegs, collectLiquidityShifts, collectMintBurnFlows, collectResolvedDepegs, collectSupplyVelocity } from "../daily-digest/collectors-market";
import { collectDewsStress, collectGradeTransitions, collectSafetyScores, collectYieldAnomalies } from "../daily-digest/collectors-risk";
import { collectCrossDayTrends, collectHistoricalContext, collectPsiContributors } from "../daily-digest/collectors-history";
import { buildDigestIntelligence } from "../daily-digest/digest-intelligence";
import { buildForwardLookOutcomes, buildNextTriggers } from "../daily-digest/digest-next-triggers";
import { buildEditorialPrompt, scanEditorialText } from "@shared/lib/editorial-style";
import type { DigestInputData } from "@shared/types/digest";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import { BASE_DIGEST_INPUT, BASE_SAFETY_CONTEXT, canonicalSafetySource, makeCollectorCtx, makeDigestRow, makePublishedDewsTables, missingPublishedGaugeTable, PUBLISHED_GAUGE_SCORE, publishedGaugeTable, VALID_CAPTURE_MAP_SUMMARY } from "./daily-digest.test-support";

const DEFAULT_EXTENDED = "T. T. T.\n\nT. T. T.\n\nT. T. T.";
const fixture = (opts: { extended?: string; text?: string; lead?: string; leadSignalId?: string; tone?: string } = {}): ParsedDigestResponse => ({ digestTitle: "T", digestText: opts.text ?? "T.", digestExtended: opts.extended ?? DEFAULT_EXTENDED, digestMeta: JSON.stringify({ leadSignalId: opts.leadSignalId, lead: opts.lead ?? "depeg", tone: opts.tone ?? "dry", coins: ["USDT"] }), strippedDashCount: 0, usedRawTextFallback: false });
const issueCodes = (parsed: ParsedDigestResponse, profile: DigestValidationProfile) => validateDigestModelOutput(parsed, profile).map((issue) => issue.code);
const first = (match: string, value: Record<string, unknown> | null): MockTableConfig => ({ match, rows: [], first: value });
const ctxFor = (tables: MockTableConfig[]) => makeCollectorCtx(mockD1(tables));
const depegTable = (rows: Record<string, unknown>[]): MockTableConfig[] => [{ match: "FROM depeg_events WHERE ended_at IS NULL", rows }];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  vi.mocked(loadActiveSafetyScoreSource).mockReset().mockResolvedValue(canonicalSafetySource([]));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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
    const titles = [{ meta: null, title: "USX Turns Twenty Days Old" }, { meta: null, title: "USX Passes 450 Hours Broken" }];
    expect(issueCodes({ ...fixture(), digestTitle: "USX Enters Week Four" }, { kind: "daily", recentMeta: titles })).toEqual(expect.arrayContaining(["title-symbol-streak", "title-day-counting"]));
    expect(issueCodes({ ...fixture(), digestTitle: "USDC Touches Its Ceiling" }, { kind: "daily", recentMeta: [], recentTitles: ["USDC Touches Its Ceiling"] })).toContain("repeated-title");
  });
});

describe("intelligence, prompt, and regime contracts", () => {
  const current: DigestInputData = { ...BASE_DIGEST_INPUT, editorialCandidates: [{ id: "depeg:usdt-tether:active", kind: "depeg", title: "USDT active 175 bps below peg", symbols: ["USDT"], impactScore: 17.5, novelty: "worsening", confidence: "high", artifactRisk: "low", headlineFacts: ["175 bps below peg"], whyItMatters: "Active peg stress is relevant." }, { id: "supply:usdc:accelerating", kind: "supply", title: "USDC supply accelerating", symbols: ["USDC"], impactScore: 12, novelty: "accelerating", confidence: "high", artifactRisk: "low", headlineFacts: ["+$12M in 1d"], whyItMatters: "Supply velocity shows allocation." }] };
  const previous: DigestInputData = { ...current, topDepegs: [{ ...current.topDepegs[0], bps: -100 }], stabilityIndex: { score: 91, band: "BEDROCK", components: { severity: 2, breadth: 1, trend: 0 } }, nextTriggers: [{ id: "trigger:depeg:usdt", label: "USDT depeg widening", metric: "depeg-bps", comparator: "abs-gte", thresholdValue: 125, thresholdLabel: "125 bps off peg", symbol: "USDT", rationale: "Wider deviation raises severity.", detail: "If USDT reaches 125 bps off peg, severity rises." }] };
  it("builds change, trigger, risk, and calm-frame intelligence and expires stale triggers", () => {
    const intelligence = buildDigestIntelligence(current, previous);
    expect(intelligence.calmNarrativeFrame).toMatchObject({ label: "Supply rotation" }); expect(intelligence.nextTriggers?.[0]).toMatchObject({ metric: "depeg-bps" });
    expect(intelligence.changeSummary?.worsenedSignals[0]).toMatchObject({ label: "USDT depeg widened" });
    expect(intelligence.forwardLookOutcomes?.[0]).toMatchObject({ status: "hit", triggerId: "trigger:depeg:usdt" });
    let prior: DigestInputData | null = null;
    const editions = Array.from({ length: 4 }, () => { const data = { ...current, nextTriggers: buildNextTriggers(current, prior) }; prior = data; return data; });
    expect(editions.slice(0, 3).map((data) => data.nextTriggers?.[0]?.repeatedCount ?? 0)).toEqual([0, 1, 2]);
    expect(editions[3].nextTriggers?.some((trigger) => trigger.id === "trigger:depeg:usdt-tether")).toBe(false);
    expect(buildForwardLookOutcomes(editions[3], editions[2])).toContainEqual(expect.objectContaining({ status: "expired" }));
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
    expect(buildUserPrompt({ ...data, safetyMap: capture! })).toContain("A tier: 2 coins, 70.0% of mapped supply");
    expect(buildDigestSafetyMapCapture(data, { ...resolution, manifest: { ...resolution.manifest, date: "2026-08-29" } })).toBeNull();
    const unavailableSafetyData: DigestInputData = { ...data, safetyContext: { status: "unavailable", expectedModel: "v9", identity: null, publishedAt: null, reason: "held" } };
    expect(buildDigestSafetyMapCapture(unavailableSafetyData, resolution)).toBeNull();
  });
  it.each([["CALM", { ...BASE_DIGEST_INPUT, activeDepegCount: 0, topDepegs: [] }], ["CRISIS", { ...BASE_DIGEST_INPUT, mintBurnFlows: { gaugeScore: -20, gaugeBand: "CAUTIOUS", flightToQuality: { active: true, safeNetUsd: 200e6, riskyNetUsd: -200e6 }, topPressure: [] } }], ["CRISIS", { ...BASE_DIGEST_INPUT, stabilityIndex: { score: 65, band: "TREMOR", components: { severity: 30, breadth: 5, trend: -3 } } }], ["TENSION", { ...BASE_DIGEST_INPUT, dewsStress: { bandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 }, yesterdayBandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 }, bandChanges: [], elevatedCoins: [{ symbol: "USDT", band: "ALERT", score: 50, mcapUsd: 2e9 }] } }], ["WATCHFUL", { ...BASE_DIGEST_INPUT, activeDepegCount: 1, topDepegs: [{ symbol: "USDT", bps: 5, mcapUsd: 100e9 }] }]] as const)("classifies %s regime", (expected, data) => expect(classifyRegime(data as DigestInputData)).toBe(expected));
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
  it("loads canonical V9 scores and organic grade transitions", async () => {
    const snapshot = canonicalSafetySource([{ id: "usdt-tether", overallGrade: "A", overallScore: 88 }]);
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValueOnce(snapshot);
    const scores = await collectSafetyScores(ctxFor([]), new Set(["USDT"]));
    expect(scores.value.safetyContext).toMatchObject({ status: "available", expectedModel: "v9" });
    expect(scores.value.safetyScores).toMatchObject({ model: "v9", mentionedCoins: [{ symbol: "USDT", grade: "A", score: 88 }] });
    const now = Math.floor(Date.now() / 1000);
    const identity = scores.value.safetyIdentity!;
    const db = mockD1([{ match: "GROUP BY recorded_at HAVING COUNT(*) > 15", rows: [] }, { match: "ORDER BY ABS(COALESCE(score, 0) - COALESCE(prev_score, 0)) DESC", rows: [{ history_id: "h", stablecoin_id: "usdt-tether", recorded_at: now, model: identity.model, identity_schema_version: identity.schemaVersion, methodology_version: identity.methodologyVersion, policy_id: identity.policyId, policy_digest: identity.policyDigest, evaluation_build_digest: identity.evaluationBuildDigest, base_input_generation_id: identity.baseInputGenerationId, model_publication_generation_id: identity.publicationGenerationId, transition_kind: "organic-grade-change", grade: "A-", score: 80, prev_grade: "A", prev_score: 85 }] }]);
    expect((await collectGradeTransitions(makeCollectorCtx(db), scores.value.safetyGrades, identity)).value?.[0]).toMatchObject({ symbol: "USDT", fromGrade: "A", toGrade: "A-" });
  });
  it.each([["missing", () => missingPublishedGaugeTable(), undefined, []], ["malformed", () => publishedGaugeTable({ value: '{"gauge":{"score":"nope"}}' }), undefined, ["mint-burn-gauge-malformed"]], ["expired", () => publishedGaugeTable({ ageSec: 25 * 3600 }), undefined, ["mint-burn-gauge-expired"]], ["stale", () => publishedGaugeTable({ ageSec: 3 * 3600 }), PUBLISHED_GAUGE_SCORE, ["mint-burn-gauge-stale"]]] as const)("handles %s published gauge", async (_label, table, score, reasons) => { const result = await collectMintBurnFlows(ctxFor([table()])); expect(result.value?.gaugeScore).toBe(score); expect(result.degradedReasons).toEqual(reasons); });
  it("re-bins the published gauge, includes FTQ chains, and never reads hourly rows", async () => {
    const db = mockD1([publishedGaugeTable()]); const result = await collectMintBurnFlows(makeCollectorCtx(db));
    expect(result.value).toMatchObject({ gaugeScore: PUBLISHED_GAUGE_SCORE, gaugeBand: "HEALTHY", classificationSource: "safety-score-v9-publication", topChains: [{ chainId: "ethereum", netUsd: 150e6 }, { chainId: "arbitrum", netUsd: -3e6 }] });
    expect(result.value?.topPressure.map(({ symbol }) => symbol)).toEqual(["USDT", "USDC"]); expect(buildUserPrompt({ ...BASE_DIGEST_INPUT, mintBurnFlows: result.value! })).toContain("Top chains by net flow"); expect(db.getHistory().some(({ sql }) => sql.includes("mint_burn_hourly"))).toBe(false);
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
  it("filters yield anomalies and caps the result", async () => {
    const rows = ["USDT", "USDC", "DAI"].map((symbol, i) => ({ stablecoin_id: symbol === "USDT" ? "usdt-tether" : symbol === "USDC" ? "usdc-circle" : "dai-makerdao", symbol, current_apy: 8 + i, apy_7d: 4, apy_30d: 3, warning_signals: JSON.stringify(i === 2 ? [] : ["spike"]) }));
    expect((await collectYieldAnomalies(ctxFor([{ match: "FROM yield_data", rows }]))).value?.map(({ symbol }) => symbol)).toEqual(["USDT", "USDC"]);
    const many = Array.from({ length: 8 }, (_, i) => ({ stablecoin_id: `coin-${i}`, symbol: `C${i}`, current_apy: 10, apy_7d: 5, apy_30d: 4, warning_signals: '["spike"]' })); const ctx = ctxFor([{ match: "FROM yield_data", rows: many }]); for (let i = 0; i < 8; i++) ctx.mcapById.set(`coin-${i}`, 20e9);
    expect((await collectYieldAnomalies(ctx)).value).toHaveLength(5); expect((await collectYieldAnomalies(ctxFor([{ match: "FROM yield_data", rows: [{ ...rows[0], warning_signals: "[]" }] }]))).value).toBeUndefined();
  });
  const coverage = { coverage_class: "primary", coverage_confidence: 0.9, methodology_version: "6.1" };
  const liquidityPair = (current: number, previous: number, currentTvl = 500e6, previousTvl = 480e6, extra = {}) => [{ stablecoin_id: "usdt-tether", liquidity_score: current, total_tvl_usd: currentTvl, snapshot_date: 1_772_755_200, ...coverage, ...extra }, { stablecoin_id: "usdt-tether", liquidity_score: previous, total_tvl_usd: previousTvl, snapshot_date: 1_772_668_800, ...coverage }];
  it.each([["material", liquidityPair(85, 75), 0.0417, []], ["threshold", liquidityPair(80, 78), undefined, []], ["collapse", liquidityPair(75, 85, 13.72e6, 152e6), -0.9097, []], ["methodology", liquidityPair(71, 85, 480e6, 500e6, { methodology_version: "6.0" }).map((row, i) => i ? { ...row, methodology_version: "5.91" } : row), undefined, ["liquidity-shift-methodology-basis-change"]], ["fallback", liquidityPair(75, 85, 400e6, 500e6, { coverage_class: "fallback", coverage_confidence: 0.5 }), undefined, ["liquidity-shift-non-trendworthy-coverage"]]] as const)("handles %s liquidity pair", async (_label, rows, change, reasons) => { const result = await collectLiquidityShifts(ctxFor([{ match: "FROM dex_liquidity_history", rows }])); if (change == null) expect(result.value).toBeUndefined(); else expect(result.value?.[0].tvlChangePct).toBeCloseTo(change, 4); expect(result.degradedReasons).toEqual(reasons); });
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
    const today = 1_772_755_200; const db = mockD1([first("SELECT COUNT(*) as cnt FROM stability_index", { cnt: 90 }), first("SELECT MIN(generated_at) as oldest FROM daily_digest", null), first("FROM daily_digest\n           WHERE json_extract(input_data", { generated_at: today - 30 * 86_400 + 8 * 3600, psi_score: 89, psi_band: "STEADY" }), { match: "ORDER BY computed_at DESC LIMIT 90", rows: [0, 1, 2].map((daysAgo) => ({ computed_at: today - daysAgo * 86_400, band: "BEDROCK" })) }, first("SELECT circulating_usd AS ath_mcap, snapshot_date FROM supply_history", { ath_mcap: 120e6, snapshot_date: today - 60 * 86_400 }), first("ABS(s1.circulating_usd - s2.circulating_usd)", { snapshot_date: today - 45 * 86_400, abs_change: 8e6 })]);
    expect((await collectHistoricalContext(makeCollectorCtx(db), 91.2, "BEDROCK", { id: "usdt-tether", symbol: "USDT", name: "Tether", changeUsd: 5e6, currentMcap: 100e6 })).value).toMatchObject({ psiBandStreak: 3, psiPrecedent: { lastSeenDaysAgo: 30 } });
  });
  it("accepts flat and wrapped DEWS signals, records malformed input, and rejects partial publication", async () => {
    const at = Math.floor(Date.now() / 1000) - 600; const signals = { supply: { value: 30, available: true }, pool: { value: 80, available: true }, liq: { value: 45, available: true }, price: { value: 10, available: true } };
    const run = (signalsJson: string, history: Record<string, unknown>[] = []) => collectDewsStress(ctxFor([...makePublishedDewsTables([{ stablecoin_id: "usdt-tether", score: 65, band: "ALERT", signals_json: signalsJson, computed_at: at }]), { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: history }]));
    const flat = await run(JSON.stringify(signals), [{ stablecoin_id: "usdt-tether", score: 25, band: "WATCH" }]); const wrapped = await run(JSON.stringify({ signals, amplifiers: { psi: 1, contagion: 1 } }));
    expect(flat.value?.elevatedCoins[0].topSignals?.[0].name).toBe("pool balance drift"); expect(wrapped.value?.elevatedCoins[0].topSignals).toEqual(flat.value?.elevatedCoins[0].topSignals);
    expect((await run('{"pool":', [{ stablecoin_id: "usdt-tether", score: 25, band: "WATCH" }])).degradedReasons).toContain("dews-stress-signals-json"); expect((await run("{}")).value?.elevatedCoins[0].topSignals).toEqual([]);
    const partial = mockD1([first("SELECT value, updated_at FROM cache WHERE key = ?", { updatedAt: at, source: "compute-dews", publishStatus: "published", coverageVersion: 2, expectedRowCount: 2, stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdc-circle", "usdt-tether"]) }), { match: "pharos:stress-signals:published-exact", rows: [{ stablecoin_id: "usdt-tether", score: 65, band: "ALERT", signals_json: "{}", computed_at: at }] }]);
    expect((await collectDewsStress(makeCollectorCtx(partial))).degradedReasons).toContain("dews-published-generation");
  });
});
