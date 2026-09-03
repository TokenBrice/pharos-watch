import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import type { CronProgressUpdate } from "../../lib/cron-logger";

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
vi.mock("../../lib/telegram/digest-appendices", async () => (await import("./daily-digest.test-support")).mockDailyDigestAppendicesModule());
vi.mock("../../lib/telegram/digest-outbox", async () => (await import("./daily-digest.test-support")).mockDailyDigestOutboxModule());
vi.mock("../telegram-digest-transport", async (importOriginal) => (await import("./daily-digest.test-support")).mockTelegramDigestTransportModule(await importOriginal<typeof import("../telegram-digest-transport")>()));
vi.mock("../../lib/circuit-breaker", async () => (await import("./daily-digest.test-support")).mockDailyDigestCircuitBreakerModule());

import { generateDailyDigest, resumeDailyDigestDelivery } from "../daily-digest";
import { ANTHROPIC_TIMEOUT_MS, CIRCUIT_SOURCE, DIGEST_MODEL } from "../../lib/constants";
import { buildEditorialPrompt } from "@shared/lib/editorial-style";
import { ALLOWED_TONES } from "../daily-digest/response";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { postDigestTweet } from "../../lib/twitter";
import { resolveDigestSafetyMap } from "../../lib/digest-safety-map";
import { prepareTelegramDigestAppendices } from "../../lib/telegram/digest-appendices";
import { deliverTelegramDigestEdition, enqueueTelegramDigestEdition } from "../../lib/telegram/digest-outbox";
import { runTelegramDigestDeliveryWithPermit } from "../telegram-digest-transport";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { ANTHROPIC_OK_TEXT, getInsertDigestBinds, makeDailyDigestScenario, makeRefusalResponse, makeStreamResponse, styleGateModeTables, VALID_CAPTURE_MAP_SUMMARY, VALID_DAILY_EXTENDED, withClauseDash, type DailyDigestScenario } from "./daily-digest.test-support";

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
  vi.mocked(loadActiveSafetyScoreSource).mockReset().mockResolvedValue(scenario.safetySource);
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
    expect(input.editorialAudit).toMatchObject({ leadCandidateId: "depeg:usdt-tether:active", usedCandidateIds: ["depeg:usdt-tether:active"] });
    expect(meta).toMatchObject({ styleGateMode: "shadow", editorialStyleGate: { mode: "shadow", firstPassWouldBlock: false }, llm: { model: "claude-opus-5", maxTokens: 16000, attempts: [{ attemptNumber: 1, inputTokens: 1000, outputTokens: 500, httpStatus: 200 }] } });
    expect(body.messages[0].content).toContain("Safety Map census (current; depicts 2026-03-06 UTC)");
    expect(postDigestTweet).toHaveBeenCalledTimes(1); expect(enqueueTelegramDigestEdition).toHaveBeenCalledTimes(1); expect(deliverTelegramDigestEdition).toHaveBeenCalledTimes(1);
    expect(runTelegramDigestDeliveryWithPermit).toHaveBeenCalledWith(expect.objectContaining({ owner: "daily-digest", editionKey: "daily:2026-03-06" }));
    expect(fetchWithRetry).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "x-api-key": "anthropic-key" }) }), 0, { timeoutMs: 11 * 60_000, returnFinalResponse: true });
  });

  it("sends the canonical streaming prompt contract without an attachment", async () => {
    await invoke(scenario.db, false, null, null);
    const body = firstRequestBody();
    expect(body).toMatchObject({ model: DIGEST_MODEL, thinking: { type: "adaptive" }, output_config: { effort: "xhigh" }, max_tokens: 16000, fallbacks: "default", stream: true });
    expect(body.messages[0].content).toEqual(expect.stringContaining("Editorial Candidates"));
    expect(body.messages[0].content).toEqual(expect.stringContaining("Risk Tape"));
    expect(body.system.startsWith(buildEditorialPrompt("daily"))).toBe(true); expect(body.system).toContain(`Allowed tones: ${ALLOWED_TONES.join(", ")}.`); expect(body.system).toContain("CALM-DAY STORYTELLING");
    expect(body.messages[0].content).not.toContain("Safety Map census"); expect(bindJson(scenario.db as MockD1Database, 3).safetyMap).toBeUndefined();
  });

  it("keeps soft quality findings publishable and gates daily mode independently", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async () => makeStreamResponse(SOFT_WARNING_TEXT));
    const soft = await invoke(); expect(soft.itemCount).toBe(1); expect(soft.status).toBeUndefined(); expect(fetchWithRetry).toHaveBeenCalledTimes(1); expect(postDigestTweet).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    vi.mocked(fetchWithRetry).mockReset().mockImplementation(async () => makeStreamResponse(withClauseDash(ANTHROPIC_OK_TEXT)));
    const shadowDb = makeDailyDigestScenario({ db: { prependTables: styleGateModeTables({ daily: "shadow", weekly: "enforce" }) } }).db;
    const shadow = await invoke(shadowDb); expect(shadow.itemCount).toBe(1); expect(fetchWithRetry).toHaveBeenCalledTimes(1); expect(bindJson(shadowDb, 5)).toMatchObject({ styleGateMode: "shadow", editorialStyleGate: { firstPassWouldBlock: true, retry: { outcome: "shadow-observed" } } });
    vi.clearAllMocks();
    vi.mocked(fetchWithRetry).mockReset().mockImplementation(async () => makeStreamResponse(withClauseDash(ANTHROPIC_OK_TEXT)));
    const enforceDb = makeDailyDigestScenario({ db: { prependTables: styleGateModeTables({ daily: "enforce", weekly: "shadow" }) } }).db;
    const blocked = await invoke(enforceDb); expect(blocked.status).toBe("degraded"); expect(fetchWithRetry).toHaveBeenCalledTimes(2); expect(postDigestTweet).not.toHaveBeenCalled(); expect(bindJson(enforceDb, 5)).toMatchObject({ qualityGate: "blocked", styleGateMode: "enforce", editorialStyleGate: { retry: { attempted: true, outcome: "unresolved" } } });
  });

  it("repairs malformed model output once, but skips repair after the time budget is spent", async () => {
    const malformed = '```json\n{"title":"Broken", "text":\n```';
    vi.mocked(fetchWithRetry).mockResolvedValueOnce(makeStreamResponse(malformed));
    expect((await invoke()).itemCount).toBe(1); expect(fetchWithRetry).toHaveBeenCalledTimes(2); expect(bindJson(scenario.db as MockD1Database, 5).llm.attempts).toHaveLength(2);
    vi.mocked(fetchWithRetry).mockReset().mockImplementationOnce(async () => { vi.setSystemTime(new Date(Date.now() + ANTHROPIC_TIMEOUT_MS * 0.5 + 30_000)); return makeStreamResponse(malformed); });
    await invoke(); expect(fetchWithRetry).toHaveBeenCalledTimes(1);
  });

  it("retries bounded HTTP failures and records the circuit outcome", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async () => new Response("anthropic overloaded", { status: 529 }));
    const generation = expect(invoke()).rejects.toThrow("Claude API error 529: anthropic overloaded");
    await vi.runAllTimersAsync(); await generation;
    expect(recordOutcomeSafe).toHaveBeenCalledWith(scenario.db, CIRCUIT_SOURCE.ANTHROPIC, false); expect(fetchWithRetry).toHaveBeenCalledTimes(3);
  });

  it("handles missing keys, circuit open, refusal, and preflight cache gates", async () => {
    const progress: CronProgressUpdate[] = []; const result = await generateDailyDigest(scenario.db, null, null, false, null, undefined, async (update) => { progress.push(update); });
    expect(result.metadata).toBe("skipped: no API key"); expect(progress).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "preflight" }), expect.objectContaining({ stage: "skipped" })]));
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false); expect(await invoke()).toEqual({ status: "degraded", itemCount: 0, metadata: "skipped: anthropic circuit open" });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true); vi.mocked(fetchWithRetry).mockResolvedValueOnce(makeRefusalResponse()); const refusal = await invoke(); expect(refusal).toMatchObject({ status: "degraded", itemCount: 0 }); expect(refusal.metadata).toContain("anthropic-refusal"); expect(recordOutcomeSafe).not.toHaveBeenCalled();
    vi.clearAllMocks(); vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({ kind: "error", reason: "missing-cache", updatedAt: null }); expect((await invoke()).itemCount).toBe(0); expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it("skips a recent valid edition but regenerates an unpublishable recent row", async () => {
    const recent = mockD1([{ match: "SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1", rows: [], first: { generated_at: Math.floor(Date.now() / 1000) - 20 * 60, digest_text: "Already generated" } }]);
    expect(await invoke(recent)).toMatchObject({ metadata: "skipped: recent digest exists" }); expect(fetchWithRetry).not.toHaveBeenCalled();
    const malformedDb = makeDailyDigestScenario({ db: { prependTables: [{ match: "SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1", rows: [], first: { generated_at: Math.floor(Date.now() / 1000) - 20 * 60, digest_text: "```json" } }] } }).db;
    expect((await invoke(malformedDb)).itemCount).toBe(1); expect(fetchWithRetry).toHaveBeenCalled();
  });

  it("fails before model generation when the input collection fails", async () => {
    const db = makeDailyDigestScenario({ db: { transformTables: (tables) => [...tables.filter((table) => table.match !== "SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?"), { match: "SELECT AVG(score) as avg FROM stability_index_samples WHERE stored_at > ?", rows: [], throwError: new Error("D1 read failed") }] } }).db;
    await expect(invoke(db)).rejects.toThrow("D1 read failed"); expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it("blocks unbound safety copy, then repairs it when the second response is clean", async () => {
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValue({ kind: "error", reason: "v9-snapshot-unavailable", detail: "identity mismatch", snapshot: null });
    const blocked = await invoke(); expect(blocked.status).toBe("degraded"); expect(bindJson(scenario.db as MockD1Database, 3).safetyScores).toBeUndefined(); expect(bindJson(scenario.db as MockD1Database, 5)).toMatchObject({ qualityGate: "blocked" }); expect(fetchWithRetry).toHaveBeenCalledTimes(2); expect(enqueueTelegramDigestEdition).not.toHaveBeenCalled();
    const clean = JSON.parse(ANTHROPIC_OK_TEXT) as { extended: string }; clean.extended = VALID_DAILY_EXTENDED.replace("Safety scores stayed A for USDT and USDC, ", "The fixture's primary risk inputs were unchanged, ");
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValue(scenario.safetySource);
    vi.mocked(fetchWithRetry).mockReset().mockResolvedValueOnce(makeStreamResponse(ANTHROPIC_OK_TEXT)).mockResolvedValueOnce(makeStreamResponse(JSON.stringify({ ...JSON.parse(ANTHROPIC_OK_TEXT), extended: clean.extended })));
    const repaired = await invoke(); const digestWrites = (scenario.db as MockD1Database).getHistory().filter((row) => row.sql.includes("INSERT INTO daily_digest")); const lastDigestWrite = digestWrites[digestWrites.length - 1]; expect(repaired.itemCount).toBe(1); expect(JSON.parse(String(lastDigestWrite?.binds[5]))).not.toMatchObject({ qualityGate: "blocked" });
  });

  it("keeps persistence when collectors, wrappers, or social channels degrade", async () => {
    const brokenDb = makeDailyDigestScenario({ db: { transformTables: (tables) => tables.map((table) => table.match === "FROM depeg_events WHERE ended_at IS NULL" ? { ...table, throwError: new Error("d1 unavailable") } : table) } }).db;
    const degraded = await invoke(brokenDb); expect(degraded).toMatchObject({ itemCount: 1, status: "degraded" }); expect(degraded.metadata).toContain("active-depegs-query");
    vi.mocked(prepareTelegramDigestAppendices).mockRejectedValueOnce(new Error("appendix store down")); expect((await invoke()).itemCount).toBe(1); expect((await invoke()).status).toBeUndefined();
    vi.mocked(postDigestTweet).mockRejectedValueOnce(new Error("twitter down")); vi.mocked(deliverTelegramDigestEdition).mockRejectedValueOnce(new Error("telegram down")); const social = await invoke(); expect(social).toMatchObject({ itemCount: 1, status: "degraded" }); expect(getInsertDigestBinds(scenario.db as MockD1Database)).toBeDefined();
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
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValue({ kind: "error", reason: "v9-snapshot-unavailable", detail: "identity mismatch", snapshot: null });
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
    const result = await invoke(scenario.db, true); expect(result.status).toBeUndefined(); expect(result.metadata).toContain("telegram: skipped: already-sent");
    const successActions = [{ key: "telegram:cemetery-snapshot", value: '["terrausd"]' }]; vi.mocked(prepareTelegramDigestAppendices).mockResolvedValueOnce({ ...scenario.deliveryMocks.appendices, appendixHtml: "<b>New Cemetery Entries</b>", metadata: { ...scenario.deliveryMocks.appendices.metadata, hasAppendix: true, cemeteryDetected: 1 }, successActions, commitSuccess: vi.fn(async () => undefined) }); vi.mocked(deliverTelegramDigestEdition).mockResolvedValueOnce({ editionKey: "daily:2026-03-06", state: "pending", outcome: "pending", chunksSent: 0, nextChunkIndex: 0, chunkCount: 1, errorClass: "server_error", retryAfterSec: null });
    const pending = await invoke(); expect(pending.metadata).toContain("telegram: failed:"); expect(enqueueTelegramDigestEdition).toHaveBeenCalledWith(scenario.db, expect.objectContaining({ successActions }), undefined);
  });

  it("resumes an existing publishable edition and reports an unresolved resume", async () => {
    const db = mockD1([{ match: "SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest", rows: [], first: { generated_at: 1_772_798_400, digest_text: "Stored digest body.", digest_title: "Stored Title", digest_extended: "Stored extended body.", digest_meta: JSON.stringify({ leadSignalId: "depeg:usdt-tether:active", lead: "depeg", coins: ["USDT"] }), input_data: JSON.stringify({ totalMcapUsd: 100e9 }) } }, { match: "SELECT COUNT(*) as cnt FROM daily_digest", rows: [{ cnt: 187 }], first: { cnt: 187 } }, { match: "SELECT state FROM telegram_digest_outbox", rows: [], first: { state: "sent" } }, { match: "INSERT OR IGNORE INTO cache", rows: [] }, { match: "UPDATE cache SET value = ?", rows: [] }]);
    const resumed = await resumeDailyDigestDelivery(db, CREDS, TG, validMap()); expect(resumed).toEqual({ kind: "resumed", tweetStatus: "ok", telegramStatus: "outbox-sent", deliveryComplete: true }); expect(postDigestTweet).toHaveBeenCalledWith("Stored Title", "Stored digest body.", expect.any(Object), 187, expect.any(String), null, expect.any(Object));
    const missing = mockD1([{ match: "SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest", rows: [], first: null }]); expect(await resumeDailyDigestDelivery(missing, CREDS, null, validMap())).toEqual({ kind: "no-publishable-digest" });
  });
});

describe("enrichment and ancillary publication", () => {
  it("stores a total-mcap ATH when the history query supplies one", async () => {
    const db = makeDailyDigestScenario({ db: { prependTables: [{ match: "ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC", first: { ath_value: 330e9, ath_date: 1_772_150_400 }, rows: [] }] } }).db;
    const result = await invoke(db); expect(result.itemCount).toBe(1); expect(bindJson(db as MockD1Database, 3).totalMcapAth).toMatchObject({ value: 330e9 }); expect(firstRequestBody().messages[0].content).toContain("Digest-window ATH");
  });

  it("keeps the momentum-candidate section in the model input", async () => {
    await invoke(); expect(firstRequestBody().messages[0].content).toContain("Momentum Candidates");
  });
});
