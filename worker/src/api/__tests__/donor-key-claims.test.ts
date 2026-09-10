import { buildDonorClaimSiweMessage } from "@shared/lib/donor-key-claim";
import { DonorKeyClaimResponseSchema } from "@shared/types/api-keys";
import type { DatabaseSync } from "node:sqlite";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateAccessGate, evaluateCachedPublicApiReadFastGate } from "../../handlers/http/gates";
import { rotateApiKey } from "../../lib/api-key-admin";
import { authenticateApiKey } from "../../lib/api-key-auth";
import { resetApiKeyStateForTests } from "../../lib/api-keys";
import { loadActiveSafetyScoreSource } from "../../lib/safety-score-active-source";
import { makeJsonRequest } from "../../test-helpers/__shared/auth";
import { createWorkerEnv } from "../../test-helpers/__shared/worker-env";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { handleDonorKeyClaim } from "../donor-key-claims";

vi.mock("../../lib/safety-score-active-source", () => ({
  loadActiveSafetyScoreSource: vi.fn(),
}));

// Exercise issuance independently from the production pause switch.
vi.mock("@shared/lib/public-api-contract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/lib/public-api-contract")>()),
  DONOR_KEY_CLAIMS_OPEN: true,
}));

// $11 across two chains qualifies; exactly $10, ETH, and pool payouts do not.
vi.mock("@shared/data/funding/donations.json", () => ({
  default: {
    last_updated_at: 1788681300,
    donations: [
      {
        chain: "ethereum",
        tx_hash: "0xaa01",
        block_timestamp: 1776072647,
        from_address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        display: "donor.eth",
        kind: "community",
        asset_symbol: "USDC",
        amount_decimal: 5,
        usd_at_receipt: 5,
        price_note: "stablecoin-par",
      },
      {
        chain: "base",
        tx_hash: "0xaa02",
        block_timestamp: 1776172647,
        from_address: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        display: "donor.eth",
        kind: "community",
        asset_symbol: "USDC",
        amount_decimal: 6,
        usd_at_receipt: 6,
        price_note: "stablecoin-par",
      },
      {
        chain: "ethereum",
        tx_hash: "0xbb01",
        block_timestamp: 1776272647,
        from_address: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
        display: "0x3c44cd...93bc",
        kind: "community",
        asset_symbol: "USDC",
        amount_decimal: 10,
        usd_at_receipt: 10,
        price_note: "stablecoin-par",
      },
      {
        chain: "ethereum",
        tx_hash: "0xbb02",
        block_timestamp: 1776282647,
        from_address: "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
        display: "0x15d34a...6a65",
        kind: "community",
        asset_symbol: "USDC",
        amount_decimal: 9.99,
        usd_at_receipt: 9.99,
        price_note: "stablecoin-par",
      },
      {
        chain: "ethereum",
        tx_hash: "0xdd01",
        block_timestamp: 1776372647,
        from_address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        display: "ETH donor",
        kind: "community",
        asset_symbol: "ETH",
        amount_decimal: 1,
        usd_at_receipt: 2000,
        price_note: "receipt-time price",
      },
      {
        chain: "gnosis",
        tx_hash: "0xcc01",
        block_timestamp: 1776372647,
        from_address: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
        display: "via Giveth",
        kind: "pool",
        asset_symbol: "USDC",
        amount_decimal: 50,
        usd_at_receipt: 50,
        price_note: "stablecoin-par",
      },
    ],
  },
}));

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
  } = {},
): Promise<Response> {
  // Key presence, not `??`: the missing-binding cases pass `undefined` on purpose.
  const limiter = "limiter" in options ? options.limiter : allowLimiter;
  const pepper = "pepper" in options ? options.pepper : PEPPER;
  const signer = options.signer ?? donorAccount;
  const body = { message, signature: options.signature ?? (await signer.signMessage({ message })) };
  return handleDonorKeyClaim(db, makeJsonRequest(CLAIM_URL, body), { rateLimiter: limiter, pepper }, NOW_SEC);
}

function countApiKeys(): number {
  return (sqlite.prepare("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }).n;
}

beforeEach(() => {
  resetApiKeyStateForTests();
  vi.mocked(loadActiveSafetyScoreSource).mockReset().mockResolvedValue({
    kind: "v9",
    snapshot: makeReportCardsV9Response({ cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "B" })] }),
  });
  ({ sqlite, db } = createLatestSchemaSqlite());
});

afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});

describe("POST /api/donor-key-claims", () => {
  it("issues one donor key for an eligible wallet and records the claim", async () => {
    const response = await claim(claimMessage(donorAccount));

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = DonorKeyClaimResponseSchema.parse(await response.json());
    expect(payload.key.rateLimitPerMinute).toBe(10);
    expect(payload.key.expiresAt).toBeNull();

    const keyRow = sqlite
      .prepare("SELECT tier, rate_limit_per_minute, expires_at, owner_email, name FROM api_keys WHERE key_prefix = ?")
      .get(payload.key.keyPrefix) as {
        tier: string;
        rate_limit_per_minute: number;
        expires_at: number | null;
        owner_email: string | null;
        name: string;
      };
    expect(keyRow).toMatchObject({
      tier: "donor",
      rate_limit_per_minute: 10,
      expires_at: null,
      owner_email: null,
    });
    expect(keyRow.name).toBe(`donor ${donorAccount.address.toLowerCase()}`);

    const claimRow = sqlite
      .prepare("SELECT address, key_prefix, claimed_at FROM api_key_donor_claims")
      .get() as { address: string; key_prefix: string; claimed_at: number };
    expect(claimRow).toEqual({
      address: donorAccount.address.toLowerCase(),
      key_prefix: payload.key.keyPrefix,
      claimed_at: NOW_SEC,
    });

    const auditRow = sqlite
      .prepare("SELECT action, actor, detail_json FROM api_key_audit_log")
      .get() as { action: string; actor: string; detail_json: string };
    expect(auditRow).toMatchObject({ action: "created", actor: "donor-claim" });
    // The audit log is retained indefinitely; the address lives only on the claim row and key name.
    expect(auditRow.detail_json).not.toContain(donorAccount.address.slice(2, 12).toLowerCase());
  });

  it.each(["C", "NR", null] as const)("excludes donations when the current grade is %s", async (grade) => {
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValue({
      kind: "v9",
      snapshot: makeReportCardsV9Response({
        cards: grade === null ? [] : [makeWorkerV9Card({ id: "usdc-circle", grade })],
      }),
    });

    expect((await claim(claimMessage(donorAccount))).status).toBe(403);
    expect(countApiKeys()).toBe(0);
  });

  it.each(["held", "error"] as const)("fails closed when current grades are %s", async (kind) => {
    vi.mocked(loadActiveSafetyScoreSource).mockResolvedValue(kind === "held" ? {
      kind, reason: "v9-publication-held", detail: "held", snapshot: makeReportCardsV9Response(),
    } : {
      kind, reason: "v9-snapshot-unavailable", detail: "unavailable", snapshot: null,
    });

    const response = await claim(claimMessage(donorAccount));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(countApiKeys()).toBe(0);
  });

  it("preserves issued access and terminal replay after a grade downgrade", async () => {
    const payload = DonorKeyClaimResponseSchema.parse(await (await claim(claimMessage(donorAccount))).json());
    vi.mocked(loadActiveSafetyScoreSource).mockClear().mockResolvedValue({
      kind: "v9",
      snapshot: makeReportCardsV9Response({ cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "C" })] }),
    });

    await expect(authenticateApiKey(db, payload.token, PEPPER)).resolves.toMatchObject({ kind: "valid" });
    expect((await claim(claimMessage(donorAccount, { nonce: "downgradereplay1" }))).status).toBe(409);
    expect(loadActiveSafetyScoreSource).not.toHaveBeenCalled();
    sqlite.exec("UPDATE api_keys SET is_active = 0");
    expect((await claim(claimMessage(donorAccount, { nonce: "downgradereplay2" }))).status).toBe(403);
    expect(loadActiveSafetyScoreSource).not.toHaveBeenCalled();
  });

  it("enforces the issued donor key's ten-request minute quota through the access gate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    const payload = DonorKeyClaimResponseSchema.parse(await (await claim(claimMessage(donorAccount))).json());
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

  it("accepts a message written with a lowercase address", async () => {
    const lower = claimMessage(donorAccount).replace(donorAccount.address, donorAccount.address.toLowerCase());

    expect((await claim(lower)).status).toBe(201);
  });

  it("keeps the wallet mapped to its key across an admin rotation", async () => {
    const payload = DonorKeyClaimResponseSchema.parse(await (await claim(claimMessage(donorAccount))).json());
    const { id } = sqlite.prepare("SELECT id FROM api_keys WHERE key_prefix = ?").get(payload.key.keyPrefix) as { id: number };
    const rotated = await rotateApiKey(db, PEPPER, id, NOW_SEC + 60);
    expect(rotated).not.toBeInstanceOf(Response);

    const claimRow = sqlite.prepare("SELECT key_prefix FROM api_key_donor_claims").get() as { key_prefix: string };
    expect(claimRow.key_prefix).toBe((rotated as { key: { keyPrefix: string } }).key.keyPrefix);
    expect((await claim(claimMessage(donorAccount, { nonce: "dddddddddddddddd" }))).status).toBe(409);
  });

  it.each(["UPDATE api_key_donor_claims", "UPDATE api_keys"])("rolls back rotation when %s fails", async (failingSql) => {
    const payload = DonorKeyClaimResponseSchema.parse(await (await claim(claimMessage(donorAccount))).json());
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

  it("keeps the donor mapping attached during concurrent rotations", async () => {
    await claim(claimMessage(donorAccount));
    const { id } = sqlite.prepare("SELECT id FROM api_keys").get() as { id: number };

    const rotations = await Promise.all([
      rotateApiKey(db, PEPPER, id, NOW_SEC + 60),
      rotateApiKey(db, PEPPER, id, NOW_SEC + 60),
    ]);

    expect(rotations.every((result) => !(result instanceof Response))).toBe(true);
    expect(sqlite.prepare("SELECT key_prefix FROM api_key_donor_claims").get()).toEqual(
      sqlite.prepare("SELECT key_prefix FROM api_keys WHERE id = ?").get(id),
    );
  });

  it("answers 409 for an orphaned claim whose key row is gone", async () => {
    expect((await claim(claimMessage(donorAccount))).status).toBe(201);
    sqlite.exec("DELETE FROM api_keys");

    const response = await claim(claimMessage(donorAccount, { nonce: "eeeeeeeeeeeeeeee" }));

    expect(response.status).toBe(409);
    expect(countApiKeys()).toBe(0);
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
    const payload = DonorKeyClaimResponseSchema.parse(await response.json());
    await expect(authenticateApiKey(db, payload.token, PEPPER)).resolves.toMatchObject({ kind: "valid" });
  });

  it("rolls back an issuance outage and allows a clean retry", async () => {
    let failed = false;
    db = createSqliteD1(sqlite, {
      onRun(sql) {
        if (sql.includes("INSERT INTO api_key_donor_claims")) {
          failed = true;
          throw new Error("injected issuance failure");
        }
      },
    });
    expect((await claim(claimMessage(donorAccount))).status).toBe(503);
    expect(failed).toBe(true);
    expect(countApiKeys()).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM api_key_donor_claims").get()).toEqual({ n: 0 });
    db = createSqliteD1(sqlite);
    const response = await claim(claimMessage(donorAccount));
    expect(response.status).toBe(201);
    const payload = DonorKeyClaimResponseSchema.parse(await response.json());
    await expect(authenticateApiKey(db, payload.token, PEPPER)).resolves.toMatchObject({ kind: "valid" });
  });

  it("preserves the issued token when audit insertion fails", async () => {
    let failed = false;
    db = createSqliteD1(sqlite, {
      onRun(sql) {
        if (sql.includes("INSERT INTO api_key_audit_log")) {
          failed = true;
          throw new Error("injected audit failure");
        }
      },
    });
    const response = await claim(claimMessage(donorAccount));
    expect(response.status).toBe(201);
    expect(failed).toBe(true);
    const payload = DonorKeyClaimResponseSchema.parse(await response.json());
    await expect(authenticateApiKey(db, payload.token, PEPPER)).resolves.toMatchObject({ kind: "valid" });
    expect(countApiKeys()).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM api_key_donor_claims").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM api_key_audit_log").get()).toEqual({ n: 0 });
  });

  it("answers 503 when the rate limit binding throws", async () => {
    const throwing: RateLimit = { limit: async () => { throw new Error("binding unavailable"); } };

    expect((await claim(claimMessage(donorAccount), { limiter: throwing })).status).toBe(503);
    expect(countApiKeys()).toBe(0);
  });

  it("issues a token that authenticates against the public API key path", async () => {
    const response = await claim(claimMessage(donorAccount));
    const payload = DonorKeyClaimResponseSchema.parse(await response.json());

    await expect(authenticateApiKey(db, payload.token, PEPPER)).resolves.toMatchObject({ kind: "valid" });
  });

  it("answers 409 on a replayed message without issuing a second key", async () => {
    const message = claimMessage(donorAccount);
    const signature = await donorAccount.signMessage({ message });

    expect((await claim(message, { signature })).status).toBe(201);
    const replay = await claim(message, { signature });

    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ error: expect.stringContaining("already claimed") });
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

  it("answers 403 once an operator deactivates the issued key", async () => {
    expect((await claim(claimMessage(donorAccount))).status).toBe(201);
    sqlite.exec("UPDATE api_keys SET is_active = 0");

    const response = await claim(claimMessage(donorAccount, { nonce: "cccccccccccccccc" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("revoked") });
  });

  it("issues a key for a wallet at exactly $10, because the threshold is inclusive", async () => {
    const response = await claim(claimMessage(thresholdAccount), { signer: thresholdAccount });

    expect(response.status).toBe(201);
    expect(countApiKeys()).toBe(1);
  });

  it("answers 403 with the ledger date for a wallet below $10", async () => {
    const response = await claim(claimMessage(belowThresholdAccount), { signer: belowThresholdAccount });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ledgerUpdatedAt: LEDGER_UPDATED_AT });
    expect(countApiKeys()).toBe(0);
  });

  it("excludes non-stablecoin donations above $10 from eligibility", async () => {
    const response = await claim(claimMessage(strangerAccount), { signer: strangerAccount });

    expect(response.status).toBe(403);
    expect(countApiKeys()).toBe(0);
  });

  it("excludes pool payout senders from eligibility", async () => {
    const response = await claim(claimMessage(poolAccount), { signer: poolAccount });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ledgerUpdatedAt: LEDGER_UPDATED_AT });
  });

  it.each([
    ["wrong domain", () => claimMessage(donorAccount).replace("pharos.watch wants", "evil.example wants")],
    ["wrong URI", () => claimMessage(donorAccount).replace("URI: https://pharos.watch/api/", "URI: https://evil.example/api/")],
    ["wrong chain", () => claimMessage(donorAccount).replace("Chain ID: 1", "Chain ID: 137")],
    ["expired", () => claimMessage(donorAccount, { issuedAtSec: NOW_SEC - 600 })],
    ["issued in the future", () => claimMessage(donorAccount, { issuedAtSec: NOW_SEC + 600 })],
    ["tampered statement", () => claimMessage(donorAccount).replace("Claim your Pharos supporter API key.", "Approve this transfer.")],
    ["unparseable Issued At", () => claimMessage(donorAccount).replace(/Issued At: .*/, "Issued At: garbage")],
    ["far-future expiration", () => claimMessage(donorAccount).replace(/Expiration Time: .*/, "Expiration Time: 2099-01-01T00:00:00.000Z")],
    ["SIWE version 2", () => claimMessage(donorAccount).replace("Version: 1", "Version: 2")],
    ["short nonce", () => claimMessage(donorAccount, { nonce: "abc" })],
    ["trailing text", () => `${claimMessage(donorAccount)}\nResources:\n- https://evil.example`],
    ["not-before in the future", () => `${claimMessage(donorAccount)}\nNot Before: 2099-01-01T00:00:00.000Z`],
  ])("rejects a %s claim message with 400", async (_label, build) => {
    const response = await claim(build());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Claim message or signature is invalid" });
    expect(countApiKeys()).toBe(0);
  });

  it("rejects a signature from another wallet with 400", async () => {
    const response = await claim(claimMessage(donorAccount), { signer: strangerAccount });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Claim message or signature is invalid" });
  });

  it("rejects a malformed signature with 400", async () => {
    const response = await claim(claimMessage(donorAccount), { signature: `0x${"00".repeat(65)}` });

    expect(response.status).toBe(400);
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
    expect(countApiKeys()).toBe(0);
    expect(loadActiveSafetyScoreSource).not.toHaveBeenCalled();
  });

  it("answers 429 when the IP rate limiter denies the claim", async () => {
    const response = await claim(claimMessage(donorAccount), { limiter: denyLimiter });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("answers 503 when the rate limit binding is missing", async () => {
    const response = await claim(claimMessage(donorAccount), { limiter: undefined });

    expect(response.status).toBe(503);
  });

  it("answers 503 when the API key pepper is unset", async () => {
    const response = await claim(claimMessage(donorAccount), { pepper: undefined });

    expect(response.status).toBe(503);
    expect(countApiKeys()).toBe(0);
  });
});
