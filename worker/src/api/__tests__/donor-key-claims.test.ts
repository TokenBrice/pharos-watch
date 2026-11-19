import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { buildDonorClaimSiweMessage } from "@shared/lib/donor-key-claim";
import { DonorKeyClaimResponseSchema } from "@pharos/contracts/api-keys";
import type { DatabaseSync } from "node:sqlite";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateAccessGate, evaluateCachedPublicApiReadFastGate } from "../../handlers/http/gates";
import { rotateApiKey } from "../../lib/api-key-admin";
import { authenticateApiKey } from "../../lib/api-key-auth";
import { resetApiKeyStateForTests } from "../../lib/api-key-core";
import { loadActiveSafetyScoreIndex } from "../../lib/safety-score-index";
import { makeJsonRequest } from "../../test-helpers/__shared/auth";
import { createWorkerEnv } from "../../test-helpers/__shared/worker-env";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { handleDonorKeyClaim } from "../donor-key-claims";

vi.mock("../../lib/safety-score-index", () => ({
  loadActiveSafetyScoreIndex: vi.fn(),
}));

const claimSwitch = vi.hoisted(() => ({ open: true }));
// Exercise issuance independently from the production pause switch.
vi.mock("@shared/lib/public-api-contract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/lib/public-api-contract")>()),
  get DONOR_KEY_CLAIMS_OPEN() { return claimSwitch.open; },
}));

// $11 across two chains and exactly $10 qualify; ETH and pool payouts do not. The last
// two rows postdate DONOR_API_KEY_TERMS_START_SEC, so they buy 45 and 30 days.
vi.mock("@shared/data/funding/donations.json", () => {
  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const row = (tx_hash: string, block_timestamp: number, from_address: string, usd: number, extra: object = {}) => ({
    chain: "ethereum", tx_hash, block_timestamp, from_address, display: from_address, kind: "community",
    asset_symbol: "USDC", token_address: USDC, amount_decimal: usd, usd_at_receipt: usd, price_note: "stablecoin-par", ...extra,
  });
  return {
    default: {
      last_updated_at: 1788681300,
      donations: [
        row("0xaa01", 1776072647, "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", 5),
        row("0xaa02", 1776172647, "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", 6, {
          chain: "base", token_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        }),
        row("0xbb01", 1776272647, "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", 10),
        row("0xbb02", 1776282647, "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65", 9.99),
        row("0xdd01", 1776372647, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", 2000, {
          asset_symbol: "ETH", token_address: null, amount_decimal: 1, price_note: "receipt-time price",
        }),
        row("0xcc01", 1776372647, "0x90f79bf6eb2c4f870365e785982e1f101e93b906", 50, {
          chain: "gnosis", kind: "pool", token_address: "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83",
        }),
        row("0x" + "ee".repeat(32), 1794877200, "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc", 15, { transfer_discriminator: "log:1", legacy_credit: true }),
        row("0x" + "ee".repeat(32), 1794880800, "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc", 10, { transfer_discriminator: "log:2" }),
      ],
    },
  };
});

const LEDGER_UPDATED_AT = 1788681300;
const NOW_SEC = 1788681600;
const PEPPER = "donor-claim-pepper";
const CLAIM_URL = "https://api.pharos.watch/api/donor-key-claims";

const donorAccount = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const thresholdAccount = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const belowThresholdAccount = privateKeyToAccount(
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
);
const poolAccount = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const strangerAccount = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const termAccount = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const TERM_DONATION_SEC = 1_794_877_200;

const allowLimiter: RateLimit = { limit: async () => ({ success: true }) };
const denyLimiter: RateLimit = { limit: async () => ({ success: false }) };

let sqlite: DatabaseSync;
let db: D1Database;

function claimMessage(
  account: typeof donorAccount,
  { nonce = "abcdefghijklmnop", issuedAtSec = NOW_SEC }: { nonce?: string; issuedAtSec?: number } = {},
): string {
  return buildDonorClaimSiweMessage({
    address: account.address,
    nonce,
    issuedAt: new Date(issuedAtSec * 1000),
  });
}

async function claim(
  message: string,
  options: {
    signer?: typeof donorAccount;
    signature?: string;
    limiter?: RateLimit | undefined;
    pepper?: string | undefined;
    nowSec?: number;
  } = {},
): Promise<Response> {
  // Key presence, not `??`: the missing-binding cases pass `undefined` on purpose.
  const limiter = "limiter" in options ? options.limiter : allowLimiter;
  const pepper = "pepper" in options ? options.pepper : PEPPER;
  const signer = options.signer ?? donorAccount;
  const body = { message, signature: options.signature ?? (await signer.signMessage({ message })) };
  return handleDonorKeyClaim(db, makeJsonRequest(CLAIM_URL, body), { rateLimiter: limiter, pepper }, options.nowSec ?? NOW_SEC);
}

async function issuedKey(response: Response) {
  const payload = DonorKeyClaimResponseSchema.parse(await response.json());
  if (payload.status !== "issued") throw new Error(`expected an issued key, got ${payload.status}`);
  return payload;
}

function gradeCards(cards: NonNullable<Parameters<typeof makeReportCardsV9Response>[0]>["cards"]) {
  return vi.mocked(loadActiveSafetyScoreIndex).mockResolvedValue({ kind: "v9", snapshot: makeReportCardsV9Response({ cards }) });
}

/** A database whose statements containing `fragment` throw; `state.failed` records that one did. */
function failingOn(fragment: string) {
  const state = { failed: false };
  const failing = createSqliteD1(sqlite, { onRun(sql) { if (sql.includes(fragment)) { state.failed = true; throw new Error("injected failure"); } } });
  return { failing, state };
}

function countApiKeys(): number {
  return (sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }).n;
}

beforeEach(() => {
  claimSwitch.open = true;
  resetApiKeyStateForTests();
  vi.mocked(loadActiveSafetyScoreIndex).mockReset();
  gradeCards([makeWorkerV9Card({ id: "usdc-circle", grade: "B" })]);
  ({ sqlite, db } = createLatestSchemaSqlite());
});

afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});

describe("POST /api/donor-key-claims", () => {
  it("rejects paused claims before reading the body or spending the limiter", async () => {
    claimSwitch.open = false;
    const limit = vi.fn();
    const response = await handleDonorKeyClaim(db, new Request(CLAIM_URL, { method: "POST", body: "bad" }), {
      rateLimiter: { limit }, pepper: PEPPER,
    }, NOW_SEC);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ reason: "claims_closed" });
    expect(limit).not.toHaveBeenCalled();
    expect(countApiKeys()).toBe(0);
  });

  it.each([
    [donorAccount, 503, "grade_unavailable"],
    [belowThresholdAccount, 403, "ineligible"],
    [poolAccount, 403, "ineligible"],
  ] as const)("distinguishes unavailable grades from insufficient donations for %s", async (account, status, reason) => {
    gradeCards([]);
    const response = await claim(claimMessage(account), { signer: account });
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    if (status === 503) expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({ reason });
    expect(countApiKeys()).toBe(0);
  });

  it.each(["not-json", JSON.stringify({ message: "missing signature" })])("rejects an invalid JSON body without issuing a key", async (body) => {
    const response = await handleDonorKeyClaim(db, new Request(CLAIM_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    }), { rateLimiter: allowLimiter, pepper: PEPPER }, NOW_SEC);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "body_invalid" });
    expect(countApiKeys()).toBe(0);
  });

  it("issues one donor key for an eligible wallet and records the claim", async () => {
    const response = await claim(claimMessage(donorAccount));

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = await issuedKey(response);
    expect(payload.key.rateLimitPerMinute).toBe(10);
    expect(payload.key.expiresAt).toBeNull();

    const address = donorAccount.address.toLowerCase();
    expect(sqlite.prepare("SELECT tier, rate_limit_per_minute, expires_at, owner_email, name FROM api_keys").get()).toEqual({
      tier: "donor", rate_limit_per_minute: 10, expires_at: null, owner_email: null, name: `donor ${address}`,
    });
    expect(sqlite.prepare("SELECT * FROM api_key_donor_claims").get()).toEqual({ address, key_prefix: payload.key.keyPrefix, claimed_at: NOW_SEC });
    // The threshold is inclusive: exactly $10 also earns a key.
    expect((await claim(claimMessage(thresholdAccount), { signer: thresholdAccount })).status).toBe(201);

    const auditRow = sqlite
      .prepare("SELECT action, actor, detail_json FROM api_key_audit_log")
      .get() as { action: string; actor: string; detail_json: string };
    expect(auditRow).toMatchObject({ action: "created", actor: "donor-claim" });
    // The audit log is retained indefinitely; the address lives only on the claim row and key name.
    expect(auditRow.detail_json).not.toContain(donorAccount.address.slice(2, 12).toLowerCase());
  });

  it("treats pipeline-gap donations as temporarily unavailable rather than outside the grade band", async () => {
    gradeCards([makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc-circle" })]);
    const response = await claim(claimMessage(donorAccount));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: "grade_unavailable" });
    expect(countApiKeys()).toBe(0);
  });

  it.each(["C", "NR"] as const)("excludes donations when the current grade is %s", async (grade) => {
    gradeCards([makeWorkerV9Card({ id: "usdc-circle", grade })]);
    const response = await claim(claimMessage(donorAccount));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ reason: "ineligible", qualifyingUsd: 0, countedAssets: [] });
    expect(countApiKeys()).toBe(0);
  });

  it.each(["held", "error"] as const)("fails closed when current grades are %s", async (kind) => {
    vi.mocked(loadActiveSafetyScoreIndex).mockResolvedValue(kind === "held" ? {
      kind, reason: "v9-publication-held", detail: "held", snapshot: makeReportCardsV9Response(),
    } : {
      kind, reason: "v9-snapshot-unavailable", detail: "unavailable", snapshot: null,
    });

    const response = await claim(claimMessage(donorAccount));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ reason: "safety_scores_unavailable" });
    expect(countApiKeys()).toBe(0);
  });

  it("preserves issued access and terminal replay after a grade downgrade", async () => {
    const payload = await issuedKey(await claim(claimMessage(donorAccount)));
    vi.mocked(loadActiveSafetyScoreIndex).mockClear();
    gradeCards([makeWorkerV9Card({ id: "usdc-circle", grade: "C" })]);

    await expect(authenticateApiKey(db, payload.token, PEPPER)).resolves.toMatchObject({ kind: "valid" });
    expect((await claim(claimMessage(donorAccount, { nonce: "downgradereplay1" }))).status).toBe(409);
    expect(loadActiveSafetyScoreIndex).not.toHaveBeenCalled();
    sqlite.exec("UPDATE api_keys SET is_active = 0");
    expect((await claim(claimMessage(donorAccount, { nonce: "downgradereplay2" }))).status).toBe(403);
    expect(loadActiveSafetyScoreIndex).not.toHaveBeenCalled();
  });

  it("credits each later donation once: a live key grows from its expiry, a lapsed one from the signature", async () => {
    const DAY = 86_400;
    const at0 = TERM_DONATION_SEC + 3 * 3600;
    const sign = (nonce: string, at: number) => claim(claimMessage(termAccount, { nonce, issuedAtSec: at }), { signer: termAccount, nowSec: at });
    const extendedTo = async (response: Response) => DonorKeyClaimResponseSchema.parse(await response.json()).key.expiresAt;
    // As if the $10 row was listed after the claim, with the key at the given expiry.
    const uncredit = (expiresAt: number) => sqlite.exec(
      `DELETE FROM api_key_donor_transfer_credits WHERE transfer_discriminator = 'log:2'; UPDATE api_keys SET expires_at = ${expiresAt}`,
    );

    const issued = await issuedKey(await sign("termclaim0000001", at0));
    expect(issued.key.expiresAt).toBe(at0 + 75 * DAY); // $15 + $10
    await expect((await sign("termreplay000001", at0)).json()).resolves.toMatchObject({ reason: "claim_exists" });
    // A rolled-back writer retains only the original transaction credit.
    sqlite.exec("DELETE FROM api_key_donor_transfer_credits");
    uncredit(at0 + 45 * DAY);
    const attempts = await Promise.all([sign("termextend000001", at0 + 120), sign("termextend000004", at0 + 120)]);
    expect(attempts.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(await extendedTo(attempts.find(({ status }) => status === 200)!)).toBe(at0 + 75 * DAY);
    uncredit(at0 + 60);
    const later = at0 + 180;
    expect(await extendedTo(await sign("termextend000002", later))).toBe(later + 30 * DAY);
    expect((await sign("termextend000003", later)).status).toBe(409);
    expect(countApiKeys()).toBe(1);
    resetApiKeyStateForTests();
    await expect(authenticateApiKey(db, issued.token, PEPPER, undefined, later)).resolves.toMatchObject({ kind: "valid" });
  });

  it("enforces the issued donor key's ten-request minute quota through the access gate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const payload = await issuedKey(await claim(claimMessage(donorAccount)));
    expect(payload.key.expiresAt).toBeNull();
    const env = createWorkerEnv({ DB: db, API_KEY_HASH_PEPPER: PEPPER });
    const request = new Request("https://api.pharos.watch/api/stablecoins", {
      headers: { "X-API-Key": payload.token },
    });
    const url = new URL(request.url);

    for (let index = 0; index < 10; index++) {
      const gate = await evaluateAccessGate(request, url, env);
      expect(gate.response).toBeNull();
      expect(gate.apiKey).toMatchObject({ tier: "donor", rateLimitPerMinute: 10 });
      // Even after authentication warms the cache, a cached response cannot
      // bypass the shared D1 quota through the isolate-only fast gate.
      expect(await evaluateCachedPublicApiReadFastGate(request, url, env)).toBeNull();
    }
    const blocked = await evaluateAccessGate(request, url, env);
    expect(blocked.response?.status).toBe(429);
    expect(blocked.response?.headers.get("Retry-After")).toBe("60");

    vi.setSystemTime((NOW_SEC + 60) * 1000);
    expect((await evaluateAccessGate(request, url, env)).response).toBeNull();
  });

  it("keeps the wallet mapped to its key across an admin rotation", async () => {
    const payload = await issuedKey(await claim(claimMessage(donorAccount)));
    const { id } = sqlite.prepare("SELECT id FROM api_keys WHERE key_prefix = ?").get(payload.key.keyPrefix) as { id: number };
    const rotated = await rotateApiKey(db, PEPPER, id, NOW_SEC + 60);
    expect(rotated).not.toBeInstanceOf(Response);

    const claimRow = sqlite.prepare("SELECT key_prefix FROM api_key_donor_claims").get() as { key_prefix: string };
    expect(claimRow.key_prefix).toBe((rotated as { key: { keyPrefix: string } }).key.keyPrefix);
    expect((await claim(claimMessage(donorAccount, { nonce: "dddddddddddddddd" }))).status).toBe(409);
  });

  it.each(["UPDATE api_key_donor_claims", "UPDATE api_keys"])("rolls back rotation when %s fails", async (failingSql) => {
    const payload = await issuedKey(await claim(claimMessage(donorAccount)));
    const original = sqlite.prepare("SELECT * FROM api_keys").get() as { id: number };
    const flaky = createSqliteD1(sqlite, {
      onRun(sql) {
        if (sql.startsWith(failingSql)) throw new Error("injected rotation failure");
      },
    });

    await expect(rotateApiKey(flaky, PEPPER, original.id, NOW_SEC + 60)).rejects.toThrow("injected rotation failure");

    expect(sqlite.prepare("SELECT * FROM api_keys").get()).toEqual(original);
    expect(sqlite.prepare("SELECT key_prefix FROM api_key_donor_claims").get()).toEqual({
      key_prefix: payload.key.keyPrefix,
    });
    const rotated = await rotateApiKey(db, PEPPER, original.id, NOW_SEC + 120);
    expect(rotated).not.toBeInstanceOf(Response);
    expect(sqlite.prepare("SELECT key_prefix FROM api_key_donor_claims").get()).toEqual({
      key_prefix: (rotated as { key: { keyPrefix: string } }).key.keyPrefix,
    });
  });

  it("lets only one concurrent rotation win and keeps the donor mapping attached", async () => {
    await claim(claimMessage(donorAccount));
    const { id } = sqlite.prepare("SELECT id FROM api_keys").get() as { id: number };

    const rotations = await Promise.all([
      rotateApiKey(db, PEPPER, id, NOW_SEC + 60),
      rotateApiKey(db, PEPPER, id, NOW_SEC + 60),
    ]);

    const conflicts = rotations.filter((result) => result instanceof Response);
    expect(conflicts).toHaveLength(1);
    expect((conflicts[0] as Response).status).toBe(409);
    expect(sqlite.prepare("SELECT key_prefix FROM api_key_donor_claims").get()).toEqual(
      sqlite.prepare("SELECT key_prefix FROM api_keys WHERE id = ?").get(id),
    );
  });

  it.each([
    ["an orphaned claim whose key row is gone", "DELETE FROM api_keys", 409, "claim_orphaned", 0],
    ["a key an operator deactivated", "UPDATE api_keys SET is_active = 0", 403, "claim_revoked", 1],
  ] as const)("keeps %s terminal", async (_label, sql, status, reason, keys) => {
    expect((await claim(claimMessage(donorAccount))).status).toBe(201);
    sqlite.exec(sql);
    const response = await claim(claimMessage(donorAccount, { nonce: "eeeeeeeeeeeeeeee" }));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ reason });
    expect(countApiKeys()).toBe(keys);
  });

  it("still returns the token when the post-commit id lookup fails", async () => {
    // D1 fails at execution time, not at prepare(): reject on first().
    const flaky = {
      ...db,
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!sql.startsWith("SELECT id FROM api_keys")) return statement;
        return {
          ...statement,
          bind: (...args: unknown[]) => ({
            ...statement.bind(...args),
            first: async () => { throw new Error("simulated D1 outage after commit"); },
          }),
        } as unknown as D1PreparedStatement;
      },
    } as D1Database;

    const response = await handleDonorKeyClaim(
      flaky,
      makeJsonRequest(CLAIM_URL, {
        message: claimMessage(donorAccount),
        signature: await donorAccount.signMessage({ message: claimMessage(donorAccount) }),
      }),
      { rateLimiter: allowLimiter, pepper: PEPPER },
      NOW_SEC,
    );

    expect(response.status).toBe(201);
    expect(countApiKeys()).toBe(1);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM api_key_audit_log").get() as { n: number }).n).toBe(0);
    const payload = await issuedKey(response);
    await expect(authenticateApiKey(db, payload.token, PEPPER)).resolves.toMatchObject({ kind: "valid" });
  });

  it("rolls back an issuance outage and allows a clean retry", async () => {
    const { failing, state } = failingOn("INSERT INTO api_key_donor_claims");
    db = failing;
    const failedResponse = await claim(claimMessage(donorAccount));
    expect(failedResponse.status).toBe(503);
    await expect(failedResponse.json()).resolves.toMatchObject({ reason: "issue_failed" });
    expect(state.failed).toBe(true);
    expect(countApiKeys()).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM api_key_donor_claims").get()).toEqual({ n: 0 });
    db = createSqliteD1(sqlite);
    const response = await claim(claimMessage(donorAccount));
    expect(response.status).toBe(201);
    const payload = await issuedKey(response);
    await expect(authenticateApiKey(db, payload.token, PEPPER)).resolves.toMatchObject({ kind: "valid" });
  });

  it("preserves the issued token when audit insertion fails", async () => {
    const { failing, state } = failingOn("INSERT INTO api_key_audit_log");
    db = failing;
    const response = await claim(claimMessage(donorAccount));
    expect(response.status).toBe(201);
    expect(state.failed).toBe(true);
    const payload = await issuedKey(response);
    await expect(authenticateApiKey(db, payload.token, PEPPER)).resolves.toMatchObject({ kind: "valid" });
    expect(countApiKeys()).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM api_key_donor_claims").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM api_key_audit_log").get()).toEqual({ n: 0 });
  });

  it.each([
    ["the rate limit binding throws", { limiter: { limit: async () => { throw new Error("binding unavailable"); } } as RateLimit }, "rate_limit_unavailable"],
    ["the rate limit binding is missing", { limiter: undefined }, "rate_limiter_missing"],
    ["the API key pepper is unset", { pepper: undefined }, "pepper_missing"],
  ] as const)("answers 503 when %s", async (_label, options, reason) => {
    const response = await claim(claimMessage(donorAccount), options);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason });
    expect(countApiKeys()).toBe(0);
  });

  it("answers 409 on a replayed message without issuing a second key", async () => {
    const message = claimMessage(donorAccount);
    const signature = await donorAccount.signMessage({ message });

    expect((await claim(message, { signature })).status).toBe(201);
    const replay = await claim(message, { signature });

    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ reason: "claim_exists" });
    expect(countApiKeys()).toBe(1);
  });

  it("issues exactly one key when two first claims race", async () => {
    const [first, second] = await Promise.all([
      claim(claimMessage(donorAccount, { nonce: "aaaaaaaaaaaaaaaa" })),
      claim(claimMessage(donorAccount, { nonce: "bbbbbbbbbbbbbbbb" })),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(countApiKeys()).toBe(1);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM api_key_donor_claims").get() as { n: number }).n).toBe(1);
  });

  it.each([
    ["a wallet below $10, with the ledger date", belowThresholdAccount, { ledgerUpdatedAt: LEDGER_UPDATED_AT, qualifyingUsd: 9.99, countedAssets: ["USDC"] }],
    ["non-stablecoin donations above $10", strangerAccount, { qualifyingUsd: 0, countedAssets: [] }],
    ["pool payout senders", poolAccount, { ledgerUpdatedAt: LEDGER_UPDATED_AT }],
  ] as const)("answers 403 ineligible for %s", async (_label, account, body) => {
    const response = await claim(claimMessage(account), { signer: account });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ reason: "ineligible", ...body });
    expect(countApiKeys()).toBe(0);
  });

  it.each([
    ["wrong domain", () => claimMessage(donorAccount).replace("pharos.watch wants", "evil.example wants")],
    ["wrong URI", () => claimMessage(donorAccount).replace("URI: https://pharos.watch/api/", "URI: https://evil.example/api/")],
    ["wrong chain", () => claimMessage(donorAccount).replace("Chain ID: 1", "Chain ID: 137")],
    ["expired", () => claimMessage(donorAccount, { issuedAtSec: NOW_SEC - 600 })],
    ["issued in the future", () => claimMessage(donorAccount, { issuedAtSec: NOW_SEC + 600 })],
    ["tampered statement", () => claimMessage(donorAccount).replace("Claim or extend your Pharos supporter API key", "Approve this transfer")],
    ["unparseable Issued At", () => claimMessage(donorAccount).replace(/Issued At: .*/, "Issued At: garbage")],
    ["far-future expiration", () => claimMessage(donorAccount).replace(/Expiration Time: .*/, "Expiration Time: 2099-01-01T00:00:00.000Z")],
    ["SIWE version 2", () => claimMessage(donorAccount).replace("Version: 1", "Version: 2")],
    ["short nonce", () => claimMessage(donorAccount, { nonce: "abc" })],
    ["trailing text", () => `${claimMessage(donorAccount)}\nResources:\n- https://evil.example`],
    ["not-before in the future", () => `${claimMessage(donorAccount)}\nNot Before: 2099-01-01T00:00:00.000Z`],
  ])("rejects a %s claim message with 400", async (_label, build) => {
    const response = await claim(build());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "siwe_invalid" });
    expect(countApiKeys()).toBe(0);
  });

  it.each([
    ["from another wallet", { signer: strangerAccount }],
    ["that is malformed", { signature: `0x${"00".repeat(65)}` }],
  ] as const)("rejects a signature %s with 400", async (_label, options) => {
    const response = await claim(claimMessage(donorAccount), options);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "signature_invalid" });
    expect(countApiKeys()).toBe(0);
  });

  it.each(["declared", "streamed"])("rejects a %s body over the 4 KB cap before eligibility or issuance", async (mode) => {
    const message = claimMessage(donorAccount);
    const body = JSON.stringify({ message, signature: await donorAccount.signMessage({ message }), padding: "x".repeat(5000) });
    const bytes = new TextEncoder().encode(body);
    const request = new Request(CLAIM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(mode === "declared" ? { "Content-Length": String(bytes.length) } : {}) },
      body: mode === "declared" ? body : new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 3000));
          controller.enqueue(bytes.slice(3000));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await handleDonorKeyClaim(db, request, { rateLimiter: allowLimiter, pepper: PEPPER }, NOW_SEC);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ reason: "body_invalid" });
    expect(countApiKeys()).toBe(0);
    expect(loadActiveSafetyScoreIndex).not.toHaveBeenCalled();
  });

  it("answers 429 when the IP rate limiter denies the claim", async () => {
    const response = await claim(claimMessage(donorAccount), { limiter: denyLimiter });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({ reason: "rate_limited" });
    expect(countApiKeys()).toBe(0);
  });

  it.each([["2001:0DB8:1:0002::abcd", "2001:db8:1:2::/64"], ["::ffff:192.0.2.1", "192.0.2.1"], ["garbage", "unknown"]])(
    "normalizes claim limiter source %s before reading the body", async (ip, key) => {
      const limit = vi.fn().mockResolvedValue({ success: false });
      const response = await handleDonorKeyClaim(db, new Request(CLAIM_URL, {
        method: "POST", headers: { "CF-Connecting-IP": ip }, body: "bad",
      }), { rateLimiter: { limit }, pepper: PEPPER }, NOW_SEC);
      expect(response.status).toBe(429);
      expect(limit).toHaveBeenCalledWith({ key });
      expect(countApiKeys()).toBe(0);
    },
  );

  it("loads a malformed ledger without throwing and rejects issuance with 503", async () => {
    vi.resetModules();
    vi.doMock("@shared/data/funding/donations.json", () => ({
      default: { last_updated_at: "invalid", donations: [] },
    }));
    try {
      // Dynamic imports are required here to exercise module evaluation after replacing the ledger asset.
      const malformedLedgerModule = await import("../donor-key-claims");
      const response = await malformedLedgerModule.handleDonorKeyClaim(
        db,
        new Request(CLAIM_URL, { method: "POST" }),
        { rateLimiter: allowLimiter, pepper: PEPPER },
        NOW_SEC,
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ reason: "donations_ledger_invalid" });
      expect(countApiKeys()).toBe(0);
    } finally {
      vi.doUnmock("@shared/data/funding/donations.json");
    }
  });
});
