import { DEPEG_LIFECYCLE_FLAGS_CACHE_KEY as FLAGS_KEY } from "../../lib/depeg-lifecycle";
import { recordOutcomeSafe as recOut, shouldAttemptFetch as shouldFetch } from "../../lib/circuit-breaker";
import { runTelegramDigestDeliveryWithPermit as runTgPermit } from "../digest/telegram-transport";
import { deliverTelegramDigestEdition as delTg, enqueueTelegramDigestEdition as enqTg } from "../../telegram/outbox/digest-outbox";
import { prepareTelegramDigestAppendices as prepApp } from "../../telegram/digest/digest-appendices";
import { resolveDigestSafetyMap as resMap } from "../../lib/digest-safety-map";
import { postDigestTweet as postTw } from "../../lib/twitter";
import { fetchWithRetry as fetchR } from "../../lib/fetch-retry";
import { ANTHROPIC_TIMEOUT_MS, DIGEST_MODEL } from "../digest/llm-config";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { generateDailyDigest as genDigest, resumeDailyDigestDelivery as resDigest } from "../daily-digest";
import type { CronProgressUpdate } from "../../lib/cron-logger";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRiskTape as riskTape } from "../daily-digest/digest-risk-tape";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { mockD1, type MockTableConfig, type MockD1Database } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker, createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { PSI_NATIVE_EVIDENCE_MAX_AGE_SEC as NATIVE_MAX } from "@shared/lib/depeg-quote-domain";
import { API_FRESHNESS_MAX_AGE_SEC as FRESH_MAX } from "@shared/lib/api-freshness";
import { NATIVE_EVENT_QUOTE_CACHE_PREFIX as NATIVE_PFX } from "../../lib/native-peg-quote-cache";
import { PSI_CONDITION_BAND_VALUES } from "@shared/types/stability-constants";

vi.mock("@shared/lib/stablecoins/registry", async () => (await import("./daily-digest.test-support")).mockDailyDigestRegistryModule());
vi.mock("../../lib/stablecoins-cache", async () => (await import("./daily-digest.test-support")).mockDailyDigestStablecoinsCacheModule());
vi.mock("../../lib/safety-score-active-source", async () => (await import("./daily-digest.test-support")).mockDailyDigestSafetySourceModule());
vi.mock("../../lib/safety-score-index", async () => ({ loadActiveSafetyScoreIndex: (await import("../../lib/safety-score-active-source")).loadActiveSafetyScoreCohort }));
vi.mock("../../lib/flight-to-quality-classification", async () => (await import("./daily-digest.test-support")).mockDailyDigestFlightToQualityModule());
vi.mock("../../lib/fetch-retry", async () => (await import("./daily-digest.test-support")).mockDailyDigestFetchRetryModule());
vi.mock("../../lib/twitter", async () => (await import("./daily-digest.test-support")).mockDailyDigestTwitterModule());
vi.mock("../../lib/digest-safety-map", async (orig) => (await import("./daily-digest.test-support")).mockDigestSafetyMapModule(await orig<typeof import("../../lib/digest-safety-map")>()));
vi.mock("../../telegram/digest/digest-appendices", async () => (await import("./daily-digest.test-support")).mockDailyDigestAppendicesModule());
vi.mock("../../telegram/outbox/digest-outbox", async () => (await import("./daily-digest.test-support")).mockDailyDigestOutboxModule());
vi.mock("../digest/telegram-transport", async (orig) => (await import("./daily-digest.test-support")).mockTelegramDigestTransportModule(await orig<typeof import("../digest/telegram-transport")>()));
vi.mock("../../lib/circuit-breaker", async () => (await import("./daily-digest.test-support")).mockDailyDigestCircuitBreakerModule());

import { buildUserPrompt as prompt } from "../daily-digest/prompt";
import type { CanonicalSafetyGradeRow, CollectorContext } from "../daily-digest/collectors-shared";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import { buildDailyDigestInput as buildIn, buildDigestSafetyMapCapture as buildMapCap } from "../daily-digest/input";
import { insertDigestRecord } from "../digest/platform";
import { DAILY_EXEMPLAR, SYSTEM_PROMPT } from "../daily-digest/prompt/policy";
import { classifyRegime as regime, DIGEST_WRITING_REGISTER } from "../daily-digest/prompt/regime";
import { ALLOWED_TONES, hasBlockingDigestQualityIssues as hasBlock, parseDigestModelResponse as parseRes, validateDigestModelOutput as valOut, type DigestValidationProfile, type ParsedDigestResponse } from "../daily-digest/response";
import { collectActiveDepegs as colDepegs, collectLiquidityShifts as colLiq, collectMintBurnFlows as colMb, collectResolvedDepegs as colResDepegs, collectNativeSupplyMovers as colMovers } from "../daily-digest/collectors-market";
import { collectDewsStress as colDews, collectGradeTransitions as colGrades, collectSafetyScores as colSafe, collectYieldAnomalies as colYield } from "../daily-digest/collectors-risk";
import { collectCrossDayTrends as colTrends, collectHistoricalContext as colHist, collectPsiContributors as colPsi, collectTotalMcapAth as colAth } from "../daily-digest/collectors-history";
import { buildDigestIntelligence as buildIntel, parseStoredDigestInput } from "../daily-digest/digest-intelligence";
import { buildEditorialCandidates as buildCands } from "../daily-digest/editorial-candidates";
import { buildForwardLookOutcomes as buildOut, buildNextTriggers as buildTrig } from "../daily-digest/digest-next-triggers";
import { buildEditorialPrompt, scanEditorialText } from "@shared/lib/editorial-style";
import { getPsiBandStreak } from "@shared/lib/psi-view-model";
import type { DigestInputData } from "@shared/types/digest";
import { loadActiveSafetyScoreCohort as loadSafe } from "../../lib/safety-score-active-source";
import { REGIME_CRITICAL_DIGEST_DEGRADED_SOURCES } from "../digest-input-quality";
import { loadStablecoinsCache as loadCache } from "../../lib/stablecoins-cache";
import { BASE_DIGEST_INPUT as BASE, BASE_SAFETY_CONTEXT as BASE_SAFE, canonicalSafetySource as safeSrc, currentPegObservation as pegObs, makeCollectorCtx as mkCtx, makeDailyDigestScenario as mkScen, makeDigestRow as mkRow, makePublishedDewsTables as dewsTbl, missingPublishedGaugeTable as noGaugeTbl, PUBLISHED_GAUGE_SCORE as G_SCORE, publishedGaugePayload as gPay, publishedGaugeTable as gTbl, VALID_CAPTURE_MAP_SUMMARY as MAP_SUM, ANTHROPIC_OK_TEXT as OK_TXT, getInsertDigestBinds as insBinds, makeRefusalResponse as mkRefusal, makeStreamResponse as mkStream, styleGateModeTables as gateTbl, VALID_DAILY_EXTENDED as OK_EXT, withClauseDash as withDash, type DailyDigestScenario, makeResumeDigestDb as mkResDb } from "./daily-digest.test-support";

const DEF_EXT = "T. T. T.\n\nT. T. T.\n\nT. T. T.";
const js = JSON.stringify, jp = JSON.parse, vm = vi.mocked, nowS = () => Math.floor(Date.now() / 1000);
const fx = (o: { extended?: string; text?: string; lead?: string; leadSignalId?: string; tone?: string } = {}): ParsedDigestResponse => ({ digestTitle: "T", digestText: o.text ?? "T.", digestExtended: o.extended ?? DEF_EXT, digestMeta: js({ leadSignalId: o.leadSignalId, lead: o.lead ?? "depeg", tone: o.tone ?? "dry", coins: ["USDT"] }), strippedDashCount: 0, usedRawTextFallback: false });
const codes = (p: ParsedDigestResponse, prof: DigestValidationProfile) => valOut(p, prof).map((i) => i.code);
const first = (match: string, value: Record<string, unknown> | null): MockTableConfig => ({ match, rows: [], first: value });
const ctxFor = (t: MockTableConfig[]) => mkCtx(mockD1(t));
const depegTbl = (rows: Record<string, unknown>[]): MockTableConfig[] => [{ match: "FROM depeg_events e LEFT JOIN depeg_event_provenance", rows }];
const gVal = (o?: Record<string, unknown>) => gTbl({ value: js(gPay(o)) });
const scenDb = (prependTables: MockTableConfig[]) => mkScen({ db: { prependTables } }).db;
const setDewsAssets = (ctx: CollectorContext, assets: ReturnType<typeof makeAsset>[]) => { ctx.trackedStablecoinAssets = assets; ctx.trackedStablecoinIds = new Set(assets.map((a) => a.id)); ctx.stablecoinAssetById = new Map(assets.map((a) => [a.id, a])); };
const nqFx = createLatestSchemaFixtureTracker();

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-03-06T12:00:00Z")); vm(loadSafe).mockReset().mockResolvedValue(safeSrc([])); });
afterEach(() => { nqFx.closeAll(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("response and editorial contracts", () => {
  it.each([
    ["natural leads", ["gauge-flip", "psi-band-change", "issuer-concentration", "regime-divergence", "chain-migration", "reserve-event"], "lead"],
    ["natural tones", ["sardonic", "observant", "forensic"], "tone"],
  ] as const)("preserves %s", (_l, vals, field) => {
    for (const v of vals) expect((jp(parseRes(js({ title: "T", text: "T.", extended: DEF_EXT, meta: { lead: field === "lead" ? v : "depeg", tone: field === "tone" ? v : "dry", coins: ["USDT"] } })).digestMeta!) as Record<string, string>)[field]).toBe(v);
  });

  it("normalizes unknown meta values and enforces lead, look-ahead, and repetition guards", () => {
    expect(jp(parseRes(js({ title: "T", text: "T.", extended: DEF_EXT, meta: { lead: "???", tone: "???" } })).digestMeta!)).toMatchObject({ lead: "other", tone: "other" });
    expect(codes(fx({ extended: "A.\n\nB.\n\nC.", text: "Watch if USDT crosses $185B." }), { kind: "daily", recentMeta: [] })).not.toContain("missing-forward-look");
    expect(codes(fx({ lead: "psi-streak" }), { kind: "daily", recentMeta: ["psi-regime", "psi-band-change", "supply-reversal"].map((lead) => ({ meta: { lead, tone: "dry" }, title: "x" })) })).toContain("repeated-lead-family");
    expect(codes(fx({ extended: "PSI ticked to 96 in BEDROCK.\n\nUSDC added $500M.\n\nReal closer." }), { kind: "daily", recentMeta: [{ meta: null, title: "x", rawText: "PSI sits at 95. USDC hit ATH." }] })).toContain("opening-pattern-repetition");
    expect(codes(fx({ extended: "At tomorrow's 10:00 snapshot, the DAI threshold decides the lead.\n\nUSDC added $500M.\n\nWatch for flows next session." }), { kind: "daily", recentMeta: ["At tomorrow's 08:00 snapshot, the USDT threshold decides the lead.", "At tomorrow's 09:00 snapshot, the USDC threshold decides the lead."].map((rawText, i) => ({ meta: null, title: String(i), rawText })) })).toContain("structural-repetition");
  });

  it.each([
    ["critical lead mismatch", fx({ leadSignalId: "market:usdc-circle:weekly-supply", extended: "PMUSD stayed 5284 bps below peg on $65M.\n\nUSDC added $2B.\n\nIf PMUSD holds there next session, the peg stress remains the lead." }), "lead-candidate-mismatch"],
    ["critical lead omission", fx({ leadSignalId: "depeg:pmusd-active", extended: "USDC added $2B.\n\nUSDT held steady.\n\nIf the flow reverses next session, the supply story changes." }), "required-lead-missing"],
  ] as const)("hard-fails %s", (_l, parsed, code) => {
    expect(valOut(parsed, { kind: "daily", recentMeta: [], leadRequirements: [{ candidateIds: ["depeg:pmusd-active"], severity: "hard", mentionTokens: ["PMUSD"], reason: "PMUSD critical depeg must lead" }] })).toContainEqual(expect.objectContaining({ code, severity: "hard" }));
  });

  it("hard-fails internal register words, soft-flags regime-band phrasing, keeps public bands", () => {
    const c = (ext: string, text = "T.") => codes(fx({ extended: ext, text }), { kind: "daily" });
    expect(c("PSI reads 93.1 in BEDROCK with the regime at TENSION.\n\nB.\n\nC.")).toContain("internal-register-word");
    expect(c(DEF_EXT, "Market regime: WATCHFUL.")).toContain("internal-register-word");
    expect(c("PSI fell to CRISIS while USDT sat at DEWS CALM.\n\nTension built in the pools.\n\nC.")).not.toContain("internal-register-word");
    const r = valOut(fx({ extended: "The regime is CRISIS.\n\nB.\n\nC." }), { kind: "daily" });
    expect(r).toContainEqual(expect.objectContaining({ code: "regime-band-phrase", severity: "soft" }));
    expect(r.map((i) => i.code)).not.toContain("internal-register-word");
  });

  const ext = (q: string): ParsedDigestResponse => parseRes(js({ title: "Calm Market", text: "USDT held its peg.", extended: `${q}\n\n${"USDT supply stayed near the prior print while the next observable trigger remained unchanged. ".repeat(6).trim()}\n\n${"The market snapshot kept its measured shape as flows and prices moved within the stated range. ".repeat(5).trim()}`, meta: { lead: "depeg", tone: "dry", coins: ["USDT"] } }));
  it("keeps editorial dashes soft in shadow, hard in enforce, and repairs the full dash range", () => {
    const sh = valOut(ext("USDT moved — the next trigger is tomorrow."), { kind: "daily" });
    expect(sh).toContainEqual(expect.objectContaining({ code: "editorial-style", severity: "soft", ruleId: "no-clause-dash" }));
    expect(hasBlock(sh)).toBe(false);
    expect(valOut(ext("USDT moved — the next trigger is tomorrow."), { kind: "daily", styleGateMode: "enforce" })).toContainEqual(expect.objectContaining({ severity: "hard", ruleId: "no-clause-dash" }));
    for (const d of ["‒", "―"]) { const p = ext(`USDT moved ${d} the next trigger is tomorrow.`); expect(p.digestExtended).not.toContain(d); expect(p.editorialFindings).toContainEqual(expect.objectContaining({ ruleId: "no-clause-dash", excerpt: d, severity: "hard" })); }
    expect(valOut(ext("USDT held.\n\nThe plumbing flinched.\n\nWatch the next trigger."), { kind: "daily" })).toContainEqual(expect.objectContaining({ ruleId: "scoped-decorative-word", severity: "soft" }));
  });

  it.each(["daily", "weekly"] as const)("keeps raw hard findings separate from advisories in %s enforce mode", (kind) => {
    const p = parseRes(js({ title: "Calm Market", text: "USDT held — watch the next print tomorrow.", extended: "The plumbing flinched.\n\nUSDT held its peg.\n\nWatch the next trigger." }), { register: kind, styleGateMode: "enforce" });
    expect(p.digestText).toContain("—");
    const f = valOut(p, { kind, styleGateMode: "enforce" }).filter((i) => i.code === "editorial-style");
    expect(f).toContainEqual(expect.objectContaining({ ruleId: "no-clause-dash", severity: "hard" }));
    expect(f).toContainEqual(expect.objectContaining({ ruleId: "scoped-decorative-word", severity: "soft" }));
  });

  it.each([
    ["sardonic streak", fx({ tone: "sardonic" }), [{ meta: { lead: "depeg", tone: "sardonic" }, title: "Prior" }], "consecutive-sardonic-tone"],
    ["tone cluster", fx({ tone: "dry" }), Array(5).fill("dry").map((tone, i) => ({ meta: { lead: "depeg", tone }, title: String(i) })), "tone-cluster"],
  ] as const)("finds %s", (_l, parsed, rm, code) => {
    expect(codes(parsed, { kind: "daily", recentMeta: rm.map(({ meta, title }) => ({ meta: { ...meta }, title })) })).toContain(code);
  });

  it("covers mention-only and factual editorial guard boundaries", () => {
    const prof = { kind: "daily" as const, recentMeta: [], leadRequirements: [{ candidateIds: [], severity: "soft" as const, mentionTokens: ["PMUSD"], reason: "ongoing critical" }] };
    expect(codes(fx({ leadSignalId: "yield:usdc", extended: `PMUSD remains 2,950 bps under peg, unchanged. ${DEF_EXT}` }), prof)).not.toContain("required-lead-missing");
    expect(codes(fx({ leadSignalId: "yield:usdc" }), prof)).toContain("required-lead-missing");
    const fc = (t: string, ex: Partial<DigestValidationProfile>) => codes(fx({ extended: `${t} ${DEF_EXT}` }), { kind: "daily", recentMeta: [], ...ex });
    expect(fc("USX sits 5,783 bps below peg while the quote reads $0.997 as a courtesy.", { depegFacts: [{ symbol: "USX", currentPriceUsd: 0.4217, currentBps: -5783 }] })).toContain("price-bps-mismatch");
    expect(fc("USX sits 5,783 bps below peg at $0.42 with no bid in sight.", { depegFacts: [{ symbol: "USX", currentPriceUsd: 0.4217, currentBps: -5783 }] })).not.toContain("price-bps-mismatch");
    expect(fc("APXUSD narrowed from 3,650 bps yesterday.", { prevDepegFacts: [{ symbol: "APXUSD", currentBps: -3159, bps: -3159 }] })).toContain("unverifiable-movement-claim");
    expect(fc("APXUSD widened from 3,159 bps to 3,410 bps overnight.", { prevDepegFacts: [{ symbol: "APXUSD", currentBps: -3159 }] })).not.toContain("unverifiable-movement-claim");
    expect(fc("APXUSD narrowed from 3,159 bps overnight.", { prevDepegFacts: [{ symbol: "APXUSD", currentBps: -420 }, { symbol: "OTHER", currentBps: -3159 }] })).toContain("unverifiable-movement-claim");
    expect(fc("APXUSD narrowed from 3,159 bps overnight.", { prevDepegFacts: [{ symbol: "APXUSD", bps: -3159, peakBps: -3159 }] })).toContain("unverifiable-movement-claim");
    expect(fc("APXUSD narrowed from 3,159 bps overnight.", { prevDepegFacts: [{ symbol: "APXUSD", currentBps: -420, bps: -3159, peakBps: -3159 }] })).toContain("unverifiable-movement-claim");
    expect(codes(fx({ leadSignalId: "yield:usdc", extended: `USDTB remains 2,950 bps under peg, unchanged. ${DEF_EXT}` }), { kind: "daily", recentMeta: [], leadRequirements: [{ candidateIds: [], severity: "hard" as const, mentionTokens: ["USDT"], reason: "ongoing critical" }] })).toContain("required-lead-missing");
    const titles = [{ meta: null, title: "USX Turns Twenty Days Old" }, { meta: null, title: "USX Passes 450 Hours Broken" }];
    expect(codes({ ...fx(), digestTitle: "USX Enters Week Four" }, { kind: "daily", recentMeta: titles })).toEqual(expect.arrayContaining(["title-symbol-streak", "title-day-counting"]));
    expect(codes({ ...fx(), digestTitle: "USDC Touches Its Ceiling" }, { kind: "daily", recentMeta: [], recentTitles: ["USDC Touches Its Ceiling"] })).toContain("repeated-title");
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
  ] as const)("binds numeric claims conservatively: %s", (_l, text, sev) => {
    const issues = valOut({ ...ext("USDT held its peg; watch the next print tomorrow."), digestText: text }, { kind: "daily", depegFacts: [{ symbol: "USDC", currentPriceUsd: 0.995, currentBps: -50 }, { symbol: "USDT", currentPriceUsd: 0.9, currentBps: -1000 }] }).filter((i) => i.code.startsWith("price-bps-"));
    if (sev) expect(issues).toContainEqual(expect.objectContaining({ severity: sev })); else expect(issues).toEqual([]);
    expect(hasBlock(issues)).toBe(sev === "hard");
  });

  it.each([
    ["above", 0.995, -50, "0.995", true], ["over", 0.995, -50, "0.995", true], ["below", 1.005, 50, "1.005", true], ["under", 1.005, 50, "1.005", true],
    ["below", 0.995, -50, "0.995", false], ["under", 0.995, -50, "1.00", false], ["above", 1.005, 50, "1.00", false],
    ["over", 1.1055, 50, "1.106", false], ["under", 1.1055, 50, "1.106", true], ["below", 1.0945, -50, "1.09", false], ["above", 1.0945, -50, "1.09", true],
  ] as const)("checks signed %s peg claims at %s with rounded quote %s", (dir, price, bps, q, blocked) => {
    const issues = valOut({ ...ext("USDT held its peg; watch the next print tomorrow."), digestText: `USDC trades at $${q}, 50 bps ${dir} peg.` }, { kind: "daily", depegFacts: [{ symbol: "USDC", currentPriceUsd: price, currentBps: bps }] }).filter((i) => i.code.startsWith("price-bps-"));
    expect(issues.some((i) => i.code === "price-bps-direction-mismatch" && i.severity === "hard")).toBe(blocked);
    expect(hasBlock(issues)).toBe(blocked);
  });

  it("never binds a dollar claim to native-unit event evidence", () => {
    expect(valOut(fx({ text: "EURC trades at $1.10, 200 bps below peg." }), { kind: "daily", depegFacts: [{ symbol: "EURC", quoteMode: "native-peg", currentPriceUsd: 0.98, currentBps: -200, pegReference: 1 }] }).filter((i) => i.code.startsWith("price-bps-"))).toEqual([]);
  });
});

describe("intelligence, prompt, and regime contracts", () => {
  const cur: DigestInputData = { ...BASE, editorialCandidates: [{ id: "depeg:usdt-tether:active", kind: "depeg", title: "USDT active 175 bps below peg", symbols: ["USDT"], impactScore: 17.5, novelty: "worsening", confidence: "high", artifactRisk: "low", headlineFacts: ["175 bps below peg"], whyItMatters: "Active peg stress is relevant." }, { id: "supply:usdc:accelerating", kind: "supply", title: "USDC supply accelerating", symbols: ["USDC"], impactScore: 12, novelty: "accelerating", confidence: "high", artifactRisk: "low", headlineFacts: ["+$12M in 1d"], whyItMatters: "Supply velocity shows allocation." }] };
  cur.dataQuality = { generatedAt: 200_000, stablecoinsCacheUpdatedAt: 200_000, stablecoinsCacheAgeSec: 0, windows: { blacklistActivity: { label: "24h", start: 113_600, end: 200_000 }, mintBurnFlows: { label: "24h", start: 113_600, end: 200_000 }, supplyVelocity: { label: "UTC", dates: [] }, psi: { label: "latest", sampleAt: 200_000, dailySnapshotAt: null } } };
  cur.topDepegs = [{ ...cur.topDepegs[0], currentBps: -175, severityBasis: "current", startedAt: 1, pegReference: 1, priceObservedAt: 200_000 }];
  const prev: DigestInputData = { ...cur, topDepegs: [{ ...cur.topDepegs[0], currentBps: -100, priceObservedAt: 113_600 }], dataQuality: { ...cur.dataQuality, generatedAt: 113_600 }, stabilityIndex: { score: 91, band: "BEDROCK", components: { severity: 2, breadth: 1, trend: 0 } }, nextTriggers: [{ id: "trigger:depeg:usdt", label: "USDT depeg widening", metric: "depeg-bps", comparator: "abs-gte", thresholdValue: 125, thresholdLabel: "125 bps off peg", symbol: "USDT", rationale: "Wider deviation raises severity.", detail: "If USDT reaches 125 bps off peg, severity rises." }] };

  it("builds change, trigger, risk, and calm-frame intelligence and expires stale triggers", () => {
    const intel = buildIntel(cur, prev);
    expect(intel.calmNarrativeFrame).toMatchObject({ label: "Supply rotation" }); expect(intel.nextTriggers?.[0]).toMatchObject({ metric: "depeg-bps" });
    expect(intel.changeSummary?.worsenedSignals[0]).toMatchObject({ label: "USDT depeg widened" }); expect(intel.forwardLookOutcomes?.[0]).toMatchObject({ status: "hit", triggerId: "trigger:depeg:usdt" });
    let prior: DigestInputData | null = null;
    const eds = Array.from({ length: 4 }, (_, i) => {
      const g = 200_000 + i * 86_400, obs = { ...cur, dataQuality: { ...cur.dataQuality!, generatedAt: g }, topDepegs: [{ ...cur.topDepegs[0], priceObservedAt: g }] };
      return (prior = { ...obs, nextTriggers: buildTrig(obs, prior) });
    });
    expect(eds.slice(0, 3).map((d) => d.nextTriggers?.[0]?.repeatedCount ?? 0)).toEqual([0, 1, 2]);
    expect(eds[3].nextTriggers?.some((t) => t.id === "trigger:depeg:usdt-tether")).toBe(false);
    expect(buildOut(eds[3], eds[2])).toContainEqual(expect.objectContaining({ status: "expired" }));
  });

  it("renders a sticky trigger's detail from the kept threshold, not today's re-derived one", () => {
    const armed: DigestInputData = { ...prev, nextTriggers: [{ id: "trigger:depeg:usdt-tether", label: "USDT depeg widening", metric: "depeg-bps", comparator: "abs-gte", thresholdValue: 300, thresholdLabel: "300 bps off peg", symbol: "USDT", rationale: "Wider deviation raises severity.", detail: "If USDT reaches 225 bps off peg, the next digest should treat it as a stronger peg-stress signal." }] };
    const t = buildTrig(cur, armed).find((e) => e.id === "trigger:depeg:usdt-tether");
    expect(t).toMatchObject({ thresholdValue: 300, thresholdLabel: "300 bps off peg", repeatedCount: 1, detail: "If USDT reaches 300 bps off peg, the next digest should treat it as a stronger peg-stress signal." });
  });

  const liqIn = (d: number, s = 68): DigestInputData => ({ ...cur, topDepegs: [], stabilityIndex: null, editorialCandidates: [{ id: `liquidity:usdt:${d}`, kind: "liquidity", title: "USDT liquidity shift", symbols: ["USDT"], impactScore: 10, novelty: "new", confidence: "high", artifactRisk: "low", headlineFacts: ["Liquidity shifted"], whyItMatters: "Depth changed." }], liquidityShifts: [{ symbol: "USDT", currentScore: s, previousScore: s - d, scoreDelta: d, currentTvl: 20e6, previousTvl: 20e6, mcapUsd: 100e6, tvlChangePct: 0, expectedScoreDeltaFromTvl: 0, coverageClass: "primary", coverageConfidence: 1 }] });
  const liqEv = (currentScore: number, stablecoinId = "usdt-tether") => ({ liquidity: [{ stablecoinId, symbol: "USDT", currentScore }] });

  it.each([
    ["decay to recovery", -8, 60, 8, "lte", 52, "falls to 52"], ["recovery to decay", 8, 76, -8, "gte", 84, "climbs to 84"],
    ["continued decay", -8, 60, -8, "lte", 52, "falls to 52"], ["continued recovery", 8, 76, 8, "gte", 84, "climbs to 84"],
  ] as const)("preserves the whole armed liquidity condition through %s", (_l, pd, ps, nd, cmp, tv, det) => {
    const p = liqIn(pd, ps), armed = { ...p, nextTriggers: buildTrig(p, null, liqEv(ps)) }, today = liqIn(nd), next = buildTrig(today, armed, liqEv(68));
    expect(next[0]).toEqual({ ...armed.nextTriggers[0], repeatedCount: 1 });
    expect(next[0]).toMatchObject({ metric: "liquidity-score", comparator: cmp, thresholdValue: tv, stablecoinId: "usdt-tether" });
    expect(next[0].detail).toContain(det);
    expect(buildOut(today, armed, liqEv(68))[0].status).toBe("pending");
    expect(buildOut(today, { ...today, nextTriggers: next }, liqEv(68))[0].status).toBe("pending");
  });

  it.each([[-8, 60, 52, 8, "gte", 60], [8, 76, 84, -8, "lte", 76]] as const)("re-arms a hit liquidity condition at score %s/%s/%s", (pd, ps, hs, nd, cmp, tv) => {
    const p = liqIn(pd, ps), armed = { ...p, nextTriggers: buildTrig(p, null, liqEv(ps)) }, today = liqIn(nd, hs);
    expect(buildOut(today, armed, liqEv(hs))[0].status).toBe("hit");
    const fresh = buildTrig(today, null, liqEv(hs))[0];
    expect(buildTrig(today, armed, liqEv(hs))[0]).toEqual(fresh);
    expect(fresh).toMatchObject({ id: "trigger:liquidity:usdt", comparator: cmp, thresholdValue: tv }); expect(fresh.repeatedCount).toBeUndefined();
  });

  it("expires a reversed liquidity condition at the existing pending-edition TTL", () => {
    const p = liqIn(-8, 60); let armed = { ...p, nextTriggers: buildTrig(p, null, liqEv(60)) }; const today = liqIn(8);
    for (const rc of [1, 2]) { armed = { ...today, nextTriggers: buildTrig(today, armed, liqEv(68)) }; expect(armed.nextTriggers[0]).toMatchObject({ comparator: "lte", thresholdValue: 52, repeatedCount: rc }); }
    expect(buildOut(today, armed, liqEv(68))[0].status).toBe("expired"); expect(buildTrig(today, armed, liqEv(68))).toEqual([]);
  });

  it("retains the armed target and condition when its evidence is unavailable", () => {
    const p = liqIn(-8, 60), armed = { ...p, nextTriggers: buildTrig(p, null, liqEv(60)) }, today = liqIn(8), rep = liqEv(68, "different-usdt");
    expect(buildOut(today, armed, rep)[0].status).toBe("unavailable");
    const next = buildTrig(today, armed, rep);
    expect(next[0]).toEqual({ ...armed.nextTriggers[0], repeatedCount: 1 }); expect(buildOut(today, { ...today, nextTriggers: next }, rep)[0].status).toBe("unavailable");
  });

  it.each([
    ["weekly fallback", { ...cur, supplyVelocity: [], supplyChanges7d: [{ coin: "USDC", change7d: 40_000_000 }] }, "USDC"],
    ["coin-specific velocity", { ...cur, biggestSupplyChange: { id: "usdt-tether", symbol: "USDT", name: "Tether", changeUsd: 90_000_000, currentMcap: 100_000_000 } }, "USDC"],
  ] as Array<[string, DigestInputData, string]>)("evaluates %s trigger against %s", (_l, today, symbol) => {
    const prior: DigestInputData = { ...cur, dataQuality: { generatedAt: 1_772_668_800, stablecoinsCacheUpdatedAt: null, stablecoinsCacheAgeSec: null, windows: { blacklistActivity: { label: "x", start: 0, end: 0 }, mintBurnFlows: { label: "x", start: 0, end: 0 }, supplyVelocity: { label: "x", dates: [] }, psi: { label: "x", sampleAt: null, dailySnapshotAt: null } } }, nextTriggers: [{ id: "trigger:supply-7d:usdc", label: "USDC weekly supply move", metric: "supply-7d-usd", comparator: "abs-gte", thresholdValue: 30_000_000, thresholdLabel: "$30M 7d move", symbol, rationale: "Follow-through matters.", detail: "The move has follow-through." }] };
    expect(buildIntel(today, prior).forwardLookOutcomes?.[0]).toMatchObject({ status: "hit", triggerId: "trigger:supply-7d:usdc" });
  });

  it("makes unavailable FTQ explicit and emits the canonical safety-map prompt", () => {
    const unavail: DigestInputData = { ...cur, mintBurnFlows: { gaugeScore: 0, gaugeBand: "NEUTRAL", classificationSource: "unavailable", classificationReason: "identity-missing", safetyScoreIdentity: null, flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 }, topPressure: [] } };
    expect(prompt(unavail)).toContain("Flight-to-Quality: unavailable (identity-missing)");
    expect(buildIntel(unavail, null).riskTape).toContainEqual(expect.objectContaining({ detail: expect.stringContaining("unavailable") }));
    const data: DigestInputData = { totalMcapUsd: 100e9, mcap7dDelta: 0, activeDepegCount: 0, topDepegs: [], biggestSupplyChange: null, stabilityIndex: null, yesterdayIndex: null, safetyContext: BASE_SAFE };
    const res = { kind: "available" as const, imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-08-30", freshness: "carried-forward" as const, ageDays: 2, manifest: { date: "2026-08-30", asOfSec: 1_788_000_000, renderedAtSec: 1_788_001_000, edition: "daily" as const, bytes: { png: 1_000_000 }, mapSummary: MAP_SUM } };
    const cap = buildMapCap(data, res);
    expect(cap).toMatchObject({ manifest: { mapSummary: { date: "2026-08-30" } } });
    expect(prompt({ ...data, safetyMap: cap! })).toContain("A tier: 2 coins, 70.0% of known mapped supply");
    expect(buildMapCap(data, { ...res, manifest: { ...res.manifest, date: "2026-08-29" } })).toBeNull();
    expect(buildMapCap({ ...data, safetyContext: { status: "unavailable", expectedModel: "v9", identity: null, publishedAt: null, reason: "held" } }, res)).toBeNull();
  });

  it.each([
    ["CALM", { ...BASE, activeDepegCount: 0, topDepegs: [] }],
    ["CRISIS", { ...BASE, mintBurnFlows: { gaugeScore: -20, gaugeBand: "CAUTIOUS", flightToQuality: { active: true, safeNetUsd: 200e6, riskyNetUsd: -200e6 }, topPressure: [] } }],
    ["CRISIS", { ...BASE, stabilityIndex: { score: 65, band: "TREMOR", components: { severity: 30, breadth: 5, trend: -3 } } }],
    ["TENSION", { ...BASE, dewsStress: { bandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 }, yesterdayBandCounts: { calm: 100, watch: 10, alert: 2, warning: 1, danger: 0 }, bandChangeCount: 0, alertPlusMcapUsd: 2e9, alertPlusSupplyCoverage: { complete: true, observedCount: 3, unavailableCount: 0 }, bandChanges: [], elevatedCoins: [{ symbol: "USDT", band: "ALERT", score: 50, mcapUsd: 2e9 }] } }],
    ["WATCHFUL", { ...BASE, activeDepegCount: 1, topDepegs: [{ symbol: "USDT", bps: 5, mcapUsd: 100e9 }] }],
  ] as const)("classifies %s regime", (exp, d) => expect(regime(d as DigestInputData)).toBe(exp));

  it.each(PSI_CONDITION_BAND_VALUES)("classifies PSI band %s and its reader-facing tape tone", (band) => {
    const d: DigestInputData = { ...BASE, activeDepegCount: 0, topDepegs: [], mintBurnFlows: undefined, dewsStress: undefined, stabilityIndex: { score: 50, band, components: { severity: 0, breadth: 0, trend: 0 } } };
    expect(regime(d)).toBe(band === "BEDROCK" || band === "STEADY" ? "CALM" : "CRISIS");
    const psi = riskTape(d).find((i) => i.id === "risk-tape:psi");
    expect(psi?.value).toContain(band);
    expect(psi?.tone).toBe(band === "BEDROCK" ? "positive" : band === "STEADY" ? "neutral" : band === "TREMOR" ? "warning" : "critical");
    const p = prompt(d);
    expect(p).toContain(`Writing register: ${DIGEST_WRITING_REGISTER[regime(d)]}`);
    expect(p).not.toMatch(/\b(?:TENSION|WATCHFUL)\b|regime: /);
  });

  it.each([[110e9, "10.00% above", "10% above"], [100e9, "at", "at"], [90e9, "10.00% below", "10% below"]] as const)(
    "renders total and coin ATH distances at current cap %s", (mc, tot, coin) => {
      const p = prompt({ ...BASE, totalMcapUsd: mc, supplyCoverage: { complete: true, observedCount: 1, unavailableCount: 0 }, totalMcapAth: { value: 100e9, date: 1_770_000_000, daysAgo: 10 }, biggestSupplyChange: { id: "usdt-tether", symbol: "USDT", name: "Tether", changeUsd: 1e9, currentMcap: mc }, historicalContext: { psiPrecedent: null, psiBandStreak: 1, digestTrackingDays: 30, supplyMoverContext: { allTimeHighMcap: 100e9, allTimeHighDate: 1_770_000_000, largestWeeklyChange: 2e9, largestWeeklyChangeDate: 1_770_000_000, largestWeeklyChangeDaysAgo: 10 } } });
      expect(p).toContain(`total mcap is ${tot} its Digest-window ATH`); expect(p).toContain(`Current mcap is ${coin} ATH`);
      expect(p).not.toMatch(/-\d+\.\d+% (?:above|below).*ATH|-\d+% (?:above|below).*ATH/);
    },
  );

  it("keeps the prompt register and V9 pillars canonical", () => {
    expect(SYSTEM_PROMPT.startsWith(buildEditorialPrompt("daily"))).toBe(true);
    expect(SYSTEM_PROMPT).toContain(`Allowed tones: ${ALLOWED_TONES.join(", ")}.`);
    expect(SYSTEM_PROMPT).not.toContain("FORBIDDEN TICS"); expect(SYSTEM_PROMPT).not.toMatch(/\b(?:TENSION|WATCHFUL)\b/);
    expect(scanEditorialText(DAILY_EXEMPLAR, { register: "daily" }).filter(({ severity }) => severity === "hard")).toEqual([]);
    const pil = { score: 91, evidenceLevel: "strong" as const, freshness: "current" as const, reasons: [] };
    expect(prompt({ ...BASE, safetyScores: { model: "v9", mentionedCoins: [{ symbol: "USDT", grade: "A+", score: 88, pillars: { backing: pil, exit: { ...pil, score: 86 }, control: { ...pil, score: 84 } }, reasonCodes: ["bounded-mechanism-review"], caps: [], bindingCap: null }], gradeDistribution: { "A+": 1 }, provenance: { ...BASE_SAFE.identity, publishedAt: BASE_SAFE.publishedAt } } })).toContain("backing=91, exit=86, control=84");
  });
});

describe("market and risk collectors", () => {
  it("suppresses Safety copy when the accepted publication is past the consumer budget", async () => {
    const ctx = ctxFor([]), cards = [{ id: "usdt-tether", overallGrade: "A", overallScore: 88 }];
    vm(loadSafe).mockResolvedValueOnce(safeSrc(cards, ctx.nowSec - 7_200));
    expect((await colSafe(ctx, new Set(["USDT"]))).value.safetyContext).toMatchObject({ status: "available" });
    vm(loadSafe).mockResolvedValueOnce(safeSrc(cards, ctx.nowSec - 7_201));
    const stale = await colSafe(ctx, new Set(["USDT"]));
    expect(stale.degradedReasons).toEqual(["safety-canonical-snapshot"]);
    expect(stale.value).toMatchObject({ safetyScores: undefined, safetyGrades: undefined, safetyIdentity: undefined, safetyContext: { status: "unavailable", identity: null, reason: "v9-snapshot-stale" } });
  });

  it.each(["complete", "page-failure", "count-mismatch"] as const)("drains indexed 500-row organic identity pages before stamping %s accounting", async (mode) => {
    vm(loadSafe).mockResolvedValueOnce(safeSrc([{ id: "usdt-tether", overallGrade: "A", overallScore: 88 }, { id: "dai-makerdao", overallGrade: "B", overallScore: 70 }]));
    const scores = await colSafe(ctxFor([]), new Set(["USDT"]));
    expect(scores.value.safetyContext).toMatchObject({ status: "available", expectedModel: "v9" });
    expect(scores.value.safetyScores).toMatchObject({ model: "v9", mentionedCoins: [{ symbol: "USDT", grade: "A", score: 88 }] });
    const id = scores.value.safetyIdentity!, { sqlite } = nqFx.open(), now = nowS();
    const ins = sqlite.prepare("INSERT INTO safety_score_history_v2 (history_id, stablecoin_id, recorded_at, model, identity_schema_version, methodology_version, policy_id, policy_digest, evaluation_build_digest, base_input_generation_id, model_publication_generation_id, transition_kind, grade, score, prev_grade, prev_score, created_at) VALUES (?, ?, ?, 'v9', ?, ?, ?, ?, ?, ?, ?, ?, 'A-', ?, ?, ?, ?)");
    const add = (hid: string, at: number, coin = "usdt-tether", s = 80, pr = 85, bld = id.evaluationBuildDigest, kind = "organic-grade-change", pol = id.policyDigest) =>
      ins.run(hid, coin, at, id.schemaVersion, id.methodologyVersion, id.policyId, pol, bld, id.baseInputGenerationId, id.publicationGenerationId, kind, s, kind === "organic-grade-change" ? "A" : null, kind === "organic-grade-change" ? pr : null, now);
    for (let i = 0; i < 1003; i++) add(`eligible:${String(i).padStart(4, "0")}`, now - 60, "usdt-tether", i % 2 ? 80 : 90);
    for (let i = 0; i < 12; i++) add(`small:${i}`, now - 120 - i, "dai-makerdao", 0, 100);
    for (let i = 0; i < 16; i++) add(`bump:${i}`, now - 300, "usdt-tether", 100, 0);
    add("wrong-build", now - 400, "usdt-tether", 0, 100, "1".repeat(64)); add("wrong-policy", now - 401, "usdt-tether", 0, 100, undefined, undefined, "2".repeat(64));
    add("baseline", now - 402, "usdt-tether", 0, 100, undefined, "methodology-boundary-baseline");
    add("outside-start", now - 172801); add("at-start", now - 172800); add("at-end", now);
    let pages = 0; const plans: string[] = [];
    const db = createSqliteD1(sqlite, { onAll(sql) {
      if (!sql.includes("SELECT history_id, recorded_at")) return;
      if (++pages === 1) {
        plans.push(...sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(sql.split("?").length - 1).fill(null)).map((r) => String(r.detail)));
        if (mode === "count-mismatch") add("concurrent-insert", now - 30);
      }
      if (mode === "page-failure" && pages === 2) throw new Error("second D1 page failed");
    } });
    const res = await colGrades(mkCtx(db), scores.value.safetyGrades, id);
    if (mode === "complete") {
      expect(res.degradedReasons).toEqual([]); expect(res.value.gradeTransitions).toHaveLength(5);
      expect(res.value.gradeTransitions?.every((r) => r.symbol === "USDT")).toBe(true);
      expect(res.value.gradeTransitions?.[0]).toMatchObject({ symbol: "USDT", fromGrade: "A", toGrade: "A-" });
      const acc = res.value.gradeTransitionAccounting!;
      expect(acc).toMatchObject({ complete: true, count: 1004, window: { start: now - 172800, end: now } });
      if (acc.complete) { expect(new Set(acc.identities.map((r) => r.historyId)).size).toBe(1004); expect(acc.identities[0]).toEqual({ historyId: "at-start", recordedAt: now - 172800 }); }
      expect(pages).toBe(3);
    } else {
      expect(res.degradedReasons).toEqual(["grade-transitions-query"]);
      expect(res.value.gradeTransitionAccounting).toMatchObject({ complete: false, reason: "grade-transitions-query" });
      expect(res.value.gradeTransitionAccounting).not.toHaveProperty("identities"); expect(res.value.gradeTransitions).toBeUndefined();
      expect(pages).toBe(mode === "page-failure" ? 2 : 3);
    }
    expect(plans.some((d) => /SEARCH safety_score_history_v2 USING INDEX idx_safety_score_history_v2_recorded_at.*recorded_at>.*recorded_at</.test(d))).toBe(true);
  });

  it.each([
    ["missing", () => noGaugeTbl(), undefined, [], ["mint-burn-gauge-missing"]],
    ["malformed", () => gTbl({ value: '{"gauge":{"score":"nope"}}' }), undefined, ["mint-burn-gauge-malformed"], []],
    ["expired", () => gTbl({ ageSec: 25 * 3600 }), undefined, ["mint-burn-gauge-expired"], []],
    ["stale", () => gTbl({ ageSec: 3 * 3600 }), G_SCORE, ["mint-burn-gauge-stale"], []],
  ] as const)("handles %s published gauge", async (_l, t, sc, dr, qr) => {
    const r = await colMb(ctxFor([t()])); expect(r.value?.gaugeScore).toBe(sc); expect(r.degradedReasons).toEqual(dr); expect(r.qualityReasons ?? []).toEqual(qr);
  });

  it("re-bins the published gauge, includes FTQ chains, and never reads hourly rows", async () => {
    const db = mockD1([gTbl()]), r = await colMb(mkCtx(db));
    expect(r.value).toMatchObject({ gaugeScore: G_SCORE, gaugeBand: "HEALTHY", classificationSource: "safety-score-v9-publication", topChains: [{ chainId: "ethereum", netUsd: 150e6 }, { chainId: "arbitrum", netUsd: -3e6 }] });
    expect(r.value?.topPressure.map(({ symbol }) => symbol)).toEqual(["XAUT", "USDC"]);
    expect(prompt({ ...BASE, mintBurnFlows: r.value! })).toContain("Top chains by net flow");
    expect(db.getHistory().some(({ sql }) => sql.includes("mint_burn_hourly"))).toBe(false);
  });

  it("separates a withheld net's unavailable 24h window from its missing valuation", async () => {
    const coins = gPay().coins as Record<string, unknown>[];
    const cov = (ok: boolean) => ({ startBlock: 0, lastSyncedBlock: null, lagBlocks: null, historyStartAt: null, has24hWindow: ok, has30dWindow: true, has90dWindow: true, isPartial: !ok, status: ok ? "full" : "bootstrapping", windows: { window24h: { complete: ok, unavailableReason: ok ? null : "scan-coverage-incomplete" }, window7d: { complete: true, unavailableReason: null }, window30d: { complete: true, unavailableReason: null }, window90d: { complete: true, unavailableReason: null } } });
    const pVal = { ...(coins[2].valuation as Record<string, unknown>), window24h: { completeness: "partial", mintCompleteness: "partial", burnCompleteness: "complete", unpricedMintEventCount: 1, unpricedBurnEventCount: 0 } };
    const wh = (c: Record<string, unknown>) => colMb(ctxFor([gVal({ coins: [coins[0], coins[1], c, coins[3]] })]));
    const valued = await wh({ ...coins[2], netFlow24hUsd: null, valuation: pVal, coverage: cov(true) });
    expect(valued.degradedReasons).toEqual([]); expect(valued.qualityReasons).toContain("mint-burn-ftq-valuation-incomplete");
    const unsc = await wh({ ...coins[2], netFlow24hUsd: null, valuation: pVal, coverage: cov(false) });
    expect(unsc.degradedReasons).toEqual(["mint-burn-ftq:flow-window-unavailable"]);
    expect(unsc.value).toMatchObject({ classificationSource: "unavailable", classificationReason: "flow-window-unavailable", flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 } });
    expect(regime({ ...BASE, activeDepegCount: 0, topDepegs: [], stabilityIndex: { score: 88, band: "STEADY", components: { severity: 2, breadth: 1, trend: 0 } }, mintBurnFlows: unsc.value, degradedSources: unsc.degradedReasons })).not.toBe("CALM");
  });

  it.each([
    ["USG idle inventory burn", 3_860_000, 3_860_000, false], ["confirmed redemption", 40_710_000, 3_860_000, true],
    ["missing supply evidence", undefined, undefined, false], ["opposite supply move", 3_860_000, 40_710_000, false],
  ] as const)("admits pressure against independent history: %s", async (_l, bef, aft, adm) => {
    const ctx = ctxFor([]), end = ctx.todayTs + 8 * 3600, baseCoins = gPay().coins as Record<string, unknown>[];
    const usg = { ...baseCoins[0], stablecoinId: "usg-tangent", symbol: "USG", pressureShiftScore: -100, netFlow24hUsd: -36_850_000, gaugeWeightUsd: 3_860_000 };
    const small = { ...usg, stablecoinId: "small", symbol: "SMALL", pressureShiftScore: 50, netFlow24hUsd: -10_000 };
    const db = mockD1([
      gVal({ gauge: { score: -15.5, partialValuationInputs: 0, scoredMcapUsd: 67.7e9 }, window: { start: end - 86400, end, semantics: "closed-utc-hours" }, coins: [usg, ...baseCoins, small] }),
      { match: "FROM supply_history WHERE stablecoin_id IN", matchBinds: ["usg-tangent", ctx.todayTs - 86400, ctx.todayTs], rows: bef == null ? [] : [{ stablecoin_id: "usg-tangent", snapshot_date: ctx.todayTs - 86400, circulating_usd: bef }, { stablecoin_id: "usg-tangent", snapshot_date: ctx.todayTs, circulating_usd: aft }] },
    ]);
    const r = await colMb({ ...ctx, db }), syms = r.value!.topPressure.map((c) => c.symbol);
    expect(syms.includes("USG")).toBe(adm); expect(syms).toHaveLength(3); expect(syms.includes("SMALL")).toBe(!adm); expect(r.degradedReasons).toEqual([]);
    if (adm) expect(r.value!.topPressure.find((c) => c.symbol === "USG")?.gaugeWeightShare).toBeCloseTo(3.86e6 / 67.7e9);
    else {
      expect(r.qualityReasons).toContain(bef == null ? "mint-burn-pressure-supply-unavailable" : "mint-burn-pressure-supply-unconfirmed");
      const inp = { ...BASE, mintBurnFlows: r.value };
      expect(prompt(inp)).not.toContain("USG"); expect(buildCands(inp).some((c) => c.symbols.includes("USG"))).toBe(false);
    }
  });

  it("does not certify a partial-chain remainder as a complete 24h supply total", async () => {
    const ctx = ctxFor([]), baseCoins = gPay().coins as Record<string, unknown>[];
    const fdusd = { ...baseCoins[0], stablecoinId: "fdusd-first-digital", symbol: "FDUSD", pressureShiftScore: 100, netFlow24hUsd: 38_000_000, gaugeWeightUsd: 150_000_000 };
    const prov = (p: boolean) => js({ supplySource: "defillama", supplyObservedAt: ctx.todayTs - 2 * 86400, supplyChainGuard: p ? { reason: "supply-chain-dropout", status: "chains-unavailable", partialCoverage: true, quarantinedSince: ctx.todayTs - 9 * 86400, chains: [{ chainId: "sui", chainLabel: "Sui", listCurrentUsd: 0, baselineUsd: 20_000_000, baselineObservedAt: ctx.todayTs - 10 * 86400, baselineSource: "state", resolution: "unavailable" }] } : null });
    const col = (pp: boolean) => colMb({ ...ctx, db: mockD1([
      gVal({ gauge: { score: -15.5, partialValuationInputs: 0, scoredMcapUsd: 67.7e9 }, window: { start: ctx.todayTs - 86400, end: ctx.todayTs, semantics: "closed-utc-hours" }, coins: [fdusd, ...baseCoins] }),
      { match: "FROM supply_history WHERE stablecoin_id IN", rows: [{ stablecoin_id: "fdusd-first-digital", snapshot_date: ctx.todayTs - 86400, circulating_usd: 480_000_000, supply_provenance: prov(pp) }, { stablecoin_id: "fdusd-first-digital", snapshot_date: ctx.todayTs, circulating_usd: 500_000_000, supply_provenance: prov(false) }] },
    ]) });
    expect((await col(false)).value!.topPressure.map((c) => c.symbol)).toContain("FDUSD");
    const r = await col(true);
    expect(r.value!.topPressure.map((c) => c.symbol)).not.toContain("FDUSD"); expect(r.qualityReasons).toContain("mint-burn-pressure-supply-unavailable");
  });

  it("isolates a failed supply confirmation query from small pressure and the gauge", async () => {
    const ctx = ctxFor([]), baseCoins = gPay().coins as Record<string, unknown>[];
    const r = await colMb({ ...ctx, db: mockD1([
      gVal({ window: { start: ctx.todayTs - 86400, end: ctx.todayTs, semantics: "closed-utc-hours" }, coins: [...baseCoins, { ...baseCoins[0], stablecoinId: "usg-tangent", symbol: "USG", pressureShiftScore: -100, netFlow24hUsd: -36_850_000, gaugeWeightUsd: 3_860_000 }] }),
      { match: "FROM supply_history WHERE stablecoin_id IN", rows: [], throwError: new Error("D1 unavailable") },
    ]) });
    expect(r.value?.gaugeScore).toBe(G_SCORE); expect(r.value?.topPressure.map((c) => c.symbol)).toEqual(["XAUT", "USDC"]);
    expect(r.degradedReasons).toContain("mint-burn-pressure-supply-query"); expect(r.qualityReasons).toContain("mint-burn-pressure-supply-unavailable");
  });

  it.each([[3.86e6 / 67.7e9, false], [0.009999, false], [0.01, true], [undefined, false], [null, false]] as const)(
    "gates per-coin gauge facts and next triggers at scored weight share %s", (gws, mat) => {
      const inp: DigestInputData = { ...BASE, topDepegs: [], stabilityIndex: null, mintBurnFlows: { gaugeScore: -15.5, gaugeBand: "CAUTIOUS", flightToQuality: { active: false, safeNetUsd: 0, riskyNetUsd: 0 }, topPressure: [{ symbol: "USG", intensity: -100, net24hUsd: -100_000, gaugeWeightShare: gws }] } };
      const cands = buildCands(inp).filter((c) => c.kind === "mint-burn");
      expect(cands).toHaveLength(1); expect(cands[0].headlineFacts.some((f) => f.includes("Bank Run Gauge"))).toBe(mat);
      if (gws != null && !mat) expect(cands[0].headlineFacts.join(" ")).toContain("negligible");
      if (gws == null) expect(cands[0].headlineFacts.join(" ")).toContain("unavailable");
      expect(prompt(inp)).toContain(cands[0].headlineFacts.find((f) => f.includes("weight share"))!);
      expect(buildTrig({ ...inp, editorialCandidates: cands }).some((t) => t.metric === "bank-run-gauge")).toBe(mat);
      expect(SYSTEM_PROMPT).toContain("never link its flow to aggregate gauge movement");
    },
  );

  it.each(["2026-03-06T11:59:59Z", "2026-03-06T12:00:01Z"])("persists the retained producer window rather than the collection hour at %s", async (at) => {
    vi.setSystemTime(new Date(at));
    const window = { start: 1_772_697_600, end: 1_772_784_000, semantics: "closed-utc-hours" }, pubAt = Math.floor(new Date("2026-03-06T08:05:00Z").getTime() / 1000), updAt = pubAt - 600;
    const sc = mkScen({ db: { prependTables: [gTbl({ ageSec: nowS() - pubAt, value: js(gPay({ window, updatedAt: updAt })) })] } });
    vm(loadCache).mockResolvedValue(sc.sourcePayload);
    const { inputData } = await buildIn(sc.db), { sqlite } = nqFx.open(), genAt = nowS();
    await insertDigestRecord({ db: createSqliteD1(sqlite), generatedAt: genAt, inputData, digestText: "Retained source capture.", digestTitle: "Source capture", digestExtended: null, digestMeta: null });
    const cap = parseStoredDigestInput((sqlite.prepare("SELECT input_data FROM daily_digest WHERE generated_at = ?").get(genAt) as { input_data: string }).input_data)!;
    expect(cap.mintBurnFlows?.provenance).toEqual({ window, publishedAt: pubAt, updatedAt: updAt });
    expect(js(cap.mintBurnFlows?.provenance?.window)).toBe(js(window));
    expect(cap.dataQuality?.windows.mintBurnFlows).toEqual({ label: "24 closed UTC hours", start: window.start, end: window.end });
    expect(cap.dataQuality?.degradedSources).toContain("mint-burn-gauge-stale");
  });

  it.each([undefined, { start: "unreadable", end: 123, semantics: "closed-utc-hours" }])("leaves legacy or unreadable producer windows unavailable: %j", async (window) => {
    const sc = mkScen({ db: { prependTables: [gVal({ window })] } });
    vm(loadCache).mockResolvedValue(sc.sourcePayload);
    const { inputData } = await buildIn(sc.db);
    expect(inputData.mintBurnFlows?.provenance).toMatchObject({ window: null, updatedAt: null });
    expect(inputData.dataQuality?.windows.mintBurnFlows).toEqual({ label: "unavailable", start: null, end: null });
    const p = prompt(inputData); expect(p).toContain("Mint/burn window: unavailable"); expect(p).not.toContain("1970-01-01");
  });

  it.each([
    ["no prior-week buckets", () => undefined, null, 0],
    ["every prior-week bucket zero-delta (measured flat)", (c: number) => c, 0, 2],
    ["partial prior-week coverage", (c: number, i: number) => (i === 0 ? c - 5_000_000 : undefined), 5_000_000, 1],
  ])("%s: seven-day change is null only when no comparison pair exists", async (_n, prior, exp, cov) => {
    const sc = mkScen(), src = sc.sourcePayload as unknown as { payload: { peggedAssets: Array<Record<string, unknown> & { circulating: { peggedUSD: number } }> } };
    src.payload.peggedAssets = src.payload.peggedAssets.map((a, i) => { const p = prior(a.circulating.peggedUSD, i), { circulatingPrevWeek: _d, ...r } = a; return p === undefined ? r : { ...r, circulatingPrevWeek: { peggedUSD: p } }; });
    vm(loadCache).mockResolvedValue(sc.sourcePayload);
    const { inputData } = await buildIn(sc.db);
    expect(inputData.mcap7dDelta).toBe(exp); expect(inputData.mcap7dDeltaCoverage?.coveredCoins).toBe(cov);
    const line = prompt(inputData).split("\n").find((l) => l.startsWith("7-day market cap change:"))!;
    if (exp === null) expect(line).toBe("7-day market cap change: unavailable (no-7d-comparison-pairs)");
    else expect(line).toContain(exp === 0 ? "+$0" : "+$5.00M");
  });

  it("records the cache-fallback seven-day change as unavailable, never zero", async () => {
    vm(loadCache).mockResolvedValue({ kind: "unavailable", reason: "stablecoins-cache-missing" } as never);
    expect((await buildIn(mkScen().db)).inputData.mcap7dDelta).toBeNull();
  });

  it("names outage-fallback carried supply in coverage instead of counting it as an observation", async () => {
    const ctrl = mkScen(); vm(loadCache).mockResolvedValue(ctrl.sourcePayload);
    expect((await buildIn(ctrl.db)).inputData.supplyCoverage).toMatchObject({ complete: true, observedCount: 2, unavailableCount: 0 });
    const sc = mkScen(), src = sc.sourcePayload as unknown as { payload: { peggedAssets: Array<Record<string, unknown>> } };
    src.payload.peggedAssets = src.payload.peggedAssets.map((a) => a.id === "usdt-tether" ? { ...a, supplyRestored: true, supplyRestoreMode: "outage-fallback" } : a);
    vm(loadCache).mockResolvedValue(sc.sourcePayload);
    const { inputData: d } = await buildIn(sc.db);
    expect(d).toMatchObject({ totalMcapUsd: 60_000_000, mcap7dDelta: -2_000_000, mcap7dDeltaCoverage: { coveredCoins: 1 }, biggestSupplyChange: { id: "usdc-circle" }, supplyCoverage: { complete: false, observedCount: 1, carriedCount: 1, carriedIds: ["usdt-tether"] } });
    expect(d.supplyChanges7d?.map((c) => c.stablecoinId)).toEqual(["usdc-circle"]);
    expect(d.dataQuality?.degradedSources).toContain("supply-current-unavailable");
    const p = prompt(d); expect(p).toContain("1 observed"); expect(p).toContain("1 carried");
  });

  it("keeps a routine main-path carry as an observed member", async () => {
    const sc = mkScen(), src = sc.sourcePayload as unknown as { payload: { peggedAssets: Array<Record<string, unknown>> } };
    src.payload.peggedAssets = src.payload.peggedAssets.map((a) => a.id === "usdt-tether" ? { ...a, supplyRestored: true } : a);
    vm(loadCache).mockResolvedValue(sc.sourcePayload);
    const { inputData: d } = await buildIn(sc.db);
    expect(d.totalMcapUsd).toBe(160_000_000);
    expect(d.supplyCoverage).toMatchObject({ complete: true, observedCount: 2, unavailableCount: 0 });
    expect(d.supplyCoverage?.carriedCount).toBeUndefined();
    expect(d.dataQuality?.degradedSources ?? []).not.toContain("supply-current-unavailable");
  });

  it("pages a stale cache but keeps a partial core supply cohort as metadata", async () => {
    const sc = mkScen(), src = sc.sourcePayload as { updatedAt: number; payload: { peggedAssets: Array<Record<string, unknown>> } };
    src.updatedAt = nowS() - FRESH_MAX.stablecoins - 1;
    src.payload.peggedAssets = src.payload.peggedAssets.filter((a) => a.id === "usdt-tether").map(({ circulatingPrevWeek: _d, ...a }) => a);
    vm(loadCache).mockResolvedValue(sc.sourcePayload);
    const rec = (await buildIn(sc.db)).inputData.dataQuality?.degradedSources ?? [];
    expect(rec).toEqual(expect.arrayContaining(["stablecoins-cache-stale", "supply-current-unavailable", "supply-prev-week-baseline"]));
    const crit = REGIME_CRITICAL_DIGEST_DEGRADED_SOURCES as readonly string[];
    expect(crit).toContain("stablecoins-cache-stale"); expect(crit).not.toContain("supply-current-unavailable"); expect(crit).not.toContain("supply-prev-week-baseline");
  });

  it("never restates flow claims that missing valuation could alter", async () => {
    const pMint = { window24h: { completeness: "partial", mintCompleteness: "partial", burnCompleteness: "complete", unpricedMintEventCount: 1, unpricedBurnEventCount: 0 }, baseline: "complete", netFlow7d: "partial", netFlow30d: "partial", netFlow90d: "partial" };
    const base = gPay(), coins = base.coins as Record<string, unknown>[];
    const r = await colMb(ctxFor([gVal({ coins: [coins[0], { ...coins[1], valuation: pMint }, coins[2], { ...coins[3], pressureShiftScore: null, valuation: { ...(coins[3].valuation as object), baseline: "partial" } }], chains: [{ chainId: "ethereum", netFlow24hUsd: 150_000_000, valuation: "partial" }, { chainId: "arbitrum", netFlow24hUsd: -3_000_000, valuation: "complete" }] })]));
    expect(r.value?.topPressure).toEqual([]); expect(r.value?.topChains).toEqual([{ chainId: "arbitrum", netUsd: -3e6 }]);
    const withWh = (g: Record<string, unknown>) => colMb(ctxFor([gVal({ gauge: { ...(base.gauge as object), ...g } })]));
    const sm = await withWh({ partialValuationInputs: 3, partialValuationMcapUsd: 58e6, scoredMcapUsd: 300e9 });
    expect(sm.value).toMatchObject({ gaugeScore: G_SCORE, gaugeBand: "HEALTHY" }); expect(sm.qualityReasons).toContain("mint-burn-gauge-valuation-partial-band-stable");
    for (const wh of [await withWh({ partialValuationInputs: 1, partialValuationMcapUsd: 100e9, scoredMcapUsd: 100e9 }), await withWh({ partialValuationInputs: 1 })]) {
      expect(wh.value).toBeUndefined(); expect(wh.degradedReasons).toEqual([]); expect(wh.qualityReasons).toEqual(["mint-burn-gauge-valuation-partial"]);
    }
    for (const score of [-48, -19, -10, 20]) {
      const wh = await withWh({ score, partialValuationInputs: 1, partialValuationMcapUsd: 5, scoredMcapUsd: 100 });
      expect(wh.value).toBeUndefined(); expect(wh.qualityReasons).toEqual(["mint-burn-gauge-valuation-partial"]);
      const inp: DigestInputData = { ...BASE, topDepegs: [], dewsStress: undefined, mintBurnFlows: wh.value, degradedSources: [...wh.degradedReasons, ...(wh.qualityReasons ?? [])] };
      expect(regime(inp)).toBe("WATCHFUL"); expect(riskTape(inp).some((i) => i.id === "risk-tape:gauge")).toBe(false);
    }
    expect((await withWh({ score: -60, partialValuationInputs: 1, partialValuationMcapUsd: 1, scoredMcapUsd: 100 })).value?.gaugeScore).toBe(-60);
    const leg = await colMb(ctxFor([gVal({ gauge: { score: G_SCORE, band: "HEALTHY", flightToQuality: false, flightIntensity: 0 }, coins: coins.map(({ valuation: _v, ...c }) => c), chains: [{ chainId: "ethereum", netFlow24hUsd: 150_000_000 }] })]));
    expect(leg.value).toBeUndefined(); expect(leg.degradedReasons).toContain("mint-burn-gauge-malformed");
  });

  const activeRows = { usdc: { stablecoin_id: "usdc-circle", symbol: "USDC", direction: "below", peak_deviation_bps: -100, started_at: 0 }, usdt: { stablecoin_id: "usdt-tether", symbol: "USDT", direction: "below", peak_deviation_bps: -500, peak_price: 0.95, peg_reference: 1, started_at: 0 } };
  const track = (ctx: CollectorContext, a: ReturnType<typeof makeAsset>, mcap = 40e6) => { (ctx.trackedStablecoinIds as Set<string>).add(a.id); ctx.stablecoinAssetById.set(a.id, a); ctx.mcapById.set(a.id, mcap); };

  it.each([
    ["sorts and suppresses", [{ ...activeRows.usdc }, { stablecoin_id: "dai-makerdao", symbol: "DAI", direction: "above", peak_deviation_bps: 500, started_at: 0 }], { first: "USDC", suppressed: true }],
    ["keeps critical", [activeRows.usdt, { ...activeRows.usdc, peak_deviation_bps: -5200 }, { ...activeRows.usdc, stablecoin_id: "dai-makerdao", symbol: "DAI2", peak_deviation_bps: 150 }, { stablecoin_id: "dai-makerdao", symbol: "DAI", direction: "above", peak_deviation_bps: 500, started_at: 0 }], { count: 4, unsuppressed: true }],
    ["uses peak", [activeRows.usdc], { bps: -100 }],
    ["filters frozen", [{ ...activeRows.usdc, stablecoin_id: "usr-resolv", symbol: "USR", peak_deviation_bps: -9025 }, activeRows.usdc], { count: 1 }],
    ["uses stale peak", [{ ...activeRows.usdc, peak_deviation_bps: -3000, peak_price: 0.7, peg_reference: 1 }], { bps: -3000, basis: "peak-fallback" }],
  ] as const)("%s", async (_l, rows, exp) => {
    const ctx = ctxFor(depegTbl(rows.map((r) => ({ ...r, started_at: nowS() - 3600 }))));
    if ("basis" in exp) ctx.stablecoinsCacheIsFresh = false;
    if ("unsuppressed" in exp && exp.unsuppressed) ctx.stablecoinAssetById.set("usdc-circle", { ...ctx.stablecoinAssetById.get("usdc-circle")!, price: 0.48 });
    const r = await colDepegs(ctx);
    if ("first" in exp) expect(r.value.topDepegs[0].symbol).toBe(exp.first);
    if ("suppressed" in exp && exp.suppressed) expect(r.value.topDepegs[1].suppressReason).toContain("sub-$20M");
    if ("count" in exp) expect(r.value.topDepegs).toHaveLength(exp.count);
    if ("unsuppressed" in exp && exp.unsuppressed) expect(r.value.topDepegs[0].suppressReason).toBeUndefined();
    if ("bps" in exp) expect(r.value.topDepegs[0].bps).toBe(exp.bps);
    if ("basis" in exp) expect(r.value.topDepegs[0].severityBasis).toBe(exp.basis);
  });

  it("tracks a monitored variant without putting it in core aggregates", async () => {
    const ctx = ctxFor(depegTbl([{ stablecoin_id: "susds-sky", symbol: "sUSDS", direction: "below", peak_deviation_bps: -125, started_at: 0 }])), v = makeAsset({ id: "susds-sky", symbol: "sUSDS", circulating: { peggedUSD: 1e9 } });
    ctx.trackedStablecoinAssets.push(v); track(ctx, v, 1e9);
    const r = await colDepegs(ctx); expect(ctx.coreAggregateStablecoinIds.has(v.id)).toBe(false);
    expect(r.value.topDepegs[0]).toMatchObject({ stablecoinId: "susds-sky", symbol: "sUSDS" });
  });

  it.each(["unknown", "publish-clock"] as const)("keeps the stored USD peak for an %s quote", async (mode) => {
    const ctx = ctxFor(depegTbl([activeRows.usdc])), a = ctx.stablecoinAssetById.get("usdc-circle")!;
    a.priceObservedAtMode = mode === "unknown" ? "unknown" : "upstream"; a.priceUpdatedAt = ctx.nowSec;
    if (mode === "publish-clock") a.priceObservedAt = null;
    const { value } = await colDepegs(ctx);
    expect(value.topDepegs[0]).toMatchObject({ severityBasis: "peak-fallback", peakBps: activeRows.usdc.peak_deviation_bps });
    expect(value.topDepegs[0]).not.toHaveProperty("priceObservedAt");
  });

  it("ranks a fresh fixed-USD composite on its current deviation", async () => {
    const ctx = ctxFor(depegTbl([activeRows.usdt])), qAt = ctx.nowSec - 45, a = ctx.stablecoinAssetById.get("usdt-tether")!;
    Object.assign(a, { price: 0.98, priceSource: "kraken+pyth+redstone", priceConfidence: "high", priceSelectedSource: "pyth", priceObservedAtMode: "local_fetch", priceObservedAt: qAt });
    expect((await colDepegs(ctx)).value.topDepegs[0]).toMatchObject({ severityBasis: "current", currentBps: -200, peakBps: -500, priceObservedAt: qAt });
    a.priceObservedAt = ctx.nowSec - 3600; expect((await colDepegs(ctx)).value.topDepegs[0].severityBasis).toBe("peak-fallback");
    a.priceObservedAt = qAt; ctx.currentPegObservationById = new Map([[a.id, pegObs(1, { admittedDeviationBps: null })]]);
    expect((await colDepegs(ctx)).value.topDepegs[0].severityBasis).toBe("peak-fallback");
  });

  const schedObs = (v: number, bps: number | null, obsAt: number, kind: "fx" | "fallback" = "fallback", decAt = obsAt) => {
    const refAt = bps == null ? obsAt - 43 * 3_600 : obsAt;
    const clocks = { kind, source: kind === "fx" ? "openExchangeRates" : "gold-api.com", cadence: "intraday", referenceObservedAtSec: refAt, quoteObservedAtSec: obsAt, decisionAtSec: decAt, budgetSec: 21_600, sessionOpenedAtSec: bps == null ? null : obsAt - 3_600, generation: "digest-fixture", policyVersion: 1 } as const;
    return pegObs(v, { pegReference: { valueUsd: v, source: kind, contributorCount: 1, asOf: refAt }, admittedDeviationBps: bps, referenceAdmission: bps == null ? { ...clocks, status: "held-closed-session", reason: "reference-market-closed" } : { ...clocks, status: "admitted", reason: "live-reference" } });
  };

  it("measures a USD-quoted gold event against the current reference, not the latched one", async () => {
    const now = nowS(), ctx = ctxFor(depegTbl([{ stablecoin_id: "xaum-matrixdock", symbol: "XAUM", peg_type: "peggedGOLD", source: "live", direction: "above", peak_deviation_bps: 1660, started_at: now - 10 * 86_400, peg_reference: 4051 }]));
    const a = makeAsset({ id: "xaum-matrixdock", symbol: "XAUM", pegType: "peggedGOLD", price: 3902, priceObservedAt: now });
    track(ctx, a); ctx.currentPegObservationById = new Map([[a.id, schedObs(3902, 0, now)]]);
    const r = await colDepegs(ctx);
    expect(r.value.topDepegs[0]).toMatchObject({ severityBasis: "current", currentBps: 0, pegReference: 3902, currentPriceUsd: 3902, bps: 1660 });
    expect(r.value.lifecycleFlags).toEqual([]);
  });

  it("flags a month-old premium against the current reference as chronic-shallow", async () => {
    const now = nowS(), ctx = ctxFor(depegTbl([{ stablecoin_id: "xagm-matrixdock", symbol: "XAGM", peg_type: "peggedSILVER", source: "live", direction: "above", peak_deviation_bps: 2043, started_at: now - 41 * 86_400, peg_reference: 38.22 }]));
    const a = makeAsset({ id: "xagm-matrixdock", symbol: "XAGM", pegType: "peggedSILVER", price: 30.411, priceObservedAt: now });
    track(ctx, a, 100e6); ctx.currentPegObservationById = new Map([[a.id, schedObs(30, 137, now)]]);
    const r = await colDepegs(ctx);
    expect(r.value.topDepegs[0]).toMatchObject({ currentBps: 137, severityBasis: "current", pegReference: 30, pegReferenceBasis: "current", currentPriceUsd: 30.411 });
    expect(r.value.lifecycleFlags).toEqual([expect.objectContaining({ stablecoinId: "xagm-matrixdock", kind: "chronic-shallow", currentBps: 137, ageDays: 41 })]);
  });

  it.each(["missing", "withheld"] as const)("never falls back to the latched reference when the current reference is %s", async (state) => {
    const now = nowS(), ctx = ctxFor(depegTbl([{ stablecoin_id: "xaum-matrixdock", symbol: "XAUM", peg_type: "peggedGOLD", source: "live", direction: "below", peak_deviation_bps: -5000, started_at: now - 41 * 86_400, peg_reference: 5000 }]));
    const a = makeAsset({ id: "xaum-matrixdock", symbol: "XAUM", pegType: "peggedGOLD", price: 1000, priceObservedAt: now });
    track(ctx, a); ctx.currentPegObservationById = state === "withheld" ? new Map([[a.id, pegObs(null, { pegReferenceUnavailable: true })]]) : new Map();
    const r = await colDepegs(ctx), top = r.value.topDepegs[0];
    expect(top).toMatchObject({ severityBasis: "peak-fallback", bps: -5000 });
    expect([top.currentBps, top.pegReference, top.currentPriceUsd, top.priceObservedAt]).toEqual([undefined, undefined, undefined, undefined]);
    expect(r.qualityReasons).toEqual(["active-depeg-reference-unavailable"]); expect(r.value.lifecycleFlags).toEqual([]);
    const p = prompt({ ...BASE, topDepegs: r.value.topDepegs }); expect(p).toContain("(stored peak; live price unavailable)"); expect(p).not.toContain("current $");
  });

  it("holds a weekend metal deviation instead of ranking it as current", async () => {
    const now = Date.parse("2026-11-13T22:01:00Z") / 1_000, qAt = now - 120;
    const ctx = ctxFor(depegTbl([{ stablecoin_id: "paxg-paxos", symbol: "PAXG", peg_type: "peggedGOLD", source: "live", direction: "below", peak_deviation_bps: -600, started_at: now - 10 * 86_400, peg_reference: 4000 }]));
    ctx.nowSec = now;
    const a = Object.assign(makeAsset({ id: "paxg-paxos", symbol: "PAXG", pegType: "peggedGOLD", price: 3900, priceObservedAt: qAt }), { currentPeg: schedObs(4000, -250, qAt) });
    track(ctx, a); ctx.currentPegObservationById = new Map([[a.id, schedObs(4000, null, qAt, "fallback", now)]]);
    const { value, qualityReasons } = await colDepegs(ctx);
    expect(value.topDepegs[0]).toMatchObject({ severityBasis: "peak-fallback", bps: -600 }); expect(value.topDepegs[0].currentBps).toBeUndefined();
    expect(qualityReasons).toEqual(["active-depeg-reference-market-closed"]);
  });

  it.each([["upstream", "pyth", "current"], ["legacy", "pyth", "current"], ["legacy", "binance", "peak-fallback"]] as const)("reads the %s USD quote clock from %s", async (clock, src, basis) => {
    const ctx = ctxFor(depegTbl([{ ...activeRows.usdc, peak_deviation_bps: -1000, peg_reference: 1 }])), a = ctx.stablecoinAssetById.get("usdc-circle")!;
    a.price = 0.98; a.priceSource = src; a.priceUpdatedAt = ctx.nowSec - 60;
    if (clock === "legacy") { const l: Partial<typeof a> = a; delete l.priceObservedAt; delete l.priceObservedAtMode; } else a.priceObservedAt = a.priceUpdatedAt;
    const { value } = await colDepegs(ctx);
    expect(value.topDepegs[0]).toMatchObject({ severityBasis: basis, peakBps: -1000 });
    expect(value.topDepegs[0].currentBps).toBe(basis === "current" ? -200 : undefined);
    expect(value.topDepegs[0].priceObservedAt).toBe(basis === "current" ? a.priceUpdatedAt : undefined);
  });

  it("keeps a native-quote event on the event-native reference", async () => {
    const now = nowS(), ctx = ctxFor(depegTbl([{ stablecoin_id: "eurc-circle", symbol: "EURC", peg_type: "peggedEUR", source: "live", quote_mode: "native-peg", direction: "below", peak_deviation_bps: -800, started_at: now - 3 * 86_400, peg_reference: 1, current_native_quote: js({ value: 0.92, observedAt: now - 60, source: "coingecko", derivation: { kind: "traded-pair", lineage: { venue: "bitstamp", pair: "EURC/EUR" } } }) }]));
    ctx.trackedStablecoinIds = new Set([...ctx.trackedStablecoinIds, "eurc-circle"]); ctx.mcapById.set("eurc-circle", 250e6);
    ctx.currentPegObservationById = new Map([["eurc-circle", pegObs(1.1)]]);
    expect((await colDepegs(ctx)).value.topDepegs[0]).toMatchObject({ quoteMode: "native-peg", currentBps: -800, pegReference: 1, severityBasis: "current" });
  });

  it.each([
    ["persisted native", "live", "native-peg", "fresh", false, 1], ["inferred live native", "live", null, "fresh", false, 1],
    ["historical native provenance", "backfill", "native-peg", "fresh", false, 1], ["native start observation", "live", "native-peg", "missing", true, 1],
    ["missing native", "live", "native-peg", "missing", false, 1], ["expired native", "live", "native-peg", "expired", false, 1],
    ["future native", "live", "native-peg", "future", false, 1], ["malformed native", "live", "native-peg", "malformed", false, 1],
    ["legacy USD reference", "backfill", null, "fresh", false, 1.1], ["explicit USD provenance", "live", "usd", "fresh", false, 1],
  ] as const)("keeps %s event facts and clocks in their quote domain", async (_l, src, qm, qs, rec, pegRef) => {
    const { db, sqlite } = nqFx.open(), now = nowS(), st = now - (rec ? 60 : 86400);
    sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source) VALUES (101, 'eurc-circle', 'EURC', 'peggedEUR', 'below', -500, ?, 0.98, 0.95, ?, ?)").run(st, pegRef, src);
    if (qm != null) sqlite.prepare("INSERT INTO depeg_event_provenance (event_id, source_kind, quote_mode, created_at, updated_at) VALUES (101, ?, ?, ?, ?)").run(src, qm, now, now);
    const qAt = qs === "expired" ? now - NATIVE_MAX : qs === "future" ? now + 60 : now - 30;
    if (qs !== "missing") sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(`${NATIVE_PFX}101`, qs === "malformed" ? "{invalid" : js({ value: 0.98, observedAt: qAt, source: "coingecko", derivation: { kind: "traded-pair", lineage: { venue: "bitstamp", pair: "EURC/EUR" } } }), qAt);
    const ctx = mkCtx(db), a = makeAsset({ id: "eurc-circle", symbol: "EURC", pegType: "peggedEUR", price: 1.1, priceObservedAt: now }), nat = qm === "native-peg" || (qm == null && src === "live");
    track(ctx, a, 100e6);
    ctx.currentPegObservationById = new Map([[a.id, nat ? pegObs(null) : schedObs(pegRef, pegRef === 1 ? 1000 : 0, now, "fx")]]);
    const r = await colDepegs(ctx), fact = r.value.topDepegs[0];
    expect(r.degradedReasons).toEqual([]); expect(r.value.activeDepegCount).toBe(1);
    if (!nat) { expect(fact).toMatchObject({ quoteMode: "usd", currentPriceUsd: 1.1, currentBps: pegRef === 1 ? 1000 : 0, priceObservedAt: now, severityBasis: "current" }); expect(fact.currentPriceNative).toBeUndefined(); }
    else {
      expect(fact).toMatchObject({ quoteMode: "native-peg", peakPriceNative: 0.95 }); expect([fact.currentPriceUsd, fact.peakPriceUsd]).toEqual([undefined, undefined]);
      if (qs === "fresh" || rec) expect(fact).toMatchObject({ currentPriceNative: 0.98, currentBps: -200, priceObservedAt: rec ? st : qAt, severityBasis: "current" });
      else { expect(fact).toMatchObject({ bps: -500, severityBasis: "peak-fallback" }); expect([fact.currentBps, fact.currentPriceNative, fact.priceObservedAt]).toEqual([undefined, undefined, undefined]); }
    }
  });

  it("uses the legacy weekly bucket and daily USD snapshots until native evidence exists", async () => {
    const now = ctxFor([]).todayTs, rows = [[0, 101.4e9], [1, 101.35e9], [7, 100e9]].map(([d, u]) => ({ stablecoin_id: "usdt-tether", snapshot_date: now - d * 86_400, circulating_usd: u, circulating_native: null }));
    const r = await colMovers(ctxFor([{ match: "FROM supply_history WHERE stablecoin_id IN", rows }]));
    expect(r.degradedReasons).toEqual([]); expect(r.value.biggestSupplyChange).toMatchObject({ symbol: "USDT", changeUsd: 5e9 });
    expect(r.value.biggestSupplyChange?.quantityEvidence).toBeUndefined();
    expect(r.value.supplyVelocity).toEqual([{ stablecoinId: "usdt-tether", coin: "USDT", change1d: 50e6, change7d: 1.4e9, signal: "decelerating" }]);
    const nh = ctxFor([{ match: "FROM supply_history WHERE stablecoin_id IN", rows: [] }]);
    nh.coreAggregateStablecoinAssets = nh.coreAggregateStablecoinAssets.map((c) => ({ ...c, circulatingPrevWeek: {} }));
    expect((await colMovers(nh)).degradedReasons).toEqual(["supply-movers-unavailable"]);
  });

  it("withholds supply movers and velocity when today's native quantity is explicitly unavailable", async () => {
    const today = ctxFor([]).todayTs, rows = [[0, 110e6], [1, 101e6], [7, 100e6]].map(([d, u]) => { const dt = today - d * 86_400; return { stablecoin_id: "usdt-tether", snapshot_date: dt, circulating_usd: u, circulating_native: d === 0 ? null : 100e6, valuation_price_usd: d === 0 ? null : u / 100e6, valuation_observed_at_sec: d === 0 ? null : dt, supply_provenance: js({ supplySource: "defillama", supplyObservedAt: dt, supplyChainGuard: null, ...(d === 0 ? { nativeQuantityUnavailable: true, marketQuote: { price: 1.1, observedAt: dt } } : {}) }) }; });
    const ctx = ctxFor([{ match: "FROM supply_history WHERE stablecoin_id IN", rows }]);
    ctx.coreAggregateStablecoinAssets = [makeAsset({ id: "usdt-tether", symbol: "USDT", price: 1.1, circulating: { peggedUSD: 110e6 }, circulatingPrevWeek: { peggedUSD: 100e6 } })];
    const r = await colMovers(ctx);
    expect(r.value).toStrictEqual({ biggestSupplyChange: null, supplyChanges7d: [] }); expect(r.degradedReasons).toEqual(["supply-movers-unavailable"]);
  });

  it("uses the paired pre-midnight valuation for weekly supply and daily velocity", async () => {
    const today = ctxFor([]).todayTs, rows = [[0, 110e9], [1, 101e9], [7, 100e9]].map(([d, q]) => { const dt = today - d * 86_400, at = dt + (d === 0 ? -15 : 10); return { stablecoin_id: "usdt-tether", snapshot_date: dt, circulating_native: q, valuation_price_usd: 1, valuation_observed_at_sec: at, supply_provenance: js({ supplySource: "coingecko-fallback", supplyObservedAt: at, supplyChainGuard: null }) }; });
    const ctx = ctxFor([{ match: "FROM supply_history WHERE stablecoin_id IN", rows }]);
    ctx.coreAggregateStablecoinAssets = ctx.coreAggregateStablecoinAssets.filter(({ id }) => id === "usdt-tether");
    const { value } = await colMovers(ctx);
    expect(value.biggestSupplyChange).toMatchObject({ id: "usdt-tether", changeUsd: 10e9, quantityEvidence: { valuationObservedAt: today - 15 } });
    expect(value.supplyVelocity).toMatchObject([{ change1d: 9e9, change7d: 10e9, signal: "accelerating" }]);
    rows[0].valuation_observed_at_sec = today - 3600;
    expect((await colMovers(ctx)).value.biggestSupplyChange).toBeNull();
  });

  it("covers velocity and silent collector failures", async () => {
    const now = ctxFor([]).todayTs, rows = [[0, 101.4e9], [1, 101.35e9], [7, 100e9]].map(([d, q]) => ({ stablecoin_id: "usdt-tether", snapshot_date: now - d * 86_400, circulating_native: q, supply_provenance: js({ supplySource: "defillama", supplyObservedAt: now - d * 86_400, supplyChainGuard: null }), valuation_price_usd: 1, valuation_observed_at_sec: now }));
    expect((await colMovers(ctxFor([{ match: "FROM supply_history WHERE stablecoin_id IN", rows }]))).value.supplyVelocity).toEqual([expect.objectContaining({ coin: "USDT", signal: "decelerating", quantityEvidence: expect.objectContaining({ basis: "native-quantity" }) })]);
    expect((await colResDepegs(ctxFor([{ match: "depeg_events", rows: [], throwError: new Error("boom") }]))).degradedReasons).toContain("resolved-depegs-query");
    expect((await colLiq(ctxFor([{ match: "dex_liquidity", rows: [], throwError: new Error("boom") }]))).degradedReasons).toContain("liquidity-shifts-query");
  });

  it("collects PSI contributors across empty, stale, malformed, and query-failure boundaries", async () => {
    const q = "SELECT input_snapshot, stored_at FROM stability_index_samples", contribs = [{ id: "usdt-tether", symbol: "USDT", bps: 10, mcapUsd: 100e9, ageDays: 1, factor: 1.5 }, { id: "usdc-circle", symbol: "USDC", bps: 20, mcapUsd: 50e9, ageDays: 2, factor: 1.2 }, { id: "frax-finance", symbol: "FRAX", bps: 30, mcapUsd: 1e9, ageDays: 3, factor: 2 }];
    const good = await colPsi(ctxFor([{ match: q, first: { stored_at: nowS() - 600, input_snapshot: js({ contributors: contribs }) }, rows: [] }]));
    expect(good.value).toHaveLength(3); expect(good.value![0].symbol).toBe("USDT");
    for (const fv of [null, { stored_at: nowS() - 600, input_snapshot: js({ contributors: [] }) }]) expect((await colPsi(ctxFor([{ match: q, first: fv, rows: [] }]))).value).toBeUndefined();
    expect((await colPsi(ctxFor([{ match: q, first: { stored_at: nowS() - 3 * 3600, input_snapshot: js({ contributors: contribs }) }, rows: [] }]))).degradedReasons).toContain("psi-contributors-stale");
    expect((await colPsi(ctxFor([{ match: q, rows: [], throwError: new Error("down") }]))).degradedReasons).toContain("psi-contributors-query");
  });

  it("ranks finite signed PSI contributors by absolute impact without a 10000-bps ceiling", async () => {
    const contribs = [{ symbol: "NEG", bps: -200, mcapUsd: 100e9, factor: 1 }, { symbol: "ABOVE", bps: 15000, mcapUsd: 1e9, factor: 1 }, { symbol: "POS", bps: 100, mcapUsd: 20e9, factor: 1 }, { symbol: "SMALL", bps: -20, mcapUsd: 1e9, factor: 1 }, ...[{ bps: "nonfinite" }, { bps: null }, { bps: "200" }, { mcapUsd: "nonfinite" }, { factor: "nonfinite" }, { factor: -1 }, { mcapUsd: 0 }].map((inv) => ({ symbol: "INVALID", bps: 50000, mcapUsd: 100e9, factor: 1, ...inv }))];
    const r = await colPsi(ctxFor([{ match: "SELECT input_snapshot, stored_at FROM stability_index_samples", rows: [], first: { stored_at: nowS() - 600, input_snapshot: js({ contributors: contribs }).replaceAll('"nonfinite"', "1e999") } }]));
    expect(r.degradedReasons).toEqual([]);
    expect(r.value).toEqual([{ symbol: "NEG", bps: -200, mcapUsd: 100e9, marketImpact: 20000 }, { symbol: "ABOVE", bps: 15000, mcapUsd: 1e9, marketImpact: 15000 }, { symbol: "POS", bps: 100, mcapUsd: 20e9, marketImpact: 2000 }]);
  });

  it("filters yield anomalies and caps the result", async () => {
    const rows = ["USDT", "USDC", "DAI"].map((s, i) => ({ stablecoin_id: s === "USDT" ? "usdt-tether" : s === "USDC" ? "usdc-circle" : "dai-makerdao", symbol: s, current_apy: 8 + i, apy_7d: 4, apy_30d: 3, warning_signals: js(i === 2 ? [] : ["spike"]) }));
    expect((await colYield(ctxFor([{ match: "FROM yield_data", rows }]))).value?.map(({ symbol }) => symbol)).toEqual(["USDT", "USDC"]);
    const many = Array.from({ length: 8 }, (_, i) => ({ stablecoin_id: `coin-${i}`, symbol: `C${i}`, current_apy: 10, apy_7d: 5, apy_30d: 4, warning_signals: '["spike"]' })), ctx = ctxFor([{ match: "FROM yield_data", rows: many }]);
    for (let i = 0; i < 8; i++) ctx.mcapById.set(`coin-${i}`, 20e9);
    expect((await colYield(ctx)).value).toHaveLength(5);
    expect((await colYield(ctxFor([{ match: "FROM yield_data", rows: [{ ...rows[0], warning_signals: "[]" }] }]))).value).toBeUndefined();
  });

  it("drops operational advisories before the yield anomaly top-N cut", async () => {
    const aged = Array.from({ length: 6 }, (_, i) => ({ stablecoin_id: `aged-${i}`, symbol: `A${i}`, current_apy: 10, apy_7d: 5, apy_30d: 4, warning_signals: '["aging","data-stale"]' }));
    const real = { stablecoin_id: "real-0", symbol: "REAL", current_apy: 10, apy_7d: 5, apy_30d: 4, warning_signals: '["aging","yield-spike"]' };
    const ctx = ctxFor([{ match: "FROM yield_data", rows: [...aged, real] }]);
    for (const r of [...aged, real]) ctx.mcapById.set(r.stablecoin_id, r === real ? 1e9 : 90e9);
    const res = (await colYield(ctx)).value;
    expect(res?.map(({ symbol }) => symbol)).toEqual(["REAL"]); expect(res?.[0].warnings).toEqual(["yield-spike"]);
  });

  const cov = { coverage_class: "primary", coverage_confidence: 0.9, methodology_version: "6.1" };
  const liqPair = (c: number, p: number, ct = 500e6, pt = 480e6, ex = {}) => [{ stablecoin_id: "usdt-tether", liquidity_score: c, total_tvl_usd: ct, snapshot_date: 1_772_755_200, ...cov, ...ex }, { stablecoin_id: "usdt-tether", liquidity_score: p, total_tvl_usd: pt, snapshot_date: 1_772_668_800, ...cov }];

  it("skips malformed newest coverage before choosing the digest pair", async () => {
    const pair = liqPair(85, 75), r = await colLiq(ctxFor([{ match: "FROM dex_liquidity_history", rows: [{ ...pair[0], snapshot_date: pair[0].snapshot_date + 1, coverage_confidence: 1.1 }, ...pair] }]));
    expect(r.value).toHaveLength(1); expect(r.degradedReasons).toContain("liquidity-invalid-coverage-evidence");
  });

  it.each([
    ["material", liqPair(85, 75), 0.0417, []], ["threshold", liqPair(80, 78), undefined, []], ["collapse", liqPair(75, 85, 13.72e6, 152e6), -0.9097, []],
    ["methodology", liqPair(71, 85, 480e6, 500e6, { methodology_version: "6.0" }).map((r, i) => i ? { ...r, methodology_version: "5.91" } : r), undefined, ["liquidity-shift-methodology-basis-change"]],
    ["fallback", liqPair(75, 85, 400e6, 500e6, { coverage_class: "fallback", coverage_confidence: 0.5 }), undefined, ["liquidity-shift-non-trendworthy-coverage"]],
  ] as const)("handles %s liquidity pair", async (_l, rows, ch, wh) => {
    const r = await colLiq(ctxFor([{ match: "FROM dex_liquidity_history", rows }]));
    if (ch == null) expect(r.value).toBeUndefined(); else expect(r.value?.[0].tvlChangePct).toBeCloseTo(ch, 4);
    expect(r.degradedReasons).toEqual([]); expect(r.qualityReasons ?? []).toEqual(wh);
  });

  it("withholds monetary candidates for absent supply without erasing observed incident counts", async () => {
    const aCtx = ctxFor(depegTbl([activeRows.usdc])); aCtx.mcapById.delete("usdc-circle");
    const act = await colDepegs(aCtx); expect(act.value).toMatchObject({ activeDepegCount: 1, topDepegs: [] }); expect(act.qualityReasons).toContain("active-depeg-supply-unavailable");
    const rCtx = ctxFor([{ match: "FROM depeg_events", rows: [{ ...activeRows.usdc, ended_at: aCtx.nowSec, close_reason: "recovered-primary", recovery_price: 1 }] }]); rCtx.mcapById.delete("usdc-circle");
    const rec = await colResDepegs(rCtx); expect(rec.value).toMatchObject({ resolvedDepegCount: 1, resolvedDepegs: undefined }); expect(rec.qualityReasons).toContain("resolved-depeg-supply-unavailable");
    const lCtx = ctxFor([{ match: "FROM dex_liquidity_history", rows: liqPair(85, 75) }]); lCtx.mcapById.delete("usdt-tether");
    const liq = await colLiq(lCtx); expect(liq.value).toBeUndefined(); expect(liq.qualityReasons).toContain("liquidity-shift-supply-unavailable");
  });
});

describe("history and DEWS collectors", () => {
  it("builds cross-day trajectories and covers null and insufficient history", async () => {
    vi.setSystemTime(1794614400 * 1000);
    const now = nowS();
    const col = (rows: ReturnType<typeof mkRow>[]) => colTrends(ctxFor([{ match: "FROM daily_digest", rows: rows.map((r) => ({ ...r, input_data: r.input_data.replace("{", '{"supplyCoverage":{"complete":true},') })) }]));
    const rows = (n: number, g: number, off = 0) => Array.from({ length: n }, (_, i) => mkRow(now, i + off, 92 - i, i < 2 ? "BEDROCK" : "STEADY", (200 - i) * 1e9, i < g ? -5 + i * 2 : undefined));
    const full = await col(rows(5, 3)), pt = full.value?.psiTrajectory ?? [];
    expect(pt[0]).toMatchObject({ score: 88 }); expect(pt[pt.length - 1]).toMatchObject({ score: 92 });
    expect(full.value?.gaugeTrajectory).toEqual(expect.any(Array)); expect(full.value?.mcapTrajectory).toHaveLength(1);
    expect((await col(rows(4, 1))).value?.gaugeTrajectory).toBeNull();
    expect((await col(rows(2, 0, 1))).value).toBeUndefined();
  });

  it("collects comparable historical PSI and supply records", async () => {
    const today = 1795392000, day = 86400, { db, sqlite } = nqFx.open();
    for (let i = 0; i < 31; i++) sqlite.prepare("INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (?, 91.2, ?, '{}', '{}')").run(today - i * day, i < 3 ? "BEDROCK" : "STEADY");
    for (const [d, c] of [[today - 30 * day, 2699e6], [today - day, 2269e6]]) sqlite.prepare("INSERT INTO daily_digest (generated_at, digest_text, input_data) VALUES (?, '', ?)").run(d, js({ aggregateUniverse: "core-stablecoins-v1", supplyCoverage: { complete: true }, totalMcapUsd: c, ...(c > 2500e6 ? { stabilityIndex: { score: 89, band: "STEADY" } } : {}) }));
    for (const [d, c] of [[1794009600, 697750000], [1794528000, 268e6], [1794614400, 268217409], [1794700800, 268217409], [today - day, 269217409]]) sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES ('gho-aave', ?, ?)").run(d, c);
    const ctx = { ...mkCtx(db), todayTs: today, nowSec: today + 8 * 3600 };
    expect((await colHist(ctx, 91.2, "BEDROCK", today, { id: "gho-aave", symbol: "GHO", name: "GHO", changeUsd: 1e6, currentMcap: 269217409 })).value).toMatchObject({ psiBandStreak: 3, psiPrecedent: { lastSeenDaysAgo: 30 }, supplyMoverContext: { allTimeHighMcap: 269217409, largestWeeklyChange: 1e6 } });
    expect((await colAth(ctx)).value?.value).toBe(2269e6);
  });

  it.each([
    { name: "missing yesterday", days: [0, 2], ch: false, off: 0, exp: 1 },
    { name: "changed yesterday band", days: [0, 1, 2], ch: true, off: 0, exp: 1 },
    { name: "uninterrupted days", days: [0, 1, 2], ch: false, off: 0, exp: 3 },
    { name: "daily fallback observation", days: [0, 1, 2], ch: false, off: 1, exp: 3 },
  ])("uses canonical calendar PSI streaks for $name", async ({ days, ch, off, exp }) => {
    const today = 1_772_755_200, compAt = today - off * 86_400 + (off === 0 ? 8 * 3600 : 0), obsDay = today - off * 86_400;
    const hist = days.map((da) => ({ date: obsDay - da * 86_400, score: 91.2, band: ch && da === 1 ? "STEADY" : "BEDROCK" }));
    const ctx = ctxFor([first("SELECT COUNT(*) as cnt FROM stability_index", { cnt: 90 }), first("SELECT MIN(generated_at) as oldest FROM daily_digest", null), first("FROM daily_digest\n           WHERE json_extract(input_data", null), { match: "ORDER BY computed_at DESC LIMIT 90", rows: hist }]);
    ctx.todayTs = today;
    const r = await colHist(ctx, 91.2, "BEDROCK", compAt, null);
    expect(r.degradedReasons).toEqual([]); expect(r.value?.psiBandStreak).toBe(exp); expect(r.value?.psiBandStreak).toBe(getPsiBandStreak(hist, compAt, "BEDROCK"));
  });

  it("accepts flat and wrapped DEWS signals, records malformed input, and rejects partial publication", async () => {
    const at = nowS() - 600, sigs = { supply: { value: 30, available: true }, pool: { value: 80, available: true }, liq: { value: 45, available: true }, price: { value: 10, available: true } };
    const run = (sj: string, hist: Record<string, unknown>[] = []) => colDews(ctxFor([...dewsTbl([{ stablecoin_id: "usdt-tether", score: 65, band: "ALERT", signals_json: sj, computed_at: at }]), { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: hist }]));
    const flat = await run(js(sigs), [{ stablecoin_id: "usdt-tether", score: 25, band: "WATCH" }]), wrap = await run(js({ signals: sigs, amplifiers: { psi: 1, contagion: 1 } }));
    expect(flat.value?.elevatedCoins[0].topSignals?.[0].name).toBe("pool balance drift"); expect(wrap.value?.elevatedCoins[0].topSignals).toEqual(flat.value?.elevatedCoins[0].topSignals);
    expect((await run('{"pool":', [{ stablecoin_id: "usdt-tether", score: 25, band: "WATCH" }])).degradedReasons).toContain("dews-stress-signals-json");
    expect((await run("{}")).value?.elevatedCoins[0].topSignals).toEqual([]);
    const rows = ["usdt-tether", "usdc-circle"].map((id) => ({ stablecoin_id: id, score: 65, band: "ALERT", signals_json: "{}", computed_at: at }));
    const tbls = dewsTbl(rows); tbls[1] = { ...tbls[1], rows: [rows[0]] };
    const part = await colDews(ctxFor(tbls)); expect(part.value).toBeUndefined(); expect(part.degradedReasons).toContain("dews-published-generation");
  });

  it("withholds an accepted DEWS generation past the shared consumer budget", async () => {
    const at = nowS() - 26 * 3600, rows = ["usdt-tether", "usdc-circle"].map((id) => ({ stablecoin_id: id, score: 12, band: "CALM", signals_json: "{}", computed_at: at }));
    const r = await colDews(ctxFor(dewsTbl(rows)));
    expect(r.value).toBeUndefined(); expect(r.degradedReasons).toContain("dews-published-generation");
    expect(regime({ ...BASE, activeDepegCount: 0, topDepegs: [], stabilityIndex: { score: 95, band: "BEDROCK", components: { severity: 0, breadth: 0, trend: 0 } }, dewsStress: r.value, degradedSources: r.degradedReasons })).toBe("WATCHFUL");
  });

  it.each([false, true])("keeps the full DEWS census independent of five displayed coins (missing supply: %s)", async (miss) => {
    const at = nowS() - 600, assets = Array.from({ length: 9 }, (_, i) => makeAsset({ id: `coin-${i}`, symbol: `C${i}`, circulating: i === 8 ? (miss ? {} : { peggedUSD: 0 }) : { peggedUSD: i === 7 ? 5e6 : 20e6 } }));
    const rows = assets.map((a) => ({ stablecoin_id: a.id, score: 65, band: "ALERT", signals_json: "{}", computed_at: at }));
    const ctx = ctxFor([...dewsTbl(rows), { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: rows.map((r) => ({ ...r, band: "WATCH", score: 25 })) }]);
    setDewsAssets(ctx, assets);
    const ds = (await colDews(ctx)).value!;
    expect(ds).toMatchObject({ bandCounts: { alert: 9 }, alertPlusMcapUsd: 145e6, bandChangeCount: 9, alertPlusSupplyCoverage: { complete: !miss, observedCount: miss ? 8 : 9, unavailableCount: miss ? 1 : 0 } });
    expect(ds.elevatedCoins).toHaveLength(5); expect(ds.bandChanges).toHaveLength(5);
    for (const lim of [0, 1, 5]) {
      const inp: DigestInputData = { ...BASE, activeDepegCount: 0, topDepegs: [], dewsStress: { ...ds, elevatedCoins: ds.elevatedCoins.slice(0, lim), bandChanges: ds.bandChanges.slice(0, lim) } };
      expect(regime(inp)).toBe("TENSION");
      expect(riskTape(inp).find((i) => i.id === "risk-tape:dews")?.detail).toContain("9 band changes");
      const p = prompt(inp); expect(p).toContain("Full band-change count (last 24h): 9");
      expect(p).toContain(miss ? "ALERT+ known supply subtotal: $145.00M" : "ALERT+ supply: $145.00M");
      const br = buildCands(inp, null).find((c) => c.id === "dews:alert-plus-breadth");
      expect(br?.impactScore).toBe(0.1);
      expect(br?.headlineFacts).toContain(miss ? "$145.00M ALERT+ known supply subtotal (incomplete coverage)" : "$145.00M ALERT+ market cap");
    }
  });

  it("excludes only outage-fallback carries from the DEWS ALERT+ observed census", async () => {
    const at = nowS() - 600, assets = [makeAsset({ id: "coin-0", symbol: "C0", circulating: { peggedUSD: 20e6 } }), makeAsset({ id: "coin-1", symbol: "C1", circulating: { peggedUSD: 30e6 }, supplyRestored: true }), makeAsset({ id: "coin-2", symbol: "C2", circulating: { peggedUSD: 40e6 }, supplyRestored: true, supplyRestoreMode: "outage-fallback" })];
    const ctx = ctxFor([...dewsTbl(assets.map((a) => ({ stablecoin_id: a.id, score: 65, band: "ALERT", signals_json: "{}", computed_at: at }))), { match: "FROM stress_signal_history WHERE snapshot_date = ?", rows: [] }]);
    setDewsAssets(ctx, assets);
    const ds = (await colDews(ctx)).value!;
    expect(ds).toMatchObject({ alertPlusMcapUsd: 50e6, alertPlusSupplyCoverage: { complete: false, observedCount: 2, unavailableCount: 0, carriedCount: 1, carriedIds: ["coin-2"] } });
    expect(prompt({ ...BASE, activeDepegCount: 0, topDepegs: [], dewsStress: ds })).toContain("ALERT+ known supply subtotal: $50.00M");
  });
});

const openDbs: DatabaseSync[] = [];
const nowSec = 1_785_000_000;
const v9Id: SafetyScoreV9PublicationIdentity = { model: "v9", schemaVersion: 1, methodologyVersion: "9.0", policyId: "safety-score-v9", policyDigest: "a".repeat(64), evaluationBuildDigest: "b".repeat(64), baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`, publicationGenerationId: "report-cards:v9:current" };
const mkHarness = () => { const sqlite = createLatestSchemaSqlite().sqlite; openDbs.push(sqlite); return { sqlite, db: createSqliteD1(sqlite) }; };
const mkGradeCtx = (db: D1Database, assets: ReturnType<typeof makeAsset>[], mcap: number): CollectorContext => ({ db, trackedStablecoinAssets: assets, trackedStablecoinIds: new Set(assets.map((a) => a.id)), coreAggregateStablecoinAssets: assets, coreAggregateStablecoinIds: new Set(assets.map((a) => a.id)), stablecoinAssetById: new Map(assets.map((a) => [a.id, a])), mcapById: new Map(assets.map((a) => [a.id, mcap])), currentPegObservationById: new Map(), stablecoinsCacheIsFresh: true, nowSec, todayTs: nowSec - (nowSec % 86_400), yesterdayTs: nowSec - (nowSec % 86_400) - 86_400 });
const insHist = (sqlite: DatabaseSync, o: Partial<{ historyId: string; stablecoinId: string; grade: string; score: number; transitionKind: string; policyId: string; policyDigest: string; evaluationBuildDigest: string; baseInputGenerationId: string; publicationGenerationId: string; prevGrade: string | null; prevScore: number | null }> = {}) => {
  sqlite.prepare("INSERT INTO safety_score_history_v2 (history_id, stablecoin_id, recorded_at, model, identity_schema_version, methodology_version, policy_id, policy_digest, evaluation_build_digest, base_input_generation_id, model_publication_generation_id, transition_kind, grade, score, prev_grade, prev_score, created_at) VALUES (?, ?, ?, 'v9', 1, '9.0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(o.historyId ?? "organic-current", o.stablecoinId ?? "usdt-tether", nowSec - 60, o.policyId ?? v9Id.policyId, o.policyDigest ?? v9Id.policyDigest, o.evaluationBuildDigest ?? v9Id.evaluationBuildDigest, o.baseInputGenerationId ?? `report-cards-input:v1:${"d".repeat(64)}`, o.publicationGenerationId ?? "report-cards:v9:prior", o.transitionKind ?? "organic-grade-change", o.grade ?? "A", o.score ?? 88, o.prevGrade === undefined ? "B+" : o.prevGrade, o.prevScore === undefined ? 84 : o.prevScore, nowSec - 60);
};
afterEach(() => { for (const s of openDbs.splice(0)) s.close(); });

describe("daily digest Safety Score transitions", () => {
  it("uses comparable V2 organic rows and excludes activation/build/policy boundaries", async () => {
    const { sqlite, db } = mkHarness();
    insHist(sqlite);
    insHist(sqlite, { historyId: "activation-boundary", transitionKind: "methodology-boundary-baseline", prevGrade: null, prevScore: null });
    insHist(sqlite, { historyId: "other-build", evaluationBuildDigest: "e".repeat(64) });
    insHist(sqlite, { historyId: "other-policy", policyId: "other-policy", policyDigest: "f".repeat(64) });
    const a = makeAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000 } });
    const pil = { score: 88, evidenceLevel: "strong", freshness: "current", reasons: [{ code: "bounded-mechanism-review", message: "Reviewed" }] };
    const grades: CanonicalSafetyGradeRow[] = [{ id: a.id, symbol: a.symbol, grade: "A", score: 88, pillars: { backing: pil, exit: pil, control: pil }, reasonCodes: ["bounded-mechanism-review"], caps: [], bindingCap: null }];
    const tr = await colGrades(mkGradeCtx(db, [a], 100_000_000), grades, v9Id);
    expect(tr.value.gradeTransitions).toHaveLength(1);
    expect(tr.value.gradeTransitions?.[0]).toMatchObject({ historyId: "organic-current", model: "v9", symbol: "USDT", fromGrade: "B+", toGrade: "A", safetyScoreIdentity: { model: "v9", policyId: v9Id.policyId, evaluationBuildDigest: v9Id.evaluationBuildDigest, baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`, publicationGenerationId: "report-cards:v9:prior" }, currentPillars: { backing: { score: 88 }, exit: { score: 88 }, control: { score: 88 } } });
  });

  it("does not score an NR baseline as a measured zero-point move", async () => {
    const { sqlite, db } = mkHarness();
    insHist(sqlite, { historyId: "usdt-nr-to-b", stablecoinId: "usdt-tether", grade: "B", score: 42, prevGrade: "NR", prevScore: null });
    insHist(sqlite, { historyId: "usdc-b-plus-to-b", stablecoinId: "usdc-circle", grade: "B", score: 18, prevGrade: "B+", prevScore: 60 });
    const assets = [makeAsset({ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 1e9 } }), makeAsset({ id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 1e9 } })];
    const pil = { score: 42, evidenceLevel: "strong", freshness: "current", reasons: [{ code: "bounded-mechanism-review", message: "Reviewed" }] };
    const grades: CanonicalSafetyGradeRow[] = [{ id: "usdt-tether", symbol: "USDT", grade: "B", score: 42, pillars: { backing: pil, exit: pil, control: pil }, reasonCodes: [], caps: [], bindingCap: null }, { id: "usdc-circle", symbol: "USDC", grade: "B", score: 18, pillars: { backing: pil, exit: pil, control: pil }, reasonCodes: [], caps: [], bindingCap: null }];
    const tr = await colGrades(mkGradeCtx(db, assets, 1e9), grades, v9Id);
    expect(tr.degradedReasons).toEqual([]);
    const cands = new Map(buildCands({ ...BASE, gradeTransitions: tr.value.gradeTransitions }).filter((c) => c.kind === "grade").map((c) => [c.id, c]));
    expect(cands.get("grade:usdc:b-:b")?.impactScore).toBe(42);
    const unm = cands.get("grade:usdt:nr:b");
    expect(unm).toMatchObject({ impactScore: 0, title: "USDT grade NR -> B" }); expect(unm?.headlineFacts[0]).toContain("no measured score baseline");
  });

  it("names a failed grade-transition read instead of recording no movers", () => {
    const window = { start: nowSec - 2 * 86_400, end: nowSec };
    const inp: DigestInputData = { ...BASE, safetyContext: BASE_SAFE, gradeTransitionAccounting: { complete: false, window, reason: "grade-transitions-query" }, degradedSources: ["grade-transitions-query"] };
    const mLine = (p: string) => p.split("\n").find((l) => l.trimStart().startsWith("Grade movers (last 48h)"));
    const failed = mLine(prompt(inp));
    expect(failed).toBeDefined(); expect(failed).not.toContain("none recorded"); expect(failed).toContain("unavailable (grade-transitions-query)");
    const sm = buildMapCap(inp, { kind: "available", imageUrl: "https://pharos.watch/safety-scores/map.png?date=2026-08-30", freshness: "carried-forward", ageDays: 2, manifest: { date: "2026-08-30", asOfSec: 1_788_000_000, renderedAtSec: 1_788_001_000, edition: "daily", bytes: { png: 1_000_000 }, mapSummary: MAP_SUM } });
    expect(sm).not.toBeNull();
    expect(mLine(prompt({ ...inp, safetyMap: sm!, gradeTransitionAccounting: { complete: true, window, safetyScoreIdentity: BASE_SAFE.identity, count: 0, identities: [] }, degradedSources: [] }))).toContain("none recorded");
  });
});

const PSI_NOW = Math.floor(Date.parse("2026-03-30T08:10:00Z") / 1000);
const psiAt = (stored_at: number) => ({ score: 96, band: "BEDROCK", stored_at, components: js({ severity: 0, breadth: 0, trend: 0 }) });

describe("daily digest PSI source admission", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(PSI_NOW * 1000); });
  const buildPsi = async (sample: Record<string, unknown> | null, daily: Record<string, unknown> | null) => {
    const sc = mkScen({ db: { prependTables: [first("SELECT score, band, components, stored_at FROM stability_index_samples", sample), first("SELECT score, band, components, computed_at as stored_at", daily), first("stability_index_samples AS s LEFT JOIN stability_index AS d", { avg: null })] } });
    vm(loadCache).mockResolvedValue(sc.sourcePayload); vm(loadSafe).mockResolvedValue(sc.safetySource);
    return buildIn(sc.db);
  };

  it.each([
    ["stale sample", psiAt(PSI_NOW - 3 * 3600), null], ["old daily-only row", null, psiAt(PSI_NOW - 3 * 86400)],
    ["future sample", psiAt(PSI_NOW + 1), null], ["future daily-only row", null, psiAt(PSI_NOW + 1)], ["missing observations", null, null],
  ])("withholds %s from current copy and the optimistic regime", async (_l, sample, daily) => {
    const built = await buildPsi(sample, daily);
    expect(built.inputData.stabilityIndex).toBeNull(); expect(built.degradedReasons).toContain("psi-unavailable");
    expect(prompt(built.inputData)).not.toContain("Pharos Stability Index: 96");
    expect(regime({ ...BASE, activeDepegCount: 0, topDepegs: [], stabilityIndex: built.inputData.stabilityIndex, degradedSources: built.degradedReasons.filter((r) => r.startsWith("psi-")) })).toBe("WATCHFUL");
  });

  it.each([
    ["fresh sample", psiAt(PSI_NOW - 600), psiAt(PSI_NOW - 3 * 86400)],
    ["fresh daily fallback", psiAt(PSI_NOW - 3 * 3600), psiAt(Math.floor(PSI_NOW / 86400) * 86400 - 86400)],
  ])("preserves admitted %s behavior", async (_l, sample, daily) => {
    const built = await buildPsi(sample, daily);
    expect(built.inputData.stabilityIndex).toMatchObject({ score: 96, band: "BEDROCK" }); expect(built.degradedReasons).not.toContain("psi-unavailable");
    expect(prompt(built.inputData)).toContain("Pharos Stability Index: 96");
    expect(regime({ ...BASE, activeDepegCount: 0, topDepegs: [], stabilityIndex: built.inputData.stabilityIndex, degradedSources: built.degradedReasons.filter((r) => r.startsWith("psi-")) })).toBe("CALM");
  });
});

describe("daily digest generation", () => {
  const fp = createHash("sha256").update('["core-stablecoins-v1",["usdc-circle","usdt-tether"]]').digest("hex");
  const CREDS = { apiKey: "x", apiSecret: "y", accessToken: "z", accessTokenSecret: "w" };
  const TG = { botToken: "tg-token", chatId: "tg-chat" };
  const SOFT_TXT = js({ title: "Drift", extended: OK_EXT, text: "USDT's fixture depeg led the queue while PSI stayed at 91.2 BEDROCK.", meta: { leadSignalId: "depeg:usdt-tether:active", lead: "depeg", tone: "dry", coins: ["USDT", "USDC"], usedCandidateIds: ["depeg:usdt-tether:active"] } });
  const SAFE_FREE = OK_TXT.replace("Safety scores stayed A for USDT and USDC, ", "Capital stayed concentrated in USDT and USDC, ");
  const validMap = (date = "2026-03-06") => ({ kind: "available" as const, freshness: "current" as const, ageDays: 0, imageUrl: `https://pharos.watch/safety-scores/map.png?date=${date}`, manifest: { date, asOfSec: 1_788_000_000, renderedAtSec: 1_788_001_000, edition: "daily" as const, bytes: { png: 1_000_000 }, mapSummary: { ...MAP_SUM, date } } });
  const bindJson = (db: D1Database, i: number) => jp(String(insBinds(db as MockD1Database)?.[i]));
  const reqBody = (i = 0) => jp(String(vm(fetchR).mock.calls[i]?.[1]?.body)) as { system: string; messages: Array<{ content: string }>; [key: string]: unknown };
  const expectNoSend = () => { expect(postTw).not.toHaveBeenCalled(); expect(enqTg).not.toHaveBeenCalled(); expect(delTg).not.toHaveBeenCalled(); };

  let scen: DailyDigestScenario;
  const invoke = (db = scen.db, force = false, creds: typeof CREDS | null = CREDS, tg: typeof TG | null = TG, prog?: (u: CronProgressUpdate) => Promise<void>) => genDigest(db, "anthropic-key", creds, force, tg, undefined, prog);

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
    scen = mkScen();
    vm(loadCache).mockReset().mockResolvedValue(scen.sourcePayload); vm(loadSafe).mockReset().mockResolvedValue(scen.safetySource);
    vm(fetchR).mockReset().mockImplementation(async () => mkStream(scen.modelResponse));
    vm(postTw).mockReset().mockResolvedValue(scen.deliveryMocks.twitter);
    vm(enqTg).mockReset().mockResolvedValue(scen.deliveryMocks.telegramEnqueue);
    vm(delTg).mockReset().mockResolvedValue(scen.deliveryMocks.telegramDelivery);
    vm(prepApp).mockReset().mockResolvedValue(scen.deliveryMocks.appendices);
    vm(shouldFetch).mockReset().mockResolvedValue(true); vm(recOut).mockReset().mockResolvedValue(null);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  describe("generateDailyDigest publication contract", () => {
    it("generates, stores, and delivers one mapped edition end to end", async () => {
      vm(resMap).mockResolvedValueOnce(validMap());
      const res = await invoke(), inp = bindJson(scen.db, 3), meta = bindJson(scen.db, 5), body = reqBody();
      expect(res).toMatchObject({ itemCount: 1 }); expect(res.metadata).toContain("tweet: ok"); expect(res.metadata).toContain("telegram: ok");
      expect(inp).toMatchObject({ aggregateUniverse: "core-stablecoins-v1", totalMcapUsd: 160_000_000, activeDepegCount: 1, resolvedDepegCount: 0, safetyMap: { manifest: { date: "2026-03-06" } }, editorialAudit: { leadCandidateId: "depeg:usdt-tether:active", usedCandidateIds: ["depeg:usdt-tether:active"] } });
      expect(inp.depegSignalKeys).toEqual({ active: [`usdt-tether:${nowS() - 3600}:active`], resolved: [] });
      expect(meta).toMatchObject({ styleGateMode: "shadow", editorialStyleGate: { mode: "shadow", firstPassWouldBlock: false }, llm: { model: DIGEST_MODEL, maxTokens: 16000, attempts: [{ attemptNumber: 1, inputTokens: 1000, outputTokens: 500, httpStatus: 200 }] } });
      expect(body.messages[0].content).toContain("Safety Map census (current; depicts 2026-03-06 UTC)");
      expect(postTw).toHaveBeenCalledTimes(1); expect(enqTg).toHaveBeenCalledTimes(1); expect(delTg).toHaveBeenCalledTimes(1);
      expect(runTgPermit).toHaveBeenCalledWith(expect.objectContaining({ owner: "daily-digest", editionKey: "daily:2026-03-06" }));
      expect(fetchR).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-api-key": "anthropic-key" }) }), 0, { timeoutMs: 11 * 60_000, returnFinalResponse: true });
    });

    it("persists unavailable gauge provenance without breaking Telegram publication", async () => {
      const db = scenDb([gVal({ gauge: { score: null, band: null, flightToQuality: false, flightIntensity: 0, partialValuationInputs: 0 } })]);
      expect((await invoke(db)).itemCount).toBe(1);
      const inp = bindJson(db, 3);
      expect(inp.mintBurnFlows).toBeUndefined(); expect(inp.degradedSources).toContain("mint-burn-gauge-unavailable"); expect(inp.dataQuality.degradedSources).toContain("mint-burn-gauge-unavailable");
      const msg = reqBody().messages[0].content; expect(msg).toContain("Writing register: observant"); expect(msg).toContain("mint-burn-gauge-unavailable");
      expect(enqTg).toHaveBeenCalledTimes(1); expect(delTg).toHaveBeenCalledTimes(1);
    });

    it("sends the canonical streaming prompt contract without an attachment", async () => {
      await invoke(scen.db, false, null, null);
      const body = reqBody();
      expect(body).toMatchObject({ model: DIGEST_MODEL, thinking: { type: "adaptive" }, output_config: { effort: "high" }, max_tokens: 16000, fallbacks: "default", stream: true });
      expect(body.messages[0].content).toEqual(expect.stringContaining("Editorial Candidates")); expect(body.messages[0].content).toEqual(expect.stringContaining("Risk Tape"));
      expect(body.system.startsWith(buildEditorialPrompt("daily"))).toBe(true); expect(body.system).toContain(`Allowed tones: ${ALLOWED_TONES.join(", ")}.`); expect(body.system).toContain("CALM-DAY STORYTELLING");
      expect(body.messages[0].content).not.toContain("Safety Map census"); expect(bindJson(scen.db, 3).safetyMap).toBeUndefined();
    });

    it("keeps soft quality findings publishable and gates daily mode independently", async () => {
      vm(fetchR).mockImplementation(async () => mkStream(SOFT_TXT));
      const soft = await invoke(); expect(soft.itemCount).toBe(1); expect(soft.status, soft.metadata).toBeUndefined(); expect(fetchR).toHaveBeenCalledTimes(1); expect(postTw).toHaveBeenCalledTimes(1);
      expect(bindJson(scen.db, 3).dataQuality.degradedSources).toContain("mint-burn-gauge-missing");
      vi.clearAllMocks(); vm(fetchR).mockReset().mockImplementation(async () => mkStream(withDash(OK_TXT)));
      const shDb = scenDb(gateTbl({ daily: "shadow", weekly: "enforce" }));
      expect((await invoke(shDb)).itemCount).toBe(1); expect(fetchR).toHaveBeenCalledTimes(1);
      expect(bindJson(shDb, 5)).toMatchObject({ styleGateMode: "shadow", editorialStyleGate: { firstPassWouldBlock: true, retry: { outcome: "shadow-observed" } } });
      vi.clearAllMocks(); vm(fetchR).mockReset().mockImplementation(async () => mkStream(withDash(OK_TXT)));
      const enDb = scenDb(gateTbl({ daily: "enforce", weekly: "shadow" }));
      expect((await invoke(enDb)).status).toBe("degraded"); expect(fetchR).toHaveBeenCalledTimes(2); expect(postTw).not.toHaveBeenCalled();
      expect(bindJson(enDb, 5)).toMatchObject({ qualityGate: "blocked", styleGateMode: "enforce", editorialStyleGate: { retry: { attempted: true, outcome: "unresolved" } } });
    });

    it("publishes hard style copy only after one successful correction", async () => {
      const db = scenDb(gateTbl({ daily: "enforce", weekly: "shadow" }));
      vm(fetchR).mockResolvedValueOnce(mkStream(withDash(OK_TXT))).mockResolvedValueOnce(mkStream(OK_TXT));
      expect((await invoke(db)).itemCount).toBe(1); expect(fetchR).toHaveBeenCalledTimes(2);
      expect(bindJson(db, 5)).toMatchObject({ editorialStyleGate: { firstPassWouldBlock: true, retry: { attempted: true, outcome: "resolved" } } });
      expect(postTw).toHaveBeenCalledTimes(1); expect(enqTg).toHaveBeenCalledTimes(1);
    });

    it("does not retry advisory style findings in enforce mode", async () => {
      const db = scenDb(gateTbl({ daily: "enforce", weekly: "shadow" })), adv = jp(OK_TXT);
      adv.text = "The plumbing flinched while USDT held near peg.";
      vm(fetchR).mockResolvedValueOnce(mkStream(js(adv)));
      expect((await invoke(db)).itemCount).toBe(1); expect(fetchR).toHaveBeenCalledTimes(1);
      expect(bindJson(db, 5)).toMatchObject({ editorialStyleGate: { firstPassWouldBlock: false } }); expect(postTw).toHaveBeenCalledTimes(1);
    });

    it.each(["time", "token"] as const)("holds unresolved enforced style copy when the %s budget prevents correction", async (budget) => {
      const db = scenDb(gateTbl({ daily: "enforce", weekly: "shadow" }));
      vm(fetchR).mockImplementationOnce(async () => {
        if (budget === "time") vi.setSystemTime(new Date(Date.now() + ANTHROPIC_TIMEOUT_MS * 0.5 + 30_000));
        const r = mkStream(withDash(OK_TXT));
        return budget === "time" ? r : new Response((await r.text()).replace('"output_tokens":500', '"output_tokens":17000'), { headers: { "Content-Type": "text/event-stream" } });
      });
      expect((await invoke(db)).status).toBe("degraded"); expect(fetchR).toHaveBeenCalledTimes(1);
      expect(bindJson(db, 5)).toMatchObject({ qualityGate: "blocked", editorialStyleGate: { firstPassWouldBlock: true, retry: { eligible: false, attempted: false, outcome: `skipped-${budget}-budget` } } });
      expectNoSend();
    });

    it("retries a bound numeric contradiction once and holds the unrepaired edition", async () => {
      const bad = js({ ...jp(OK_TXT), text: "USDT trades at $0.90, 150 bps below peg." });
      vm(fetchR).mockImplementation(async () => mkStream(bad));
      expect((await invoke()).status).toBe("degraded"); expect(fetchR).toHaveBeenCalledTimes(2);
      expect(js(reqBody(1).messages)).toContain("price-bps-mismatch");
      expect(bindJson(scen.db, 5)).toMatchObject({ qualityGate: "blocked" }); expectNoSend();
    });

    it("publishes the corrected numeric copy after the bounded retry", async () => {
      const r = jp(OK_TXT);
      vm(fetchR).mockResolvedValueOnce(mkStream(js({ ...r, text: "USDT trades at $0.90, 150 bps below peg." }))).mockResolvedValueOnce(mkStream(js({ ...r, text: "USDT trades at $0.985, 150 bps below peg." })));
      expect((await invoke()).itemCount).toBe(1); expect(fetchR).toHaveBeenCalledTimes(2);
      expect(bindJson(scen.db, 5)).not.toMatchObject({ qualityGate: "blocked" });
      expect(postTw).toHaveBeenCalledTimes(1); expect(insBinds(scen.db as MockD1Database)?.[1]).toBe("USDT trades at $0.985, 150 bps below peg."); expect(enqTg).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])("binds an invented but self-consistent numeric pair to the observation; corrected=%s", async (ok) => {
      const r = jp(OK_TXT), bad = js({ ...r, text: "USDT trades at $0.90, 1,000 bps below peg." }), fix = js({ ...r, text: "USDT trades at $0.99, 150 bps below peg." });
      vm(fetchR).mockResolvedValueOnce(mkStream(bad)).mockResolvedValueOnce(mkStream(ok ? fix : bad));
      const res = await invoke(); expect(fetchR).toHaveBeenCalledTimes(2); expect(js(reqBody(1).messages)).toContain("price-bps-observation-mismatch");
      if (ok) { expect(res.itemCount).toBe(1); expect(insBinds(scen.db as MockD1Database)?.[1]).toBe("USDT trades at $0.99, 150 bps below peg."); expect(postTw).toHaveBeenCalledTimes(1); expect(enqTg).toHaveBeenCalledTimes(1); }
      else { expect(res.status).toBe("degraded"); expect(bindJson(scen.db, 5)).toMatchObject({ qualityGate: "blocked" }); expectNoSend(); }
    });

    it("repairs malformed model output once, but skips repair after the time budget is spent", async () => {
      const bad = '```json\n{"title":"Broken", "text":\n```';
      vm(fetchR).mockResolvedValueOnce(mkStream(bad));
      expect((await invoke()).itemCount).toBe(1); expect(fetchR).toHaveBeenCalledTimes(2); expect(bindJson(scen.db, 5).llm.attempts).toHaveLength(2);
      vm(fetchR).mockReset().mockImplementationOnce(async () => { vi.setSystemTime(new Date(Date.now() + ANTHROPIC_TIMEOUT_MS * 0.5 + 30_000)); return mkStream(bad); });
      await invoke(); expect(fetchR).toHaveBeenCalledTimes(1);
    });

    it("bounds both legs by one LLM deadline so a slow corrective leg cannot outlive the lease", async () => {
      const bad = '```json\n{"title":"Broken", "text":\n```';
      let mark!: () => void; const started1 = new Promise<void>((r) => { mark = r; });
      vm(fetchR).mockReset().mockImplementationOnce(async () => { vi.advanceTimersByTime(ANTHROPIC_TIMEOUT_MS * 0.5 - 30_000); mark(); return mkStream(bad); })
        .mockImplementationOnce(((_u: string, init?: RequestInit) => new Promise((_r, rej) => { init?.signal?.addEventListener("abort", () => rej(init.signal?.reason)); })) as never);
      const t0 = Date.now(); let ms: number | null = null;
      const gen = invoke().catch(() => undefined).finally(() => { ms = Date.now() - t0; });
      await started1; await vi.advanceTimersByTimeAsync(ANTHROPIC_TIMEOUT_MS - (Date.now() - t0)); await gen;
      expect(fetchR).toHaveBeenCalledTimes(2); expect(ms).not.toBeNull(); expect(ms!).toBeLessThanOrEqual(ANTHROPIC_TIMEOUT_MS);
    });

    it("retries bounded HTTP failures and records the circuit outcome", async () => {
      let mark!: () => void; const started1 = new Promise<void>((r) => { mark = r; });
      vm(fetchR).mockImplementation(async () => { mark(); return new Response("anthropic overloaded", { status: 529 }); });
      const gen = expect(invoke()).rejects.toThrow("Claude API error 529: anthropic overloaded");
      await started1; await vi.runAllTimersAsync(); await gen;
      expect(recOut).toHaveBeenCalledWith(scen.db, CIRCUIT_SOURCE.ANTHROPIC, false); expect(fetchR).toHaveBeenCalledTimes(3);
    });

    it("handles missing keys, circuit open, refusal, and preflight cache gates", async () => {
      const prog: CronProgressUpdate[] = [];
      const r1 = await genDigest(scen.db, null, null, false, null, undefined, async (u) => { prog.push(u); });
      expect(r1).toMatchObject({ status: "skipped_neutral", itemCount: 0 }); expect(jp(r1.metadata!)).toEqual({ reason: "missing-api-key" });
      expect(prog).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "preflight" }), expect.objectContaining({ stage: "skipped" })]));
      expect(fetchR).not.toHaveBeenCalled(); expect(insBinds(scen.db as MockD1Database)).toBeUndefined();
      vm(shouldFetch).mockResolvedValue(false); const cir = await invoke();
      expect(cir).toMatchObject({ status: "degraded", itemCount: 0 }); expect(jp(cir.metadata!)).toEqual({ reason: "anthropic-circuit-open" });
      expect(fetchR).not.toHaveBeenCalled(); expect(insBinds(scen.db as MockD1Database)).toBeUndefined(); expect(postTw).not.toHaveBeenCalled(); expect(enqTg).not.toHaveBeenCalled();
      vm(shouldFetch).mockResolvedValue(true); vm(fetchR).mockResolvedValueOnce(mkRefusal());
      const ref = await invoke(); expect(ref).toMatchObject({ status: "degraded", itemCount: 0 }); expect(ref.metadata).toContain("anthropic-refusal"); expect(recOut).not.toHaveBeenCalled();
      vi.clearAllMocks(); vm(loadCache).mockResolvedValueOnce({ kind: "error", reason: "missing-cache", updatedAt: null });
      expect((await invoke()).itemCount).toBe(0); expect(fetchR).not.toHaveBeenCalled();
    });

    it("skips a recent valid edition but regenerates an unpublishable recent row", async () => {
      const q = "SELECT generated_at, digest_text FROM daily_digest\n       WHERE";
      const sk = await invoke(mockD1([first(q, { generated_at: nowS() - 20 * 60, digest_text: "Already generated" })]));
      expect(sk).toMatchObject({ status: "skipped_neutral", itemCount: 0 }); expect(jp(sk.metadata!)).toEqual({ reason: "recent-digest", ageSec: 20 * 60 }); expect(fetchR).not.toHaveBeenCalled();
      expect((await invoke(scenDb([first(q, { generated_at: nowS() - 20 * 60, digest_text: "```json" })]))).itemCount).toBe(1); expect(fetchR).toHaveBeenCalled();
    });

    it("fails before model generation when the input collection fails", async () => {
      const db = mkScen({ db: { transformTables: (ts) => [...ts.filter((t) => t.match !== "stability_index_samples AS s LEFT JOIN stability_index AS d"), { match: "stability_index_samples AS s LEFT JOIN stability_index AS d", rows: [], throwError: new Error("D1 read failed") }] } }).db;
      await expect(invoke(db)).rejects.toThrow("D1 read failed"); expect(fetchR).not.toHaveBeenCalled();
    });

    it("blocks unbound safety copy, then repairs it when the second response is clean", async () => {
      vm(loadSafe).mockResolvedValue({ kind: "error", reason: "v9-snapshot-unavailable", detail: "identity mismatch", snapshot: null });
      const blk = await invoke(); expect(blk.status).toBe("degraded"); expect(bindJson(scen.db, 3).safetyScores).toBeUndefined(); expect(bindJson(scen.db, 5)).toMatchObject({ qualityGate: "blocked" }); expect(fetchR).toHaveBeenCalledTimes(2); expect(enqTg).not.toHaveBeenCalled();
      const cleanExt = OK_EXT.replace("Safety scores stayed A for USDT and USDC, ", "The fixture's primary risk inputs were unchanged, ");
      vi.clearAllMocks(); const repDb = mkScen().db;
      vm(fetchR).mockReset().mockResolvedValueOnce(mkStream(OK_TXT)).mockResolvedValueOnce(mkStream(js({ ...jp(OK_TXT), extended: cleanExt })));
      expect((await invoke(repDb)).itemCount).toBe(1); expect(fetchR).toHaveBeenCalledTimes(2); expect(insBinds(repDb)?.[4]).toBe(cleanExt); expect(bindJson(repDb, 5)).not.toMatchObject({ qualityGate: "blocked" });
      expect(enqTg).toHaveBeenCalledWith(repDb, expect.objectContaining({ extended: cleanExt }), undefined); expect(delTg).toHaveBeenCalledTimes(1);
    });

    it("keeps persistence when collectors, wrappers, or social channels degrade", async () => {
      const bDb = mkScen({ db: { transformTables: (ts) => ts.map((t) => t.match === "FROM depeg_events e LEFT JOIN depeg_event_provenance" ? { ...t, throwError: new Error("d1 unavailable") } : t) } }).db;
      const deg = await invoke(bDb); expect(deg).toMatchObject({ itemCount: 1, status: "degraded" }); expect(deg.metadata).toContain("active-depegs-query");
      vm(prepApp).mockRejectedValueOnce(new Error("appendix store down")); expect((await invoke()).itemCount).toBe(1);
      const rec = await invoke(); expect(rec.status, rec.metadata).toBeUndefined();
      vm(postTw).mockRejectedValueOnce(new Error("twitter down")); vm(delTg).mockRejectedValueOnce(new Error("telegram down"));
      expect(await invoke()).toMatchObject({ itemCount: 1, status: "degraded" }); expect(insBinds(scen.db as MockD1Database)).toBeDefined();
    });

    it.each([
      ["active-depeg read fails", "active-depegs-query", "usx-dforce", "USX"],
      ["stablecoins cache is stale", "stablecoins-cache-stale", "usdt-tether", "USDT"],
      ["open USD event has no current reference", "active-depeg-reference-unavailable", "usdt-tether", "USDT"],
    ])("retains the pending depeg lifecycle queue when the %s", async (_c, reason, sid, sym) => {
      const now = nowS(), { sqlite, db } = createLatestSchemaSqlite({ onAll: (sql) => { if (reason === "active-depegs-query" && sql.includes("FROM depeg_events e LEFT JOIN depeg_event_provenance")) throw new Error("D1 read failed"); } });
      try {
        const pAt = now - 86_400, pFlags = [{ stablecoinId: sid, symbol: sym, kind: "stalled-collapse", currentBps: -6_200, ageDays: 27, mcapUsd: 12_000_000 }];
        sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(FLAGS_KEY, js({ updatedAt: pAt, flags: pFlags }), pAt);
        const comp = js({ severity: 2, breadth: 1, trend: 0, stressBreadth: 0 });
        sqlite.prepare("INSERT INTO stability_index_samples (stored_at, score, band, components, input_snapshot) VALUES (?, ?, ?, ?, ?)").run(now - 600, 91.2, "BEDROCK", comp, "{}");
        sqlite.prepare("INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (?, ?, ?, ?, ?)").run(now - (now % 86_400), 89.5, "STEADY", comp, "{}");
        if (reason === "stablecoins-cache-stale") vm(loadCache).mockResolvedValueOnce({ ...scen.sourcePayload, updatedAt: now - 3_600 } as typeof scen.sourcePayload);
        else if (reason === "active-depeg-reference-unavailable") {
          sqlite.prepare("INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source) VALUES (201, 'usdt-tether', 'USDT', 'peggedUSD', 'below', -150, ?, 0.998, 0.998, 1, 'live')").run(now - 3 * 86_400);
          const src = scen.sourcePayload as Extract<typeof scen.sourcePayload, { kind: "ok" }>;
          vm(loadCache).mockResolvedValueOnce({ ...src, payload: { ...src.payload, peggedAssets: src.payload.peggedAssets.map((a) => a.id === "usdt-tether" ? { ...a, price: null } : a) } });
        }
        const res = await genDigest(db, "anthropic-key", null, false, null); expect(res.itemCount).toBe(1);
        if (reason === "active-depeg-reference-unavailable") expect((jp(String((sqlite.prepare("SELECT input_data FROM daily_digest ORDER BY generated_at DESC LIMIT 1").get() as { input_data: string }).input_data)) as { degradedSources?: string[] }).degradedSources).toContain(reason);
        else expect(res.metadata).toContain(reason);
        const row = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(FLAGS_KEY) as { value: string; updated_at: number } | undefined;
        expect(row).toBeDefined(); expect(jp(String(row!.value))).toEqual({ updatedAt: pAt, flags: pFlags }); expect(row!.updated_at).toBe(pAt);
      } finally { sqlite.close(); }
    });

    it("isolates an editorially unsafe wrapper and preserves a literal cemetery appendix", async () => {
      vm(prepApp).mockResolvedValueOnce({ ...scen.deliveryMocks.appendices, appendixHtml: "This wrapper is safe.", metadata: { ...scen.deliveryMocks.appendices.metadata, hasAppendix: true, trackedDetected: 1 } });
      const w = await invoke(scen.db, false, CREDS, TG);
      expect(fetchR).toHaveBeenCalledTimes(1); expect(enqTg).not.toHaveBeenCalled();
      expect(jp(String(w.metadata)).channels.telegram).toMatchObject({ status: "skipped: editorial-style-wrapper", disposition: "terminal-unsent" });
      vi.clearAllMocks(); vm(prepApp).mockResolvedValueOnce({ ...scen.deliveryMocks.appendices, appendixHtml: "<b>New Cemetery Entries</b>\n\nThe market has finished another obituary for us.", metadata: { ...scen.deliveryMocks.appendices.metadata, hasAppendix: true, cemeteryDetected: 1 } });
      const c = await invoke(scen.db, false, null, TG); expect(c.itemCount).toBe(1); expect(enqTg).toHaveBeenCalledTimes(1); expect(jp(String(c.metadata)).channels.telegram.disposition).toBe("delivered");
    });

    it("blocks a suppressed lead without publishing either channel", async () => {
      const now = nowS(), sup = js({ title: "Pool Drains, Score Shrugs", extended: OK_EXT, text: "USDC's measured DEX depth thinned while the composite score barely moved.", meta: { leadSignalId: "liquidity:usdc", lead: "liquidity", tone: "dry", coins: ["USDC"], usedCandidateIds: ["liquidity:usdc"] } });
      vm(fetchR).mockImplementation(async () => mkStream(sup));
      const db = scenDb([{ match: "FROM dex_liquidity_history", rows: [{ stablecoin_id: "usdc-circle", liquidity_score: 60, total_tvl_usd: 80_000, snapshot_date: now - 86_400, coverage_class: "primary", coverage_confidence: 0.9, methodology_version: "6.1" }, { stablecoin_id: "usdc-circle", liquidity_score: 70, total_tvl_usd: 90_000, snapshot_date: now - 2 * 86_400, coverage_class: "primary", coverage_confidence: 0.9, methodology_version: "6.1" }] }]);
      const res = await invoke(db); expect(res.status).toBe("degraded"); expect(res.metadata).toContain("suppressed-lead");
      expect(bindJson(db, 5)).toMatchObject({ qualityGate: "blocked" }); expect(enqTg).not.toHaveBeenCalled();
    });

    it("reports missing delivery credentials and handles unavailable maps", async () => {
      const res = await genDigest(scen.db, "anthropic-key", null, false, null, undefined, undefined, { twitterMissing: ["TWITTER_API_KEY", "TWITTER_API_SECRET"], telegramMissing: ["TELEGRAM_BOT_TOKEN"] });
      expect(res.status).toBe("degraded"); expect(jp(res.metadata!)).toMatchObject({ channels: { twitter: { status: "skipped: no-creds", missingCredentialNames: ["TWITTER_API_KEY", "TWITTER_API_SECRET"] }, telegram: { status: "no-creds", missingCredentialNames: ["TELEGRAM_BOT_TOKEN"] } } });
      vm(resMap).mockResolvedValueOnce({ kind: "unavailable", reason: "manifest-too-old" });
      expect((await invoke()).itemCount).toBe(1); expect(postTw).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Object), expect.any(Number), null, null, expect.any(Object));
      vm(resMap).mockResolvedValueOnce({ kind: "unavailable", reason: "image-http-404" }); expect((await invoke(scen.db, true)).itemCount).toBe(1);
    });

    it("keeps a valid map attachment while omitting unbound safety prose", async () => {
      vm(loadSafe).mockResolvedValue({ kind: "error", reason: "v9-snapshot-unavailable", detail: "identity mismatch", snapshot: null });
      vm(fetchR).mockImplementation(async () => mkStream(SAFE_FREE)); vm(resMap).mockResolvedValueOnce(validMap());
      const res = await invoke(scen.db, false, CREDS, TG); expect(res.status).toBe("degraded"); expect(res.metadata).not.toContain("unbound-safety-copy");
      expect(postTw).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Object), expect.any(Number), expect.stringContaining("date=2026-03-06"), null, expect.any(Object));
      expect(enqTg).toHaveBeenCalledWith(scen.db, expect.objectContaining({ mapImageUrl: expect.stringContaining("date=2026-03-06"), safetyContext: expect.objectContaining({ status: "unavailable" }) }), undefined);
    });
  });

  describe("delivery boundaries and resume", () => {
    it("claims Twitter before sending, retains unknown execution, and skips an existing claim", async () => {
      await invoke(); const key = "daily-digest:twitter-sent:2026-03-06", hist = (scen.db as MockD1Database).getHistory();
      expect(hist.filter((r) => r.sql.includes("INSERT OR IGNORE INTO cache") && r.binds[0] === key)).toHaveLength(1);
      expect(hist.filter((r) => r.sql.includes("DELETE FROM cache") && r.binds[0] === key)).toHaveLength(0);
      const fDb = mkScen().db; vi.clearAllMocks(); vm(postTw).mockRejectedValueOnce(new Error("twitter down"));
      expect((await invoke(fDb)).metadata).toContain("tweet: failed:");
      expect((fDb as MockD1Database).getHistory().find((r) => r.sql.includes("UPDATE cache SET value") && r.binds[2] === key && String(r.binds[0]).includes('"state":"execution_unknown"'))).toBeDefined();
      const taken = scenDb([{ match: "INSERT OR IGNORE INTO cache", rows: [], runMeta: { changes: 0 } }, { match: "SELECT value FROM cache WHERE key = ?", matchBinds: [key], rows: [], first: { value: js({ sentAt: 1, editionNumber: 1 }) } }]);
      vi.clearAllMocks(); expect((await invoke(taken)).metadata).toContain("tweet: skipped: already-sent"); expect(postTw).not.toHaveBeenCalled();
    });

    it("continues Telegram after a Twitter marker failure and preserves outbox ordering", async () => {
      const db = scenDb([{ match: "INSERT OR IGNORE INTO cache", rows: [], throwError: new Error("twitter marker down") }]);
      await expect(invoke(db)).rejects.toThrow("Twitter daily digest marker write failed");
      expect(enqTg).toHaveBeenCalledTimes(1); expect(delTg).toHaveBeenCalledTimes(1); expect(insBinds(db as MockD1Database)).toBeDefined();
    });

    it("keeps Telegram's immutable edition and retryable states durable", async () => {
      await invoke(scen.db, false, null, TG);
      expect(enqTg).toHaveBeenCalledWith(scen.db, expect.objectContaining({ editionKey: "daily:2026-03-06", digestKind: "daily", targetChatId: "tg-chat", title: "Calm Drift", extended: OK_EXT, editionNumber: 1 }), undefined);
      vi.clearAllMocks(); vm(delTg).mockResolvedValueOnce({ editionKey: "daily:2026-03-06", state: "pending", outcome: "pending", chunksSent: 0, nextChunkIndex: 0, chunkCount: 1, errorClass: "rate_limit", retryAfterSec: 45 });
      expect((await invoke()).metadata).toContain("telegram: failed:");
      vi.clearAllMocks(); vm(enqTg).mockRejectedValueOnce(new Error("outbox down")); await expect(invoke()).rejects.toThrow("Telegram daily digest outbox write failed"); expect(delTg).not.toHaveBeenCalled();
      vi.clearAllMocks(); vm(enqTg).mockResolvedValueOnce({ created: false, payloadMatched: false, editionKey: "daily:2026-03-06", state: "pending", chunks: ["previous exact edition"] });
      expect((await invoke()).metadata).toContain("telegram-outbox-payload-mismatch");
    });

    it("does not degrade forced already-sent editions and leaves pending appendix actions uncommitted", async () => {
      vm(enqTg).mockResolvedValueOnce({ created: false, payloadMatched: false, editionKey: "daily:2026-03-06", state: "sent", chunks: ["previous exact edition"] });
      vm(delTg).mockResolvedValueOnce({ editionKey: "daily:2026-03-06", state: "sent", outcome: "skipped", chunksSent: 0, nextChunkIndex: 1, chunkCount: 1, errorClass: null, retryAfterSec: null });
      const res = await invoke(scen.db, true); expect(res.status, res.metadata).toBeUndefined(); expect(res.metadata).toContain("telegram: skipped: already-sent");
      const successActions = [{ key: "telegram:cemetery-snapshot", value: '["terrausd"]' }];
      vm(prepApp).mockResolvedValueOnce({ ...scen.deliveryMocks.appendices, appendixHtml: "<b>New Cemetery Entries</b>", metadata: { ...scen.deliveryMocks.appendices.metadata, hasAppendix: true, cemeteryDetected: 1 }, successActions });
      vm(delTg).mockResolvedValueOnce({ editionKey: "daily:2026-03-06", state: "pending", outcome: "pending", chunksSent: 0, nextChunkIndex: 0, chunkCount: 1, errorClass: "server_error", retryAfterSec: null });
      expect((await invoke()).metadata).toContain("telegram: failed:"); expect(enqTg).toHaveBeenCalledWith(scen.db, expect.objectContaining({ successActions }), undefined);
    });

    it("resumes a retryable X ledger and leaves the sent Telegram edition alone", async () => {
      const db = mkResDb([first("SELECT state FROM telegram_digest_outbox", { state: "sent" }), first("SELECT value FROM cache WHERE key = ?", { value: js({ schemaVersion: 1, state: "failed", attempts: 1, createdAt: 1, updatedAt: 1 }) }), { match: "INSERT OR IGNORE INTO cache", rows: [] }, { match: "UPDATE cache SET value = ?", rows: [] }], { generated_at: 1_772_798_400, digest_text: "Stored digest body.", digest_title: "Stored Title", digest_extended: "Stored extended body.", digest_meta: js({ leadSignalId: "depeg:usdt-tether:active", lead: "depeg", coins: ["USDT"] }), input_data: js({ totalMcapUsd: 100e9 }) });
      expect(await resDigest(db, CREDS, TG, validMap())).toEqual({ kind: "resumed", tweetStatus: "ok", telegramStatus: "outbox-sent", deliveryComplete: true });
      expect(postTw).toHaveBeenCalledWith("Stored Title", "Stored digest body.", expect.any(Object), 187, expect.any(String), null, expect.any(Object));
      expect(prepApp).not.toHaveBeenCalled(); expect(enqTg).not.toHaveBeenCalled();
      expect(await resDigest(mockD1([first("SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest", null)]), CREDS, null, validMap())).toEqual({ kind: "no-publishable-digest" });
    });

    it.each(["pending", "sending", "sent", "execution_unknown", "failed_permanent"])("never regenerates an existing daily %s payload when the map changes", async (state) => {
      const db = mkResDb([first("SELECT state FROM telegram_digest_outbox", { state })], { generated_at: 1_772_798_400, digest_text: "Stored copy.", digest_title: "Stored", digest_extended: "Stored extended.", input_data: js({ safetyContext: { status: "available" }, safetyMap: { manifest: { date: "2026-03-05" } } }) });
      expect(await resDigest(db, null, TG, validMap())).toMatchObject({ telegramStatus: `outbox-${state}`, deliveryComplete: state === "sent" });
      expect(prepApp).not.toHaveBeenCalled(); expect(enqTg).not.toHaveBeenCalled(); expect(delTg).not.toHaveBeenCalled();
    });

    it.each([null, js({ schemaVersion: 1, state: "execution_unknown", attempts: 1, createdAt: 1, updatedAt: 1 })])("refuses daily X resume without known retryable ledger evidence (%s)", async (v) => {
      const db = mkResDb([first("SELECT value FROM cache WHERE key = ?", v == null ? null : { value: v })]);
      expect(await resDigest(db, CREDS, null, null)).toMatchObject({ tweetStatus: "skipped: execution-unknown", deliveryComplete: false });
      expect(postTw).not.toHaveBeenCalled();
    });

    it("builds byte-identical new Telegram envelopes in generation and missing-outbox resume", async () => {
      const map = validMap(); vm(resMap).mockResolvedValueOnce(map);
      vm(prepApp).mockResolvedValue({ ...scen.deliveryMocks.appendices, appendixHtml: "<b>Tracking Changes</b>\nNewly tracked: USDC", successActions: [{ key: "telegram:tracked-stablecoins-snapshot", value: '["usdc-circle"]' }], metadata: { ...scen.deliveryMocks.appendices.metadata, hasAppendix: true, trackedDetected: 1 } });
      await invoke();
      const binds = insBinds(scen.db as MockD1Database)!, orig = vm(enqTg).mock.calls[0]![1];
      vi.clearAllMocks();
      const db = mockD1([first("SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest", { generated_at: binds[0], digest_text: binds[1], digest_title: binds[2], input_data: binds[3], digest_extended: binds[4], digest_meta: binds[5] }), { match: "SELECT COUNT(*) as cnt FROM daily_digest", rows: [{ cnt: 1 }] }, first("SELECT state FROM telegram_digest_outbox", null)]);
      await resDigest(db, null, TG, map);
      expect(prepApp).toHaveBeenCalledTimes(1); expect(vm(enqTg).mock.calls[0]![1]).toEqual(orig);
    });

    it("preserves resume appendix failures and missing-credential diagnostics", async () => {
      const db = mkResDb([first("SELECT state FROM telegram_digest_outbox", null)]);
      vm(prepApp).mockRejectedValueOnce(new Error("appendix store down"));
      expect(await resDigest(db, null, TG, null)).toMatchObject({ telegramStatus: "ok" });
      expect(enqTg).toHaveBeenCalledWith(db, expect.objectContaining({ appendixHtml: null, successActions: [] }), undefined);
      expect(await resDigest(db, null, null, null, undefined, undefined, { twitterMissing: ["TWITTER_API_KEY"], telegramMissing: ["TELEGRAM_BOT_TOKEN"] })).toMatchObject({ tweetStatus: "skipped: no-creds", telegramStatus: "no-creds", deliveryComplete: false });
    });
  });

  describe("enrichment and ancillary publication", () => {
    const athDb = () => scenDb([first("ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC", { ath_value: 330e9, ath_date: 1_772_150_400 })]);

    it("stores a total-mcap ATH when the history query supplies one", async () => {
      const db = athDb();
      expect((await invoke(db)).itemCount).toBe(1);
      const inp = bindJson(db, 3);
      expect(inp.supplyCoverage).toEqual({ complete: true, observedCount: 2, unavailableCount: 0, memberFingerprint: fp });
      expect(inp.totalMcapAth).toMatchObject({ value: 330e9 }); expect(reqBody().messages[0].content).toContain("Digest-window ATH");
    });

    it("withholds ATH comparisons when current supply is unavailable but retains observed zero", async () => {
      const db = athDb(), src = scen.sourcePayload;
      if (src.kind !== "ok") throw new Error("Expected an admitted stablecoin fixture");
      const setSup = (circulating: Record<string, number>) => vm(loadCache).mockResolvedValueOnce({ ...src, payload: { ...src.payload, peggedAssets: src.payload.peggedAssets.map((c) => c.id === "usdc-circle" ? { ...c, circulating } : c) } });
      setSup({}); await invoke(db);
      expect(bindJson(db, 3).supplyCoverage).toEqual({ complete: false, observedCount: 1, unavailableCount: 1, memberFingerprint: fp });
      expect(reqBody().messages[0].content).not.toContain("Digest-window ATH");
      vm(fetchR).mockClear();
      const zDb = athDb(); setSup({ peggedUSD: 0 }); await invoke(zDb);
      expect(bindJson(zDb, 3).supplyCoverage).toEqual({ complete: true, observedCount: 2, unavailableCount: 0, memberFingerprint: fp });
      expect(reqBody().messages[0].content).toContain("Digest-window ATH");
    });

    it("keeps the momentum-candidate section in the model input", async () => {
      await invoke(); expect(reqBody().messages[0].content).toContain("Momentum Candidates");
    });
  });
});
