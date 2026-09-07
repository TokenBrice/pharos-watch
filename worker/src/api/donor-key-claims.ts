import donationsAsset from "@shared/data/funding/donations.json";
import { DONOR_CLAIM_SIWE_DOMAIN, buildDonorClaimSiweMessage } from "@shared/lib/donor-key-claim";
import { isEligibleDonor, sumEligibleDonationsByAddress } from "@shared/lib/funding/donor-eligibility";
import { DonationsFileSchema } from "@shared/lib/funding/schema";
import {
  DONOR_API_KEY_MIN_USD,
  DONOR_API_KEY_RATE_LIMIT_PER_MINUTE,
  DONOR_KEY_CLAIM_MAX_AGE_SEC,
} from "@shared/lib/ops-limits";
import { DONOR_KEY_CLAIMS_OPEN } from "@shared/lib/public-api-contract";
import { DonorKeyClaimRequestSchema, type DonorKeyClaimResponse } from "@shared/types";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { verifyMessage } from "viem/utils";
import { buildTrustedApiKeyInsertStatement } from "../lib/api-key-admin";
import {
  buildApiKeyMaterial,
  clearApiKeyCache,
  getNowSec,
  maskApiKeyToken,
  recordApiKeyAudit,
  requireApiKeyPepper,
} from "../lib/api-key-core";
import { parseRequestJsonWithSchema } from "../lib/api-json-body";
import { errorResponse, jsonResponse } from "../lib/api-response";
import { logWorkerEvent } from "../lib/structured-log";

const ROUTE = "donor-key-claims";
const CLAIM_BODY_MAX_BYTES = 4096;
const RATE_LIMIT_RETRY_AFTER_SEC = 60;

const SIWE_INVALID_MESSAGE = "Claim message or signature is invalid";
const UNAVAILABLE_MESSAGE = "Supporter key claims are temporarily unavailable";
const INELIGIBLE_MESSAGE =
  `This wallet has not reached the $${DONOR_API_KEY_MIN_USD} supporter threshold in the public ledger. `
  + "Donations are reconciled weekly and go live with the next release; see https://pharos.watch/funding/";
const ALREADY_CLAIMED_MESSAGE =
  "This wallet already claimed its supporter key; to rotate a lost key use the feedback form at https://pharos.watch/feedback/";
const REVOKED_MESSAGE = "The supporter key for this wallet was revoked; see https://pharos.watch/feedback/";

// Eligibility is repo data: parse and total the ledger once per isolate.
const donationsLedger = DonationsFileSchema.parse(donationsAsset);
const eligibleTotalsByAddress = sumEligibleDonationsByAddress(donationsLedger.donations);

interface DonorClaimDeps {
  rateLimiter: RateLimit | undefined;
  pepper: string | undefined;
}

interface DonorClaimRow {
  key_prefix: string;
  is_active: number | null;
}

/** Outcome codes only: the message, the signature, and the address are never logged. */
function claimOutcome(outcome: string, status: number, level: "warn" | "error" | "info" = "warn"): void {
  logWorkerEvent({
    scope: "api",
    level,
    event: "donor_key_claim_outcome",
    route: ROUTE,
    status,
    message: outcome,
  });
}

function claimError(status: number, message: string, outcome: string, retryAfterSec?: number): Response {
  claimOutcome(outcome, status);
  return errorResponse(status, message, { noStore: true, ...(retryAfterSec == null ? {} : { retryAfterSec }) });
}

async function selectDonorClaim(db: D1Database, address: string): Promise<DonorClaimRow | null> {
  return db
    .prepare(
      `SELECT c.key_prefix, k.is_active
       FROM api_key_donor_claims c
       LEFT JOIN api_keys k ON k.key_prefix = c.key_prefix
       WHERE c.address = ?`,
    )
    .bind(address)
    .first<DonorClaimRow>();
}

/** A claim row is terminal in every shape: never auto-heal, an operator cleans up. */
function existingClaimResponse(row: DonorClaimRow): Response {
  if (row.is_active === 0) {
    return claimError(403, REVOKED_MESSAGE, "claim_revoked");
  }
  return claimError(409, ALREADY_CLAIMED_MESSAGE, row.is_active == null ? "claim_orphaned" : "claim_exists");
}

const SIWE_NONCE_PATTERN = /^[A-Za-z0-9]{8,}$/;

/**
 * The only acceptable message is the one our page builds: rebuild it from the
 * parsed fields and require byte equality, so version, statement, URI, chain,
 * expiration, and trailing text are all pinned by one comparison. Freshness
 * and not-before are checked against Worker time on top of that.
 */
function isValidClaimMessage(message: string, parsed: ReturnType<typeof parseSiweMessage>, nowSec: number): boolean {
  const { address, issuedAt, nonce } = parsed;
  if (!address || !issuedAt || !nonce) return false;
  // viem yields an Invalid Date (truthy, NaN time) for unparseable timestamps.
  if (Number.isNaN(issuedAt.getTime())) return false;
  if (!SIWE_NONCE_PATTERN.test(nonce)) return false;
  if (Math.abs(nowSec - Math.floor(issuedAt.getTime() / 1000)) > DONOR_KEY_CLAIM_MAX_AGE_SEC) return false;
  if (message !== buildDonorClaimSiweMessage({ address, nonce, issuedAt })) return false;
  return validateSiweMessage({
    message: parsed,
    domain: DONOR_CLAIM_SIWE_DOMAIN,
    time: new Date(nowSec * 1000),
  });
}

export async function handleDonorKeyClaim(
  db: D1Database,
  request: Request,
  deps: DonorClaimDeps,
  nowSec = getNowSec(),
): Promise<Response> {
  if (!DONOR_KEY_CLAIMS_OPEN) {
    return claimError(403, "Supporter key claims are paused", "claims_closed");
  }

  if (!deps.rateLimiter) {
    return claimError(503, UNAVAILABLE_MESSAGE, "rate_limiter_missing");
  }
  let limited: { success: boolean };
  try {
    limited = await deps.rateLimiter.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
  } catch {
    return claimError(503, UNAVAILABLE_MESSAGE, "rate_limit_unavailable");
  }
  if (!limited.success) {
    return claimError(
      429,
      `Too many supporter key claims from this address; retry in ${RATE_LIMIT_RETRY_AFTER_SEC} seconds.`,
      "rate_limited",
      RATE_LIMIT_RETRY_AFTER_SEC,
    );
  }

  const body = await parseRequestJsonWithSchema(request, DonorKeyClaimRequestSchema, {
    maxBytes: CLAIM_BODY_MAX_BYTES,
    responseOptions: { noStore: true },
  });
  if (body instanceof Response) {
    claimOutcome("body_invalid", body.status);
    return body;
  }

  const parsedMessage = parseSiweMessage(body.message);
  if (!parsedMessage.address || !isValidClaimMessage(body.message, parsedMessage, nowSec)) {
    return claimError(400, SIWE_INVALID_MESSAGE, "siwe_invalid");
  }

  const signatureValid = await verifyMessage({
    address: parsedMessage.address,
    message: body.message,
    signature: body.signature as `0x${string}`,
  }).catch(() => false);
  if (!signatureValid) {
    return claimError(400, SIWE_INVALID_MESSAGE, "signature_invalid");
  }

  const address = parsedMessage.address.toLowerCase();
  if (!isEligibleDonor(address, eligibleTotalsByAddress, DONOR_API_KEY_MIN_USD)) {
    claimOutcome("ineligible", 403);
    return jsonResponse(
      { error: INELIGIBLE_MESSAGE, ledgerUpdatedAt: donationsLedger.last_updated_at },
      { status: 403, noStore: true },
    );
  }

  const existing = await selectDonorClaim(db, address);
  if (existing) {
    return existingClaimResponse(existing);
  }

  const pepper = requireApiKeyPepper(deps.pepper);
  if (pepper instanceof Response) {
    return claimError(503, UNAVAILABLE_MESSAGE, "pepper_missing");
  }

  const material = await buildApiKeyMaterial(pepper);
  const claimInsert = db
    .prepare("INSERT INTO api_key_donor_claims (address, key_prefix, claimed_at) VALUES (?, ?, ?)")
    .bind(address, material.keyPrefix, nowSec);
  const keyInsert = buildTrustedApiKeyInsertStatement(
    db,
    material,
    {
      // Full address so the admin list is searchable by it (48 chars, under the 80 cap).
      name: `donor ${address}`,
      ownerEmail: null,
      tier: "donor",
      rateLimitPerMinute: DONOR_API_KEY_RATE_LIMIT_PER_MINUTE,
      expiresAt: null,
    },
    nowSec,
  );

  try {
    // Atomic: a concurrent first claim loses on the address primary key and
    // rolls the key insert back with it, so no orphan key can be issued.
    await db.batch([claimInsert, keyInsert]);
  } catch (error) {
    const raced = await selectDonorClaim(db, address).catch(() => null);
    if (raced) {
      return existingClaimResponse(raced);
    }
    logWorkerEvent({
      scope: "api",
      level: "error",
      event: "donor_key_claim_outcome",
      route: ROUTE,
      status: 503,
      message: "issue_failed",
      error,
    });
    return errorResponse(503, UNAVAILABLE_MESSAGE, { noStore: true });
  }

  clearApiKeyCache(material.keyPrefix);
  // The key is live once the batch committed: nothing after this point may
  // fail the claim, or the one-time token would be lost while the row stands.
  const issued = await db
    .prepare("SELECT id FROM api_keys WHERE key_prefix = ?")
    .bind(material.keyPrefix)
    .first<{ id: number }>()
    .catch((error: unknown) => {
      logWorkerEvent({
        scope: "api",
        level: "error",
        event: "donor_key_claim_audit_failed",
        route: ROUTE,
        message: "issued_id_lookup_failed",
        error,
      });
      return null;
    });

  if (issued) {
    // Best effort: the key is already live, an unwritten audit row never fails the claim.
    await recordApiKeyAudit(db, issued.id, "created", { tier: "donor" }, nowSec, "donor-claim").catch(
      (error: unknown) => {
        logWorkerEvent({
          scope: "api",
          level: "error",
          event: "donor_key_claim_audit_failed",
          route: ROUTE,
          message: "audit_write_failed",
          error,
        });
      },
    );
  }

  claimOutcome("issued", 201, "info");
  const response: DonorKeyClaimResponse = {
    status: "issued",
    key: {
      keyPrefix: material.keyPrefix,
      maskedToken: maskApiKeyToken(material.keyPrefix),
      tier: "donor",
      rateLimitPerMinute: DONOR_API_KEY_RATE_LIMIT_PER_MINUTE,
      expiresAt: null,
    },
    token: material.token,
  };
  return jsonResponse(response, { status: 201, noStore: true });
}
