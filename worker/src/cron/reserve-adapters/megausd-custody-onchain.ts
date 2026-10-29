import type { ReserveAdapterCoin, ReserveSlice } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import { toErrorMessage } from "@shared/lib/error-utils";
import { parseIsoDateOrUtcInstantSec } from "@shared/types/date-primitives";
import { fetchEvmBlockHeader } from "../../lib/evm-rpc";
import { encodeBalanceOfCallData } from "../../lib/evm-selectors";
import { rethrowIfAborted } from "../../lib/abort";
import type { BackingAndSupplyPayload } from "./custody-inventory";
import { runAdapterIo } from "./concurrency";
import { normalizeEvmAddress } from "./evm";
import {
  executeEvmObservationPlan,
  pinnedBlockPlan,
  uint256Observation,
} from "./evm-observation-plan";
import {
  decimalNumberFromBigInt,
  fetchJsonWithRetry,
  fetchOnchainMulticall3,
  requireOnchainInput,
  slicesFromValues,
  verifiedFreshnessMetadata,
} from "./helpers";
import type { AdapterContext, AdapterResult } from "./types";
import { reserveDegradedWarning } from "./warnings";

const ADAPTER_KEY = "megausd-custody-onchain";

/**
 * The published slice keys stay identical to the 2026-10-07 review
 * (`shared/data/stablecoins/domains/reserves/usdm-mega.json`), so switching the
 * transport from the geo-gated issuer JSON to on-chain balances does not create
 * a second key vocabulary.
 */
const SOURCE_KEY_PREFIX = "megausd-custody";

/** Discovery only: it can flag roster drift, never supply a published amount. */
export const MEGAUSD_CUSTODY_DISCOVERY_URL =
  "https://app.megausd.money/api/transparency/backing-and-supply/current";

/** A reviewed roster must be re-verified before this age; otherwise the snapshot fails closed. */
export const MEGAUSD_CUSTODY_ROSTER_MAX_AGE_SEC = 30 * 24 * 60 * 60;

const MAX_FUTURE_ROSTER_REVIEW_SKEW_SEC = 600;
const DECIMALS_SELECTOR = "0x313ce567";
const DISCOVERY_TIMEOUT_MS = 4_000;
const DISCOVERY_MAX_BYTES = 64 * 1024;
const SELF_TOKEN_ASSET_KEY = "USDM";

const ASSET_DEFINITIONS = {
  usdc: {
    name: "USDC cash-equivalent reserves",
    coinId: "usdc-circle",
    disclosureKey: "USDC",
    risk: getCanonicalReserveAssetRisk("USDC") ?? "low",
  },
  usdtb: {
    name: "USDtb cash-equivalent reserves",
    coinId: "usdtb-ethena",
    disclosureKey: "USDTB",
    risk: getCanonicalReserveAssetRisk("USDTB") ?? "low",
  },
} as const satisfies Record<
  string,
  { name: string; coinId: string; disclosureKey: string; risk: ReserveSlice["risk"] }
>;

type SupportedAssetKey = keyof typeof ASSET_DEFINITIONS;
const SUPPORTED_ASSET_KEYS = Object.keys(ASSET_DEFINITIONS) as SupportedAssetKey[];

/** One reviewed custodian holding one backing token on one chain. */
export interface MegausdCustodyRosterEntry {
  chain: string;
  token: string;
  custodian: string;
  assetKey: string;
}

/**
 * Reviewed params roster. The roster itself is the reviewed evidence; params
 * are the only source of custodian/token identity, and the issuer JSON is
 * consulted solely for drift detection.
 */
export interface MegausdCustodyOnchainParams {
  /** Date-only (`YYYY-MM-DD`) or exact UTC instant when the roster was reviewed. */
  rosterReviewedAt: string;
  roster: readonly MegausdCustodyRosterEntry[];
}

interface ReviewedRosterEntry {
  chain: string;
  token: `0x${string}`;
  custodian: `0x${string}`;
  assetKey: SupportedAssetKey;
}

interface ReviewedRoster {
  reviewedAt: string;
  reviewedAtSec: number;
  chain: string;
  entries: ReviewedRosterEntry[];
  tokenByAsset: Map<SupportedAssetKey, `0x${string}`>;
}

type RosterDiscovery =
  | { status: "matched"; sourceTimestamp: number | null }
  | { status: "drift"; reason: string; sourceTimestamp: number | null }
  | { status: "unavailable"; reason: string };

function isSupportedAssetKey(value: string): value is SupportedAssetKey {
  return Object.prototype.hasOwnProperty.call(ASSET_DEFINITIONS, value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${ADAPTER_KEY}: missing or invalid ${label}`);
  }
  return value.trim();
}

function readReviewedRoster(params: Record<string, unknown> | undefined): ReviewedRoster {
  if (params == null) throw new Error(`${ADAPTER_KEY}: missing reviewed custody roster params`);
  const reviewedAt = requireString(params.rosterReviewedAt, "rosterReviewedAt");
  const reviewedAtSec = parseIsoDateOrUtcInstantSec(reviewedAt);
  if (!Number.isFinite(reviewedAtSec)) {
    throw new Error(`${ADAPTER_KEY}: invalid custody roster reviewedAt ${reviewedAt}`);
  }
  const rawRoster = params.roster;
  if (!Array.isArray(rawRoster) || rawRoster.length === 0) {
    throw new Error(`${ADAPTER_KEY}: missing or empty reviewed custody roster`);
  }
  const entries: ReviewedRosterEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawRoster.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${ADAPTER_KEY}: custody roster entry ${index} is not an object`);
    }
    const record = raw as Record<string, unknown>;
    const chain = typeof record.chain === "string" ? record.chain.trim().toLowerCase() : "";
    if (chain.length === 0) throw new Error(`${ADAPTER_KEY}: custody roster entry ${index} has no chain`);
    const token = normalizeEvmAddress(typeof record.token === "string" ? record.token : null);
    if (token == null) throw new Error(`${ADAPTER_KEY}: custody roster entry ${index} has an invalid token`);
    const custodian = normalizeEvmAddress(
      typeof record.custodian === "string" ? record.custodian : null,
    );
    if (custodian == null) {
      throw new Error(`${ADAPTER_KEY}: custody roster entry ${index} has an invalid custodian`);
    }
    const assetKey = typeof record.assetKey === "string" ? record.assetKey.trim().toLowerCase() : "";
    if (!isSupportedAssetKey(assetKey)) {
      throw new Error(`${ADAPTER_KEY}: custody roster entry ${index} has unsupported assetKey ${assetKey || "(empty)"}`);
    }
    const duplicate = `${assetKey}:${custodian}`;
    if (seen.has(duplicate)) {
      throw new Error(`${ADAPTER_KEY}: duplicate custody roster entry for ${assetKey} ${custodian}`);
    }
    seen.add(duplicate);
    entries.push({ chain, token, custodian, assetKey });
  }
  const chain = entries[0]!.chain;
  if (entries.some((entry) => entry.chain !== chain)) {
    throw new Error(`${ADAPTER_KEY}: custody roster spans multiple chains; one pinned block cannot read them`);
  }
  const tokenByAsset = new Map<SupportedAssetKey, `0x${string}`>();
  for (const entry of entries) {
    const existing = tokenByAsset.get(entry.assetKey);
    if (existing != null && existing !== entry.token) {
      throw new Error(`${ADAPTER_KEY}: ${entry.assetKey} roster uses more than one token contract`);
    }
    tokenByAsset.set(entry.assetKey, entry.token);
  }
  for (const assetKey of SUPPORTED_ASSET_KEYS) {
    if (!tokenByAsset.has(assetKey)) {
      throw new Error(`${ADAPTER_KEY}: custody roster does not cover ${assetKey}`);
    }
  }
  return { reviewedAt, reviewedAtSec, chain, entries, tokenByAsset };
}

function assertRosterFresh(roster: ReviewedRoster, nowSec: number): number {
  const ageSec = nowSec - roster.reviewedAtSec;
  if (ageSec < -MAX_FUTURE_ROSTER_REVIEW_SKEW_SEC) {
    throw new Error(`${ADAPTER_KEY}: custody roster reviewedAt is in the future (${roster.reviewedAt})`);
  }
  if (ageSec > MEGAUSD_CUSTODY_ROSTER_MAX_AGE_SEC) {
    throw new Error(
      `${ADAPTER_KEY}: custody-roster-unverified (reviewedAt ${roster.reviewedAt} is ${Math.floor(ageSec / 86_400)} days old; maximum ${MEGAUSD_CUSTODY_ROSTER_MAX_AGE_SEC / 86_400} days)`,
    );
  }
  return Math.max(0, ageSec);
}

/** Null means the payload cannot support a set comparison at all (not drift). */
function readDisclosedCustodianSets(
  payload: BackingAndSupplyPayload,
): Map<string, Set<string>> | null {
  const backingAssets = payload?.backingAssets;
  if (typeof backingAssets !== "object" || backingAssets === null || Array.isArray(backingAssets)) {
    return null;
  }
  const sets = new Map<string, Set<string>>();
  for (const [rawKey, rows] of Object.entries(backingAssets)) {
    const key = rawKey.trim().toUpperCase();
    if (key.length === 0 || !Array.isArray(rows) || sets.has(key)) return null;
    const custodians = new Set<string>();
    for (const row of rows) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
      if (!("custodian" in row) || typeof row.custodian !== "string") return null;
      const custodian = normalizeEvmAddress(row.custodian);
      if (custodian == null) return null;
      custodians.add(custodian);
    }
    sets.set(key, custodians);
  }
  return sets.size > 0 ? sets : null;
}

function compareRosterWithDisclosure(
  roster: ReviewedRoster,
  disclosed: Map<string, Set<string>>,
): string | null {
  const reasons: string[] = [];
  for (const assetKey of SUPPORTED_ASSET_KEYS) {
    const expected = new Set<string>(
      roster.entries.filter((entry) => entry.assetKey === assetKey).map((entry) => entry.custodian),
    );
    const actual = disclosed.get(ASSET_DEFINITIONS[assetKey].disclosureKey);
    if (actual == null) {
      reasons.push(`${assetKey}: not disclosed by the issuer payload`);
      continue;
    }
    const missing = [...expected].filter((address) => !actual.has(address));
    const unexpected = [...actual].filter((address) => !expected.has(address));
    if (missing.length > 0) reasons.push(`${assetKey}: roster custodians missing (${missing.join(", ")})`);
    if (unexpected.length > 0) reasons.push(`${assetKey}: undisclosed roster custodians (${unexpected.join(", ")})`);
  }
  for (const [key, custodians] of disclosed) {
    if (key === SELF_TOKEN_ASSET_KEY) continue;
    if (!SUPPORTED_ASSET_KEYS.some((assetKey) => ASSET_DEFINITIONS[assetKey].disclosureKey === key)) {
      reasons.push(`${key}: backing category is absent from the reviewed roster (${custodians.size} custodians)`);
    }
  }
  return reasons.length > 0 ? reasons.join("; ") : null;
}

async function discoverRoster(
  roster: ReviewedRoster,
  signal: AbortSignal,
  ctx: AdapterContext | undefined,
): Promise<RosterDiscovery> {
  let payload: BackingAndSupplyPayload;
  try {
    payload = await fetchJsonWithRetry<BackingAndSupplyPayload>(
      MEGAUSD_CUSTODY_DISCOVERY_URL,
      signal,
      DISCOVERY_TIMEOUT_MS,
      ctx,
      { maxRetries: 0, redirect: "manual", maxResponseBytes: DISCOVERY_MAX_BYTES },
    );
  } catch (error) {
    rethrowIfAborted(error, signal);
    return { status: "unavailable", reason: toErrorMessage(error).slice(0, 240) };
  }
  const disclosed = readDisclosedCustodianSets(payload);
  if (disclosed == null) {
    return { status: "unavailable", reason: "issuer transparency backingAssets shape" };
  }
  const sourceTimestamp = parseIsoDateOrUtcInstantSec(payload.lastUpdatedAt);
  const reason = compareRosterWithDisclosure(roster, disclosed);
  return reason == null
    ? { status: "matched", sourceTimestamp: Number.isFinite(sourceTimestamp) ? sourceTimestamp : null }
    : { status: "drift", reason, sourceTimestamp: Number.isFinite(sourceTimestamp) ? sourceTimestamp : null };
}

export async function fetchMegausdCustodyOnchainReserves(
  _coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const roster = readReviewedRoster(config.params);
  const nowSec = ctx?.nowSec ?? Math.floor(Date.now() / 1000);
  const rosterAgeSec = assertRosterFresh(roster, nowSec);
  const input = requireOnchainInput(config.inputs.primary, ADAPTER_KEY);
  if (input.chain.toLowerCase() !== roster.chain) {
    throw new Error(
      `${ADAPTER_KEY}: primary chain ${input.chain} does not match reviewed roster chain ${roster.chain}`,
    );
  }

  // Discovery runs first so its body is fully consumed before RPC reads open.
  const discovery = await discoverRoster(roster, signal, ctx);

  const { observedBlock, ctx: pinnedCtx } = await pinnedBlockPlan({
    chain: roster.chain,
    signal,
    ctx,
  });
  if (!Number.isSafeInteger(observedBlock.number) || observedBlock.number < 0
    || !Number.isSafeInteger(observedBlock.timestamp) || observedBlock.timestamp <= 0) {
    throw new Error(`${ADAPTER_KEY}: invalid observation block`);
  }
  // pinnedBlockPlan retains only number/timestamp; provenance also names the
  // canonical hash at that exact height.
  const header = await runAdapterIo(
    pinnedCtx,
    `${ADAPTER_KEY}:block-hash`,
    () => fetchEvmBlockHeader(roster.chain, observedBlock.number, {
      signal,
      chainRpcs: pinnedCtx.chainRpcs,
      timeoutMs: 10_000,
    }),
    { signal },
  );
  if (header == null || header.number !== observedBlock.number || !/^0x[0-9a-f]{64}$/.test(header.hash)) {
    throw new Error(`${ADAPTER_KEY}: observation block hash unavailable`);
  }

  const fields = [
    ...[...roster.tokenByAsset].map(([assetKey, token]) =>
      uint256Observation({
        label: `decimals:${assetKey}`,
        contract: token,
        data: DECIMALS_SELECTOR,
        verify: (value) => (value > 36n ? "token decimals exceed the supported range" : null),
      }),
    ),
    ...roster.entries.map((entry) =>
      uint256Observation({
        label: `balance:${entry.assetKey}:${entry.custodian}`,
        contract: entry.token,
        data: encodeBalanceOfCallData(entry.custodian),
        // Every roster member is required. A reverted read stays a failure
        // below; it is never dropped or treated as an observed zero.
        allowFailure: true,
      }),
    ),
  ];
  const { values } = await executeEvmObservationPlan({
    adapterKey: ADAPTER_KEY,
    fields,
    read: (calls) =>
      fetchOnchainMulticall3({
        calls,
        chain: roster.chain,
        signal,
        ctx: pinnedCtx,
        blockNumberOrTag: observedBlock.number,
      }),
  });

  const decimalsByAsset = new Map<SupportedAssetKey, number>();
  for (const assetKey of roster.tokenByAsset.keys()) {
    const decimals = Number(values[`decimals:${assetKey}`] as bigint);
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error(`${ADAPTER_KEY}: ${assetKey} token decimals unavailable`);
    }
    decimalsByAsset.set(assetKey, decimals);
  }

  const rawByAsset = new Map<SupportedAssetKey, bigint>();
  for (const assetKey of roster.tokenByAsset.keys()) rawByAsset.set(assetKey, 0n);
  const custodianRows: Array<{
    assetKey: SupportedAssetKey;
    token: `0x${string}`;
    custodian: `0x${string}`;
    raw: string;
  }> = [];
  for (const entry of roster.entries) {
    const raw = values[`balance:${entry.assetKey}:${entry.custodian}`] as bigint;
    rawByAsset.set(entry.assetKey, (rawByAsset.get(entry.assetKey) ?? 0n) + raw);
    custodianRows.push({
      assetKey: entry.assetKey,
      token: entry.token,
      custodian: entry.custodian,
      raw: raw.toString(),
    });
  }

  const amountByAsset = new Map<SupportedAssetKey, number>();
  for (const [assetKey, raw] of rawByAsset) {
    const amount = decimalNumberFromBigInt(raw, decimalsByAsset.get(assetKey)!);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`${ADAPTER_KEY}: ${assetKey} aggregate is not a finite non-negative amount`);
    }
    amountByAsset.set(assetKey, amount);
  }
  const sliceInputs = SUPPORTED_ASSET_KEYS
    .map((assetKey) => ({
      assetKey,
      value: amountByAsset.get(assetKey) ?? 0,
      sourceKey: `${SOURCE_KEY_PREFIX}:${assetKey}`,
      name: ASSET_DEFINITIONS[assetKey].name,
      risk: ASSET_DEFINITIONS[assetKey].risk,
      coinId: ASSET_DEFINITIONS[assetKey].coinId,
      depType: "collateral" as const,
    }))
    .filter((row) => row.value > 0);
  if (sliceInputs.length === 0) {
    throw new Error(`${ADAPTER_KEY}: no positive custodian balances`);
  }
  const totalReserveUsd = sliceInputs.reduce((sum, row) => sum + row.value, 0);

  const warnings: LiveReserveWarning[] = [];
  if (discovery.status === "drift") {
    warnings.push(
      reserveDegradedWarning(
        "custody-roster-drift",
        `Issuer transparency custodian set differs from the reviewed roster: ${discovery.reason}`,
      ),
    );
  }

  return {
    slices: slicesFromValues(sliceInputs),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(observedBlock.timestamp),
      totalReserveUsd,
      details: {
        chain: roster.chain,
        blockNumber: observedBlock.number,
        blockHash: header.hash,
        rosterReviewedAt: roster.reviewedAt,
        rosterAgeSec: Math.floor(rosterAgeSec),
        rosterMaxAgeSec: MEGAUSD_CUSTODY_ROSTER_MAX_AGE_SEC,
        rosterDiscovery: discovery.status,
        rosterDiscoveryUrl: MEGAUSD_CUSTODY_DISCOVERY_URL,
        ...(discovery.status === "unavailable" ? { rosterDiscoveryReason: discovery.reason } : {}),
        ...(discovery.status === "drift" ? { rosterDrift: discovery.reason } : {}),
        ...(discovery.status !== "unavailable" && discovery.sourceTimestamp != null
          ? { rosterDiscoverySourceTimestamp: discovery.sourceTimestamp }
          : {}),
        tokens: [...roster.tokenByAsset].map(([assetKey, token]) => ({
          assetKey,
          token,
          decimals: decimalsByAsset.get(assetKey),
        })),
        custodians: custodianRows,
        assetTotals: sliceInputs.map((row) => ({
          assetKey: row.assetKey,
          usd: row.value,
          sourceKey: row.sourceKey,
        })),
      },
    },
  };
}
