import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import type { CronProgressUpdate } from "../../lib/cron-logger";

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
vi.mock("../digest/telegram-transport", async (importOriginal) => (await import("./daily-digest.test-support")).mockTelegramDigestTransportModule(await importOriginal<typeof import("../digest/telegram-transport")>()));
vi.mock("../../lib/circuit-breaker", async () => (await import("./daily-digest.test-support")).mockDailyDigestCircuitBreakerModule());

import { generateDailyDigest, resumeDailyDigestDelivery } from "../daily-digest";
import { ANTHROPIC_TIMEOUT_MS, CIRCUIT_SOURCE, DIGEST_MODEL } from "../../lib/constants";
import { buildEditorialPrompt } from "@shared/lib/editorial-style";
import { ALLOWED_TONES } from "../daily-digest/response";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { loadActiveSafetyScoreCohort } from "../../lib/safety-score-active-source";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { postDigestTweet } from "../../lib/twitter";
import { resolveDigestSafetyMap } from "../../lib/digest-safety-map";
import { prepareTelegramDigestAppendices } from "../../telegram/digest/digest-appendices";
import { deliverTelegramDigestEdition, enqueueTelegramDigestEdition } from "../../telegram/outbox/digest-outbox";
import { runTelegramDigestDeliveryWithPermit } from "../digest/telegram-transport";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { DEPEG_LIFECYCLE_FLAGS_CACHE_KEY } from "../../lib/depeg-lifecycle";
import { ANTHROPIC_OK_TEXT, getInsertDigestBinds, makeDailyDigestScenario, makeRefusalResponse, makeStreamResponse, styleGateModeTables, VALID_CAPTURE_MAP_SUMMARY, VALID_DAILY_EXTENDED, withClauseDash, type DailyDigestScenario } from "./daily-digest.test-support";
import { publishedGaugePayload, publishedGaugeTable } from "./daily-digest.test-support";

const supplyMemberFingerprint = createHash("sha256")
  .update('["core-stablecoins-v1",["usdc-circle","usdt-tether"]]').digest("hex");
const CREDS = { apiKey: "x", apiSecret: "y", accessToken: "z", accessTokenSecret: "w" };
const TG = { botToken: "tg-token", chatId: "tg-chat" };
const SOFT_WARNING_TEXT = JSON.stringify({ title: "Drift", extended: VALID_DAILY_EXTENDED, text: "USDT's fixture depeg led the queue while PSI stayed at 91.2 BEDROCK.", meta: { leadSignalId: "depeg:usdt-tether:active", lead: "depeg", tone: "dry", coins: ["USDT", "USDC"], usedCandidateIds: ["depeg:usdt-tether:active"] } });
const SAFETY_FREE_TEXT = ANTHROPIC_OK_TEXT.replace("Safety scores stayed A for USDT and USDC, ", "Capital stayed concentrated in USDT and USDC, ");
const validMap = (date = "2026-03-06") => ({ kind: "available" as const, freshness: "current" as const, ageDays: 0, imageUrl: `https://pharos.watch/safety-scores/map.png?date=${date}`, manifest: { date, asOfSec: 1_788_000_000, renderedAtSec: 1_788_001_000, edition: "daily" as const, bytes: { png: 1_000_000 }, mapSummary: { ...VALID_CAPTURE_MAP_SUMMARY, date } } });
const bindJson = (db: MockD1Database, index: number) => JSON.parse(String(getInsertDigestBinds(db)?.[index]));
const firstRequestBody = () => JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[0]?.[1]?.body)) as { system: string; messages: Array<{ content: string }>; [key: string]: unknown };

let scenario: DailyDigestScenario;
const invoke = (db = scenario.db, forceRun = false, creds: typeof CREDS | null = CREDS, telegram: typeof TG | null = TG, reportProgress?: (update: CronProgressUpdate) => Promise<void>) => generateDailyDigest(db, "anthropic-key", creds, forceRun, telegram, undefined, reportProgress);

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  scenario = makeDailyDigestScenario();
  vi.mocked(loadStablecoinsCache).mockReset().mockResolvedValue(scenario.sourcePayload);
  vi.mocked(loadActiveSafetyScoreCohort).mockReset().mockResolvedValue(scenario.safetySource);
  vi.mocked(fetchWithRetry).mockReset().mockImplementation(async () => makeStreamResponse(scenario.modelResponse));
  vi.mocked(postDigestTweet).mockReset().mockResolvedValue(scenario.deliveryMocks.twitter);
  vi.mocked(enqueueTelegramDigestEdition).mockReset().mockResolvedValue(scenario.deliveryMocks.telegramEnqueue);
  vi.mocked(deliverTelegramDigestEdition).mockReset().mockResolvedValue(scenario.deliveryMocks.telegramDelivery);
  vi.mocked(prepareTelegramDigestAppendices).mockReset().mockResolvedValue(scenario.deliveryMocks.appendices);
  vi.mocked(shouldAttemptFetch).mockReset().mockResolvedValue(true);
  vi.mocked(recordOutcomeSafe).mockReset().mockResolvedValue(null);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("generateDailyDigest publication contract", () => {
  it("generates, stores, and delivers one mapped edition end to end", async () => {
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce(validMap());
    const result = await invoke();
    const db = scenario.db as MockD1Database; const input = bindJson(db, 3); const meta = bindJson(db, 5); const body = firstRequestBody();
    expect(result).toMatchObject({ itemCount: 1 }); expect(result.metadata).toContain("tweet: ok"); expect(result.metadata).toContain("telegram: ok");
    expect(input).toMatchObject({ aggregateUniverse: "core-stablecoins-v1", totalMcapUsd: 160_000_000, activeDepegCount: 1, safetyMap: { manifest: { date: "2026-03-06" } } });
    expect(input.resolvedDepegCount).toBe(0);
    expect(input.depegSignalKeys).toEqual({ active: [`usdt-tether:${Math.floor(Date.now() / 1000) - 3600}:active`], resolved: [] });
    expect(input.editorialAudit).toMatchObject({ leadCandidateId: "depeg:usdt-tether:active", usedCandidateIds: ["depeg:usdt-tether:active"] });
    expect(meta).toMatchObject({ styleGateMode: "shadow", editorialStyleGate: { mode: "shadow", firstPassWouldBlock: false }, llm: { model: DIGEST_MODEL, maxTokens: 16000, attempts: [{ attemptNumber: 1, inputTokens: 1000, outputTokens: 500, httpStatus: 200 }] } });
    expect(body.messages[0].content).toContain("Safety Map census (current; depicts 2026-03-06 UTC)");
    expect(postDigestTweet).toHaveBeenCalledTimes(1); expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1); expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
    expect(runTelegramDigestDeliveryWithPermit).toHaveBeenCalledWith(expect.objectContaining({ owner: "daily-digest", editionKey: "daily:2026-03-06" }));
    expect(fetchWithRetry).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-api-key": "anthropic-key" }) }), 0, { timeoutMs: 11 * 60_000, returnFinalResponse: true });
  });

  it("persists unavailable gauge provenance without breaking Telegram publication", async () => {
    const db = makeDailyDigestScenario({ db: { prependTables: [publishedGaugeTable({
      value: JSON.stringify(publishedGaugePayload({ gauge: { score: null, band: null, flightToQuality: false, flightIntensity: 0, partialValuationInputs: 0 } })),
    })] } }).db;
    const result = await invoke(db);
    expect(result.itemCount).toBe(1);
    const input = bindJson(db, 3);
    expect(input.mintBurnFlows).toBeUndefined();
    expect(input.degradedSources).toContain("mint-burn-gauge-unavailable");
    expect(input.dataQuality.degradedSources).toContain("mint-burn-gauge-unavailable");
    expect(firstRequestBody().messages[0].content).toContain("Market regime: WATCHFUL");
    expect(firstRequestBody().messages[0].content).toContain("mint-burn-gauge-unavailable");
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1);
    expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
  });

  it("sends the canonical streaming prompt contract without an attachment", async () => {
    await invoke(scenario.db, false, null, null);
    const body = firstRequestBody();
    expect(body).toMatchObject({ model: DIGEST_MODEL, thinking: { type: "adaptive" }, output_config: { effort: "high" }, max_tokens: 16000, fallbacks: "default", stream: true });
    expect(body.messages[0].content).toEqual(expect.stringContaining("Editorial Candidates"));
    expect(body.messages[0].content).toEqual(expect.stringContaining("Risk Tape"));
    expect(body.system.startsWith(buildEditorialPrompt("daily"))).toBe(true); expect(body.system).toContain(`Allowed tones: ${ALLOWED_TONES.join(", ")}.`); expect(body.system).toContain("CALM-DAY STORYTELLING");
    expect(body.messages[0].content).not.toContain("Safety Map census"); expect(bindJson(scenario.db as MockD1Database, 3).safetyMap).toBeUndefined();
  });

  it("keeps soft quality findings publishable and gates daily mode independently", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async () => makeStreamResponse(SOFT_WARNING_TEXT));
    const soft = await invoke(); expect(soft.itemCount).toBe(1); expect(soft.status, soft.metadata).toBeUndefined(); expect(fetchWithRetry).toHaveBeenCalledTimes(1); expect(postDigestTweet).toHaveBeenCalledTimes(1);
    expect(bindJson(scenario.db as MockD1Database, 3).dataQuality.degradedSources).toContain("mint-burn-gauge-missing");
    vi.clearAllMocks();
    vi.mocked(fetchWithRetry).mockReset().mockImplementation(async () => makeStreamResponse(withClauseDash(ANTHROPIC_OK_TEXT)));
    const shadowDb = makeDailyDigestScenario({ db: { prependTables: styleGateModeTables({ daily: "shadow", weekly: "enforce" }) } }).db;
    const shadow = await invoke(shadowDb); expect(shadow.itemCount).toBe(1); expect(fetchWithRetry).toHaveBeenCalledTimes(1); expect(bindJson(shadowDb, 5)).toMatchObject({ styleGateMode: "shadow", editorialStyleGate: { firstPassWouldBlock: true, retry: { outcome: "shadow-observed" } } });
    vi.clearAllMocks();
    vi.mocked(fetchWithRetry).mockReset().mockImplementation(async () => makeStreamResponse(withClauseDash(ANTHROPIC_OK_TEXT)));
    const enforceDb = makeDailyDigestScenario({ db: { prependTables: styleGateModeTables({ daily: "enforce", weekly: "shadow" }) } }).db;
    const blocked = await invoke(enforceDb); expect(blocked.status).toBe("degraded"); expect(fetchWithRetry).toHaveBeenCalledTimes(2); expect(postDigestTweet).not.toHaveBeenCalled(); expect(bindJson(enforceDb, 5)).toMatchObject({ qualityGate: "blocked", styleGateMode: "enforce", editorialStyleGate: { retry: { attempted: true, outcome: "unresolved" } } });
  });

  it("publishes hard style copy only after one successful correction", async () => {
    const db = makeDailyDigestScenario({ db: { prependTables: styleGateModeTables({ daily: "enforce", weekly: "shadow" }) } }).db;
    vi.mocked(fetchWithRetry)
      .mockResolvedValueOnce(makeStreamResponse(withClauseDash(ANTHROPIC_OK_TEXT)))
      .mockResolvedValueOnce(makeStreamResponse(ANTHROPIC_OK_TEXT));
    expect((await invoke(db)).itemCount).toBe(1);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(bindJson(db, 5)).toMatchObject({
      editorialStyleGate: { firstPassWouldBlock: true, retry: { attempted: true, outcome: "resolved" } },
    });
    expect(postDigestTweet).toHaveBeenCalledTimes(1);
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1);
  });

  it("does not retry advisory style findings in enforce mode", async () => {
    const db = makeDailyDigestScenario({ db: { prependTables: styleGateModeTables({ daily: "enforce", weekly: "shadow" }) } }).db;
    const advisory = JSON.parse(ANTHROPIC_OK_TEXT);
    advisory.text = "The plumbing flinched while USDT held near peg.";
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(makeStreamResponse(JSON.stringify(advisory)));
    expect((await invoke(db)).itemCount).toBe(1);
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(bindJson(db, 5)).toMatchObject({ editorialStyleGate: { firstPassWouldBlock: false } });
    expect(postDigestTweet).toHaveBeenCalledTimes(1);
  });

  it.each(["time", "token"] as const)("holds unresolved enforced style copy when the %s budget prevents correction", async (budget) => {
    const db = makeDailyDigestScenario({ db: { prependTables: styleGateModeTables({ daily: "enforce", weekly: "shadow" }) } }).db;
    vi.mocked(fetchWithRetry).mockImplementationOnce(async () => {
      if (budget === "time") vi.setSystemTime(new Date(Date.now() + ANTHROPIC_TIMEOUT_MS * 0.5 + 30_000));
      const response = makeStreamResponse(withClauseDash(ANTHROPIC_OK_TEXT));
      if (budget === "time") return response;
      return new Response((await response.text()).replace('"output_tokens":500', '"output_tokens":17000'), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    expect((await invoke(db)).status).toBe("degraded");
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(bindJson(db, 5)).toMatchObject({
      qualityGate: "blocked",
      editorialStyleGate: { firstPassWouldBlock: true, retry: { eligible: false, attempted: false, outcome: `skipped-${budget}-budget` } },
    });
    expect(postDigestTweet).not.toHaveBeenCalled();
    expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
  });

  it("retries a bound numeric contradiction once and holds the unrepaired edition", async () => {
    const contradictory = JSON.stringify({
      ...JSON.parse(ANTHROPIC_OK_TEXT),
      text: "USDT trades at $0.90, 150 bps below peg.",
    });
    vi.mocked(fetchWithRetry).mockImplementation(async () => makeStreamResponse(contradictory));
    const result = await invoke();
    expect(result.status).toBe("degraded");
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[1]?.[1]?.body));
    expect(JSON.stringify(retryBody.messages)).toContain("price-bps-mismatch");
    expect(bindJson(scenario.db as MockD1Database, 5)).toMatchObject({ qualityGate: "blocked" });
    expect(postDigestTweet).not.toHaveBeenCalled();
    expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
  });

  it("publishes the corrected numeric copy after the bounded retry", async () => {
    const response = JSON.parse(ANTHROPIC_OK_TEXT);
    vi.mocked(fetchWithRetry)
      .mockResolvedValueOnce(makeStreamResponse(JSON.stringify({ ...response, text: "USDT trades at $0.90, 150 bps below peg." })))
      .mockResolvedValueOnce(makeStreamResponse(JSON.stringify({ ...response, text: "USDT trades at $0.985, 150 bps below peg." })));
    const result = await invoke();
    expect(result.itemCount).toBe(1);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(bindJson(scenario.db as MockD1Database, 5)).not.toMatchObject({ qualityGate: "blocked" });
    expect(postDigestTweet).toHaveBeenCalledTimes(1);
    expect(getInsertDigestBinds(scenario.db as MockD1Database)?.[1]).toBe("USDT trades at $0.985, 150 bps below peg.");
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("binds an invented but self-consistent numeric pair to the observation; corrected=%s", async (corrected) => {
    const response = JSON.parse(ANTHROPIC_OK_TEXT);
    const falseCopy = JSON.stringify({ ...response, text: "USDT trades at $0.90, 1,000 bps below peg." });
    const repairedCopy = JSON.stringify({ ...response, text: "USDT trades at $0.99, 150 bps below peg." });
    vi.mocked(fetchWithRetry)
      .mockResolvedValueOnce(makeStreamResponse(falseCopy))
      .mockResolvedValueOnce(makeStreamResponse(corrected ? repairedCopy : falseCopy));
    const result = await invoke();
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String(vi.mocked(fetchWithRetry).mock.calls[1]?.[1]?.body));
    expect(JSON.stringify(retryBody.messages)).toContain("price-bps-observation-mismatch");
    if (corrected) {
      expect(result.itemCount).toBe(1);
      expect(getInsertDigestBinds(scenario.db as MockD1Database)?.[1]).toBe("USDT trades at $0.99, 150 bps below peg.");
      expect(postDigestTweet).toHaveBeenCalledTimes(1);
      expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1);
    } else {
      expect(result.status).toBe("degraded");
      expect(bindJson(scenario.db as MockD1Database, 5)).toMatchObject({ qualityGate: "blocked" });
      expect(postDigestTweet).not.toHaveBeenCalled();
      expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
      expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
    }
  });

  it("repairs malformed model output once, but skips repair after the time budget is spent", async () => {
    const malformed = '```json\n{"title":"Broken", "text":\n```';
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(makeStreamResponse(malformed));
    expect((await invoke()).itemCount).toBe(1); expect(fetchWithRetry).toHaveBeenCalledTimes(2); expect(bindJson(scenario.db as MockD1Database, 5).llm.attempts).toHaveLength(2);
    vi.mocked(fetchWithRetry).mockReset().mockImplementationOnce(async () => { vi.setSystemTime(new Date(Date.now() + ANTHROPIC_TIMEOUT_MS * 0.5 + 30_000)); return makeStreamResponse(malformed); });
    await invoke(); expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });

  it("bounds both legs by one LLM deadline so a slow corrective leg cannot outlive the lease", async () => {
    const malformed = '```json\n{"title":"Broken", "text":\n```';
    let markFirstRequestStarted!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => { markFirstRequestStarted = resolve; });
    vi.mocked(fetchWithRetry).mockReset()
      // First pass spends just under the corrective-retry time gate.
      .mockImplementationOnce(async () => {
        vi.advanceTimersByTime(ANTHROPIC_TIMEOUT_MS * 0.5 - 30_000);
        markFirstRequestStarted();
        return makeStreamResponse(malformed);
      })
      // The corrective leg stalls until its signal aborts. (Worker lib is
      // ES2021, so Promise.withResolvers is unavailable here.)
      .mockImplementationOnce(((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as never);
    const started = Date.now();
    let settledAfterMs: number | null = null;
    const generation = invoke().catch(() => undefined).finally(() => { settledAfterMs = Date.now() - started; });
    // Input fingerprinting uses real Web Crypto. Wait for collection to reach
    // the LLM before advancing its fake deadline, and always drain this run.
    await firstRequestStarted;
    await vi.advanceTimersByTimeAsync(ANTHROPIC_TIMEOUT_MS - (Date.now() - started));
    await generation;
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    // A per-leg budget would let the corrective leg run to 17.5 minutes, past
    // the 14-minute cron lease; the shared deadline stops both legs at 12.
    expect(settledAfterMs).not.toBeNull();
    expect(settledAfterMs!).toBeLessThanOrEqual(ANTHROPIC_TIMEOUT_MS);
  });

  it("retries bounded HTTP failures and records the circuit outcome", async () => {
    let markFirstRequestStarted!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => { markFirstRequestStarted = resolve; });
    vi.mocked(fetchWithRetry).mockImplementation(async () => {
      markFirstRequestStarted();
      return new Response("anthropic overloaded", { status: 529 });
    });
    const generation = expect(invoke()).rejects.toThrow("Claude API error 529: anthropic overloaded");
    await firstRequestStarted;
    await vi.runAllTimersAsync(); await generation;
    expect(recordOutcomeSafe).toHaveBeenCalledWith(scenario.db, CIRCUIT_SOURCE.ANTHROPIC, false); expect(fetchWithRetry).toHaveBeenCalledTimes(3);
  });

  it("handles missing keys, circuit open, refusal, and preflight cache gates", async () => {
    const progress: CronProgressUpdate[] = []; const result = await generateDailyDigest(scenario.db, null, null, false, null, undefined, async (update) => { progress.push(update); });
    expect(result).toMatchObject({ status: "skipped_neutral", itemCount: 0 }); expect(JSON.parse(result.metadata!)).toEqual({ reason: "missing-api-key" }); expect(progress).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "preflight" }), expect.objectContaining({ stage: "skipped" })]));
    expect(fetchWithRetry).not.toHaveBeenCalled(); expect(getInsertDigestBinds(scenario.db as MockD1Database)).toBeUndefined();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false); const circuit = await invoke();
    expect(circuit).toMatchObject({ status: "degraded", itemCount: 0 }); expect(JSON.parse(circuit.metadata!)).toEqual({ reason: "anthropic-circuit-open" });
    expect(fetchWithRetry).not.toHaveBeenCalled(); expect(getInsertDigestBinds(scenario.db as MockD1Database)).toBeUndefined(); expect(postDigestTweet).not.toHaveBeenCalled(); expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true); vi.mocked(fetchWithRetry).mockResolvedValueOnce(makeRefusalResponse()); const refusal = await invoke(); expect(refusal).toMatchObject({ status: "degraded", itemCount: 0 }); expect(refusal.metadata).toContain("anthropic-refusal"); expect(recordOutcomeSafe).not.toHaveBeenCalled();
    vi.clearAllMocks(); vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({ kind: "error", reason: "missing-cache", updatedAt: null }); expect((await invoke()).itemCount).toBe(0); expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it("skips a recent valid edition but regenerates an unpublishable recent row", async () => {
    const recent = mockD1([{ match: "SELECT generated_at, digest_text FROM daily_digest\n       WHERE", rows: [], first: { generated_at: Math.floor(Date.now() / 1000) - 20 * 60, digest_text: "Already generated" } }]);
    const skipped = await invoke(recent); expect(skipped).toMatchObject({ status: "skipped_neutral", itemCount: 0 }); expect(JSON.parse(skipped.metadata!)).toEqual({ reason: "recent-digest", ageSec: 20 * 60 }); expect(fetchWithRetry).not.toHaveBeenCalled();
    const malformedDb = makeDailyDigestScenario({ db: { prependTables: [{ match: "SELECT generated_at, digest_text FROM daily_digest\n       WHERE", rows: [], first: { generated_at: Math.floor(Date.now() / 1000) - 20 * 60, digest_text: "```json" } }] } }).db;
    expect((await invoke(malformedDb)).itemCount).toBe(1); expect(fetchWithRetry).toHaveBeenCalled();
  });

  it("fails before model generation when the input collection fails", async () => {
    const db = makeDailyDigestScenario({ db: { transformTables: (tables) => [...tables.filter((table) => table.match !== "SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?"), { match: "SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?", rows: [], throwError: new Error("D1 read failed") }] } }).db;
    await expect(invoke(db)).rejects.toThrow("D1 read failed"); expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it("blocks unbound safety copy, then repairs it when the second response is clean", async () => {
    vi.mocked(loadActiveSafetyScoreCohort).mockResolvedValue({ kind: "error", reason: "v9-snapshot-unavailable", detail: "identity mismatch", snapshot: null });
    const blocked = await invoke(); expect(blocked.status).toBe("degraded"); expect(bindJson(scenario.db as MockD1Database, 3).safetyScores).toBeUndefined(); expect(bindJson(scenario.db as MockD1Database, 5)).toMatchObject({ qualityGate: "blocked" }); expect(fetchWithRetry).toHaveBeenCalledTimes(2); expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    const clean = JSON.parse(ANTHROPIC_OK_TEXT) as { extended: string }; clean.extended = VALID_DAILY_EXTENDED.replace("Safety scores stayed A for USDT and USDC, ", "The fixture's primary risk inputs were unchanged, ");
    vi.clearAllMocks();
    const repairDb = makeDailyDigestScenario().db;
    vi.mocked(fetchWithRetry).mockReset().mockResolvedValueOnce(makeStreamResponse(ANTHROPIC_OK_TEXT)).mockResolvedValueOnce(makeStreamResponse(JSON.stringify({ ...JSON.parse(ANTHROPIC_OK_TEXT), extended: clean.extended })));
    const repaired = await invoke(repairDb);
    expect(repaired.itemCount).toBe(1);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(getInsertDigestBinds(repairDb)?.[4]).toBe(clean.extended);
    expect(bindJson(repairDb, 5)).not.toMatchObject({ qualityGate: "blocked" });
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(repairDb, expect.objectContaining({ extended: clean.extended }), undefined);
    expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
  });

  it("keeps persistence when collectors, wrappers, or social channels degrade", async () => {
    const brokenDb = makeDailyDigestScenario({ db: { transformTables: (tables) => tables.map((table) => table.match === "FROM depeg_events e LEFT JOIN depeg_event_provenance" ? { ...table, throwError: new Error("d1 unavailable") } : table) } }).db;
    const degraded = await invoke(brokenDb); expect(degraded).toMatchObject({ itemCount: 1, status: "degraded" }); expect(degraded.metadata).toContain("active-depegs-query");
    vi.mocked(prepareTelegramDigestAppendices).mockRejectedValueOnce(new Error("appendix store down")); expect((await invoke()).itemCount).toBe(1); const recovered = await invoke(); expect(recovered.status, recovered.metadata).toBeUndefined();
    vi.mocked(postDigestTweet).mockRejectedValueOnce(new Error("twitter down")); vi.mocked(deliverTelegramDigestEdition).mockRejectedValueOnce(new Error("telegram down")); const social = await invoke(); expect(social).toMatchObject({ itemCount: 1, status: "degraded" }); expect(getInsertDigestBinds(scenario.db as MockD1Database)).toBeDefined();
  });

  it("retains the pending depeg lifecycle queue when the active-depeg read fails", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { sqlite, db } = createLatestSchemaSqlite({
      onAll: (sql) => {
        if (sql.includes("FROM depeg_events e LEFT JOIN depeg_event_provenance")) throw new Error("D1 read failed");
      },
    });
    try {
      // A prior digest run flagged a stalled collapse; the owner has not
      // reviewed it yet. This is the row the runbook reads.
      const priorUpdatedAt = nowSec - 86_400;
      const priorFlags = [{
        stablecoinId: "usx-dforce", symbol: "USX", kind: "stalled-collapse",
        currentBps: -6_200, ageDays: 27, mcapUsd: 12_000_000,
      }];
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        DEPEG_LIFECYCLE_FLAGS_CACHE_KEY,
        JSON.stringify({ updatedAt: priorUpdatedAt, flags: priorFlags }),
        priorUpdatedAt,
      );

      const components = JSON.stringify({ severity: 2, breadth: 1, trend: 0, stressBreadth: 0 });
      const todayTs = nowSec - (nowSec % 86_400);
      sqlite.prepare(
        "INSERT INTO stability_index_samples (stored_at, score, band, components, input_snapshot) VALUES (?, ?, ?, ?, ?)",
      ).run(nowSec - 600, 91.2, "BEDROCK", components, "{}");
      sqlite.prepare(
        "INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (?, ?, ?, ?, ?)",
      ).run(todayTs, 89.5, "STEADY", components, "{}");

      const result = await generateDailyDigest(db, "anthropic-key", null, false, null);
      // The collector failure is non-fatal, so the run still publishes.
      expect(result.itemCount).toBe(1);
      expect(result.metadata).toContain("active-depegs-query");

      const row = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
        .get(DEPEG_LIFECYCLE_FLAGS_CACHE_KEY) as { value: string; updated_at: number } | undefined;
      expect(row).toBeDefined();
      const persisted = JSON.parse(String(row!.value)) as { updatedAt?: number; flags?: unknown };
      // R2: an unreadable active-depeg set may not be restated as a fresh
      // "nothing is pending" observation.
      expect(persisted).toEqual({ updatedAt: priorUpdatedAt, flags: priorFlags });
      expect(row!.updated_at).toBe(priorUpdatedAt);
    } finally {
      sqlite.close();
    }
  });

  it("isolates an editorially unsafe wrapper and preserves a literal cemetery appendix", async () => {
    vi.mocked(prepareTelegramDigestAppendices).mockResolvedValueOnce({ ...scenario.deliveryMocks.appendices, appendixHtml: "This wrapper is safe.", metadata: { ...scenario.deliveryMocks.appendices.metadata, hasAppendix: true, trackedDetected: 1 } });
    const wrapped = await invoke(scenario.db, false, CREDS, TG); const wrappedMeta = JSON.parse(String(wrapped.metadata));
    expect(fetchWithRetry).toHaveBeenCalledTimes(1); expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled(); expect(wrappedMeta.channels.telegram).toMatchObject({ status: "skipped: editorial-style-wrapper", disposition: "terminal-unsent" });
    vi.clearAllMocks(); vi.mocked(prepareTelegramDigestAppendices).mockResolvedValueOnce({ ...scenario.deliveryMocks.appendices, appendixHtml: "<b>New Cemetery Entries</b>\n\nThe market has finished another obituary for us.", metadata: { ...scenario.deliveryMocks.appendices.metadata, hasAppendix: true, cemeteryDetected: 1 } });
    const cemetery = await invoke(scenario.db, false, null, TG); expect(cemetery.itemCount).toBe(1); expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1); expect(JSON.parse(String(cemetery.metadata)).channels.telegram.disposition).toBe("delivered");
  });

  it("blocks a suppressed lead without publishing either channel", async () => {
    const nowSec = Math.floor(Date.now() / 1000); const suppressed = JSON.stringify({ title: "Pool Drains, Score Shrugs", extended: VALID_DAILY_EXTENDED, text: "USDC's measured DEX depth thinned while the composite score barely moved.", meta: { leadSignalId: "liquidity:usdc", lead: "liquidity", tone: "dry", coins: ["USDC"], usedCandidateIds: ["liquidity:usdc"] } });
    vi.mocked(fetchWithRetry).mockImplementation(async () => makeStreamResponse(suppressed));
    const db = makeDailyDigestScenario({ db: { prependTables: [{ match: "FROM dex_liquidity_history", rows: [{ stablecoin_id: "usdc-circle", liquidity_score: 60, total_tvl_usd: 80_000, snapshot_date: nowSec - 86_400, coverage_class: "primary", coverage_confidence: 0.9, methodology_version: "6.1" }, { stablecoin_id: "usdc-circle", liquidity_score: 70, total_tvl_usd: 90_000, snapshot_date: nowSec - 2 * 86_400, coverage_class: "primary", coverage_confidence: 0.9, methodology_version: "6.1" }] }] } }).db;
    const result = await invoke(db); expect(result.status).toBe("degraded"); expect(result.metadata).toContain("suppressed-lead"); expect(JSON.parse(String(getInsertDigestBinds(db as MockD1Database)?.[5]))).toMatchObject({ qualityGate: "blocked" }); expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
  });

  it("reports missing delivery credentials and handles unavailable maps", async () => {
    const result = await generateDailyDigest(scenario.db, "anthropic-key", null, false, null, undefined, undefined, { twitterMissing: ["TWITTER_API_KEY", "TWITTER_API_SECRET"], telegramMissing: ["TELEGRAM_BOT_TOKEN"] });
    expect(result.status).toBe("degraded"); expect(JSON.parse(result.metadata!)).toMatchObject({ channels: { twitter: { status: "skipped: no-creds", missingCredentialNames: ["TWITTER_API_KEY", "TWITTER_API_SECRET"] }, telegram: { status: "no-creds", missingCredentialNames: ["TELEGRAM_BOT_TOKEN"] } } });
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce({ kind: "unavailable", reason: "manifest-too-old" }); const textOnly = await invoke(); expect(textOnly.itemCount).toBe(1); expect(postDigestTweet).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Object), expect.any(Number), null, null, expect.any(Object));
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce({ kind: "unavailable", reason: "image-http-404" }); expect((await invoke(scenario.db, true)).itemCount).toBe(1);
  });

  it("keeps a valid map attachment while omitting unbound safety prose", async () => {
    vi.mocked(loadActiveSafetyScoreCohort).mockResolvedValue({ kind: "error", reason: "v9-snapshot-unavailable", detail: "identity mismatch", snapshot: null });
    vi.mocked(fetchWithRetry).mockImplementation(async () => makeStreamResponse(SAFETY_FREE_TEXT)); vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce(validMap());
    const result = await invoke(scenario.db, false, CREDS, TG); expect(result.status).toBe("degraded"); expect(result.metadata).not.toContain("unbound-safety-copy"); expect(postDigestTweet).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(Object), expect.any(Number), expect.stringContaining("date=2026-03-06"), null, expect.any(Object)); expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(scenario.db, expect.objectContaining({ mapImageUrl: expect.stringContaining("date=2026-03-06"), safetyContext: expect.objectContaining({ status: "unavailable" }) }), undefined);
  });
});

describe("delivery boundaries and resume", () => {
  it("claims Twitter before sending, retains unknown execution, and skips an existing claim", async () => {
    await invoke(); const key = "daily-digest:twitter-sent:2026-03-06"; const history = (scenario.db as MockD1Database).getHistory(); expect(history.filter((row) => row.sql.includes("INSERT OR IGNORE INTO cache") && row.binds[0] === key)).toHaveLength(1); expect(history.filter((row) => row.sql.includes("DELETE FROM cache") && row.binds[0] === key)).toHaveLength(0);
    const failedDb = makeDailyDigestScenario().db; vi.clearAllMocks(); vi.mocked(postDigestTweet).mockRejectedValueOnce(new Error("twitter down")); const failed = await invoke(failedDb); const unknownWrite = (failedDb as MockD1Database).getHistory().find((row) => row.sql.includes("UPDATE cache SET value") && row.binds[2] === key && String(row.binds[0]).includes('"state":"execution_unknown"')); expect(failed.metadata).toContain("tweet: failed:"); expect(unknownWrite).toBeDefined();
    const taken = makeDailyDigestScenario({ db: { prependTables: [{ match: "INSERT OR IGNORE INTO cache", rows: [], runMeta: { changes: 0 } }, { match: "SELECT value FROM cache WHERE key = ?", matchBinds: [key], rows: [], first: { value: JSON.stringify({ sentAt: 1, editionNumber: 1 }) } }] } }).db;
    vi.clearAllMocks();
    const skipped = await invoke(taken); expect(skipped.metadata).toContain("tweet: skipped: already-sent"); expect(postDigestTweet).not.toHaveBeenCalled();
  });

  it("continues Telegram after a Twitter marker failure and preserves outbox ordering", async () => {
    const db = makeDailyDigestScenario({ db: { prependTables: [{ match: "INSERT OR IGNORE INTO cache", rows: [], throwError: new Error("twitter marker down") }] } }).db;
    await expect(invoke(db)).rejects.toThrow("Twitter daily digest marker write failed"); expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1); expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1); expect(getInsertDigestBinds(db as MockD1Database)).toBeDefined();
  });

  it("keeps Telegram's immutable edition and retryable states durable", async () => {
    await invoke(scenario.db, false, null, TG); expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(scenario.db, expect.objectContaining({ editionKey: "daily:2026-03-06", digestKind: "daily", targetChatId: "tg-chat", title: "Calm Drift", extended: VALID_DAILY_EXTENDED, editionNumber: 1 }), undefined);
    vi.clearAllMocks(); vi.mocked(deliverTelegramDigestEdition).mockResolvedValueOnce({ editionKey: "daily:2026-03-06", state: "pending", outcome: "pending", chunksSent: 0, nextChunkIndex: 0, chunkCount: 1, errorClass: "rate_limit", retryAfterSec: 45 }); expect((await invoke()).metadata).toContain("telegram: failed:");
    vi.clearAllMocks(); vi.mocked(enqueueTelegramDigestEdition).mockRejectedValueOnce(new Error("outbox down")); await expect(invoke()).rejects.toThrow("Telegram daily digest outbox write failed"); expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
    vi.clearAllMocks(); vi.mocked(enqueueTelegramDigestEdition).mockResolvedValueOnce({ created: false, payloadMatched: false, editionKey: "daily:2026-03-06", state: "pending", chunks: ["previous exact edition"] }); expect((await invoke()).metadata).toContain("telegram-outbox-payload-mismatch");
  });

  it("does not degrade forced already-sent editions and leaves pending appendix actions uncommitted", async () => {
    vi.mocked(enqueueTelegramDigestEdition).mockResolvedValueOnce({ created: false, payloadMatched: false, editionKey: "daily:2026-03-06", state: "sent", chunks: ["previous exact edition"] }); vi.mocked(deliverTelegramDigestEdition).mockResolvedValueOnce({ editionKey: "daily:2026-03-06", state: "sent", outcome: "skipped", chunksSent: 0, nextChunkIndex: 1, chunkCount: 1, errorClass: null, retryAfterSec: null });
    const result = await invoke(scenario.db, true); expect(result.status, result.metadata).toBeUndefined(); expect(result.metadata).toContain("telegram: skipped: already-sent");
    const successActions = [{ key: "telegram:cemetery-snapshot", value: '["terrausd"]' }]; vi.mocked(prepareTelegramDigestAppendices).mockResolvedValueOnce({ ...scenario.deliveryMocks.appendices, appendixHtml: "<b>New Cemetery Entries</b>", metadata: { ...scenario.deliveryMocks.appendices.metadata, hasAppendix: true, cemeteryDetected: 1 }, successActions }); vi.mocked(deliverTelegramDigestEdition).mockResolvedValueOnce({ editionKey: "daily:2026-03-06", state: "pending", outcome: "pending", chunksSent: 0, nextChunkIndex: 0, chunkCount: 1, errorClass: "server_error", retryAfterSec: null });
    const pending = await invoke(); expect(pending.metadata).toContain("telegram: failed:"); expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(scenario.db, expect.objectContaining({ successActions }), undefined);
  });

  it("resumes a retryable X ledger and leaves the sent Telegram edition alone", async () => {
    const db = mockD1([
      { match: "SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest", rows: [], first: {
        generated_at: 1_772_798_400, digest_text: "Stored digest body.", digest_title: "Stored Title",
        digest_extended: "Stored extended body.", digest_meta: JSON.stringify({ leadSignalId: "depeg:usdt-tether:active", lead: "depeg", coins: ["USDT"] }),
        input_data: JSON.stringify({ totalMcapUsd: 100e9 }),
      } },
      { match: "SELECT COUNT(*) as cnt FROM daily_digest", rows: [{ cnt: 187 }] },
      { match: "SELECT state FROM telegram_digest_outbox", rows: [], first: { state: "sent" } },
      { match: "SELECT value FROM cache WHERE key = ?", rows: [], first: { value: JSON.stringify({
        schemaVersion: 1, state: "failed", attempts: 1, createdAt: 1, updatedAt: 1,
      }) } },
      { match: "INSERT OR IGNORE INTO cache", rows: [] },
      { match: "UPDATE cache SET value = ?", rows: [] },
    ]);
    const resumed = await resumeDailyDigestDelivery(db, CREDS, TG, validMap());
    expect(resumed).toEqual({ kind: "resumed", tweetStatus: "ok", telegramStatus: "outbox-sent", deliveryComplete: true });
    expect(postDigestTweet).toHaveBeenCalledWith("Stored Title", "Stored digest body.", expect.any(Object), 187, expect.any(String), null, expect.any(Object));
    expect(prepareTelegramDigestAppendices).not.toHaveBeenCalled();
    expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    const missing = mockD1([{ match: "SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest", rows: [], first: null }]);
    expect(await resumeDailyDigestDelivery(missing, CREDS, null, validMap())).toEqual({ kind: "no-publishable-digest" });
  });

  it.each(["pending", "sending", "sent", "execution_unknown", "failed_permanent"])(
    "never regenerates an existing daily %s payload when the map changes", async (state) => {
      const db = mockD1([
        { match: "SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest", rows: [], first: {
          generated_at: 1_772_798_400, digest_text: "Stored copy.", digest_title: "Stored", digest_extended: "Stored extended.",
          input_data: JSON.stringify({ safetyContext: { status: "available" }, safetyMap: { manifest: { date: "2026-03-05" } } }),
        } },
        { match: "SELECT COUNT(*) as cnt FROM daily_digest", rows: [{ cnt: 187 }] },
        { match: "SELECT state FROM telegram_digest_outbox", rows: [], first: { state } },
      ]);
      const result = await resumeDailyDigestDelivery(db, null, TG, validMap());
      expect(result).toMatchObject({ telegramStatus: `outbox-${state}`, deliveryComplete: state === "sent" });
      expect(prepareTelegramDigestAppendices).not.toHaveBeenCalled();
      expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
      expect(deliverTelegramDigestEdition).not.toHaveBeenCalled();
    },
  );

  it.each([null, JSON.stringify({ schemaVersion: 1, state: "execution_unknown", attempts: 1, createdAt: 1, updatedAt: 1 })])(
    "refuses daily X resume without known retryable ledger evidence (%s)", async (value) => {
      const db = mockD1([
        { match: "SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest", rows: [], first: {
          generated_at: 1_772_798_400, digest_text: "Stored copy.", digest_title: "Stored", digest_extended: "Stored extended.",
        } },
        { match: "SELECT COUNT(*) as cnt FROM daily_digest", rows: [{ cnt: 187 }] },
        { match: "SELECT value FROM cache WHERE key = ?", rows: [], first: value == null ? null : { value } },
      ]);
      expect(await resumeDailyDigestDelivery(db, CREDS, null, null)).toMatchObject({
        tweetStatus: "skipped: execution-unknown", deliveryComplete: false,
      });
      expect(postDigestTweet).not.toHaveBeenCalled();
    },
  );

  it("builds byte-identical new Telegram envelopes in generation and missing-outbox resume", async () => {
    const map = validMap();
    vi.mocked(resolveDigestSafetyMap).mockResolvedValueOnce(map);
    vi.mocked(prepareTelegramDigestAppendices).mockResolvedValue({
      ...scenario.deliveryMocks.appendices,
      appendixHtml: "<b>Tracking Changes</b>\nNewly tracked: USDC",
      successActions: [{ key: "telegram:tracked-stablecoins-snapshot", value: '["usdc-circle"]' }],
      metadata: { ...scenario.deliveryMocks.appendices.metadata, hasAppendix: true, trackedDetected: 1 },
    });
    await invoke();
    const binds = getInsertDigestBinds(scenario.db as MockD1Database)!;
    const original = vi.mocked(enqueueTelegramDigestEdition).mock.calls[0]![1];
    vi.clearAllMocks();
    const db = mockD1([
      { match: "SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest", rows: [], first: {
        generated_at: binds[0], digest_text: binds[1], digest_title: binds[2], input_data: binds[3], digest_extended: binds[4], digest_meta: binds[5],
      } },
      { match: "SELECT COUNT(*) as cnt FROM daily_digest", rows: [{ cnt: 1 }] },
      { match: "SELECT state FROM telegram_digest_outbox", rows: [], first: null },
    ]);
    await resumeDailyDigestDelivery(db, null, TG, map);
    expect(prepareTelegramDigestAppendices).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueTelegramDigestEdition).mock.calls[0]![1]).toEqual(original);
  });

  it("preserves resume appendix failures and missing-credential diagnostics", async () => {
    const db = mockD1([
      { match: "SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest", rows: [], first: {
        generated_at: 1_772_798_400, digest_text: "Stored copy.", digest_title: "Stored", digest_extended: "Stored extended.",
      } },
      { match: "SELECT COUNT(*) as cnt FROM daily_digest", rows: [{ cnt: 187 }] },
      { match: "SELECT state FROM telegram_digest_outbox", rows: [], first: null },
    ]);
    vi.mocked(prepareTelegramDigestAppendices).mockRejectedValueOnce(new Error("appendix store down"));
    expect(await resumeDailyDigestDelivery(db, null, TG, null)).toMatchObject({ telegramStatus: "ok" });
    expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(db, expect.objectContaining({
      appendixHtml: null, successActions: [],
    }), undefined);
    const missing = await resumeDailyDigestDelivery(db, null, null, null, undefined, undefined, {
      twitterMissing: ["TWITTER_API_KEY"], telegramMissing: ["TELEGRAM_BOT_TOKEN"],
    });
    expect(missing).toMatchObject({ tweetStatus: "skipped: no-creds", telegramStatus: "no-creds", deliveryComplete: false });
  });
});

describe("enrichment and ancillary publication", () => {
  it("stores a total-mcap ATH when the history query supplies one", async () => {
    const db = makeDailyDigestScenario({ db: { prependTables: [{ match: "ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC", first: { ath_value: 330e9, ath_date: 1_772_150_400 }, rows: [] }] } }).db;
    const result = await invoke(db);
    const input = bindJson(db as MockD1Database, 3);
    expect(result.itemCount).toBe(1);
    expect(input.supplyCoverage).toEqual({ complete: true, observedCount: 2, unavailableCount: 0, memberFingerprint: supplyMemberFingerprint });
    expect(input.totalMcapAth).toMatchObject({ value: 330e9 });
    expect(firstRequestBody().messages[0].content).toContain("Digest-window ATH");
  });

  it("withholds ATH comparisons when current supply is unavailable but retains observed zero", async () => {
    const db = makeDailyDigestScenario({ db: { prependTables: [{ match: "ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC", first: { ath_value: 330e9, ath_date: 1_772_150_400 }, rows: [] }] } }).db;
    const source = scenario.sourcePayload;
    if (source.kind !== "ok") throw new Error("Expected an admitted stablecoin fixture");
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      ...source,
      payload: { ...source.payload, peggedAssets: source.payload.peggedAssets.map((coin) => ({
        ...coin,
        circulating: coin.id === "usdc-circle" ? {} : coin.circulating,
      })) },
    });
    await invoke(db);
    expect(bindJson(db, 3).supplyCoverage).toEqual({ complete: false, observedCount: 1, unavailableCount: 1, memberFingerprint: supplyMemberFingerprint });
    expect(firstRequestBody().messages[0].content).not.toContain("Digest-window ATH");
    vi.mocked(fetchWithRetry).mockClear();
    const zeroDb = makeDailyDigestScenario({ db: { prependTables: [{ match: "ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC", first: { ath_value: 330e9, ath_date: 1_772_150_400 }, rows: [] }] } }).db;
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      ...source,
      payload: { ...source.payload, peggedAssets: source.payload.peggedAssets.map((coin) => ({
        ...coin,
        circulating: coin.id === "usdc-circle" ? { peggedUSD: 0 } : coin.circulating,
      })) },
    });
    await invoke(zeroDb);
    expect(bindJson(zeroDb, 3).supplyCoverage).toEqual({ complete: true, observedCount: 2, unavailableCount: 0, memberFingerprint: supplyMemberFingerprint });
    expect(firstRequestBody().messages[0].content).toContain("Digest-window ATH");
  });

  it("keeps the momentum-candidate section in the model input", async () => {
    await invoke(); expect(firstRequestBody().messages[0].content).toContain("Momentum Candidates");
  });
});
