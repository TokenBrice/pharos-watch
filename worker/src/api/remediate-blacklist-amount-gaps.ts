import { BLACKLIST_STABLECOINS, type BlacklistStablecoin } from "@shared/types/market";
import { computeBlacklistAmountUsdAtEvent } from "@shared/lib/blacklist";
import { requireAdmin } from "../lib/auth";
import { errorResponse, jsonResponse, parseIntParam } from "../lib/api-utils";
import {
  getBlacklistConfigByContract,
  getBlacklistConfigByKey,
  getBlacklistConfigsForSymbolAndChain,
  type ContractEventConfig,
} from "../lib/blacklist-contracts";
import { createBudget, createRateLimiter } from "../lib/evm-logs";
import { fetchEvmTokenBalance } from "../cron/blacklist/balance-providers";
import type { ChainRpcConfig } from "../lib/chain-registry";

const VALID_STABLECOINS = new Set<BlacklistStablecoin>(BLACKLIST_STABLECOINS);
const RECOVERABLE_GAP_STATUSES = ["recoverable_pending", "provider_failed", "ambiguous"] as const;

type GapRow = {
  id: string;
  stablecoin: string;
  chain_id: string;
  event_type: string;
  address: string;
  block_number: number;
  timestamp: number;
  amount_status: string;
  amount_attempt_count: number | null;
  amount_last_attempted_at: number | null;
  contract_address: string | null;
  config_key: string | null;
};

type ResolvedCandidate =
  | { row: GapRow; kind: "resolved"; config: ContractEventConfig }
  | { row: GapRow; kind: "missing_config" | "ambiguous_config" };

function parseBooleanInput(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

async function readBodyJson(request?: Request): Promise<Record<string, unknown>> {
  if (!request || request.method !== "POST") return {};
  try {
    return (await request.clone().json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveCandidate(row: GapRow): ResolvedCandidate {
  const stablecoin = row.stablecoin.toUpperCase() as BlacklistStablecoin;
  if (!VALID_STABLECOINS.has(stablecoin)) {
    return { row, kind: "missing_config" };
  }

  const config = row.config_key
    ? getBlacklistConfigByKey(row.config_key)
    : row.contract_address
      ? getBlacklistConfigByContract(row.chain_id, row.contract_address)
      : (() => {
          const matches = getBlacklistConfigsForSymbolAndChain(stablecoin, row.chain_id);
          return matches.length === 1 ? matches[0] : undefined;
        })();
  if (config) return { row, kind: "resolved", config };

  const matches = getBlacklistConfigsForSymbolAndChain(stablecoin, row.chain_id);
  return { row, kind: matches.length > 1 ? "ambiguous_config" : "missing_config" };
}

export async function handleRemediateBlacklistAmountGaps(
  db: D1Database,
  url: URL,
  trustedAdmin: boolean | undefined,
  request: Request | undefined,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<Response> {
  const authErr = await requireAdmin(request, trustedAdmin);
  if (authErr) return authErr;

  const body = await readBodyJson(request);
  const dryRun = parseBooleanInput(body.dryRun ?? url.searchParams.get("dryRun"), true);
  const onlyMissingProvenance = parseBooleanInput(
    body.onlyMissingProvenance ?? url.searchParams.get("onlyMissingProvenance"),
    true,
  );

  const limitParam = parseIntParam(url.searchParams.get("limit"), 25, 1, 200, "limit");
  if (limitParam instanceof Response) return limitParam;
  const limit = typeof body.limit === "number" ? Math.trunc(body.limit) : limitParam;
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    return errorResponse(400, "Invalid limit parameter");
  }

  const maxAttemptsParam = parseIntParam(url.searchParams.get("maxAttempts"), 25, 0, 10_000, "maxAttempts");
  if (maxAttemptsParam instanceof Response) return maxAttemptsParam;
  const maxAttempts = typeof body.maxAttempts === "number" ? Math.trunc(body.maxAttempts) : maxAttemptsParam;

  const chainId = typeof body.chainId === "string" ? body.chainId.trim().toLowerCase() : url.searchParams.get("chainId")?.trim().toLowerCase() ?? null;
  const stablecoinInput = typeof body.stablecoin === "string"
    ? body.stablecoin.trim().toUpperCase()
    : url.searchParams.get("stablecoin")?.trim().toUpperCase() ?? null;
  if (stablecoinInput && !VALID_STABLECOINS.has(stablecoinInput as BlacklistStablecoin)) {
    return errorResponse(400, "Invalid stablecoin parameter");
  }

  const conditions = [`amount_status IN (${RECOVERABLE_GAP_STATUSES.map(() => "?").join(", ")})`];
  const binds: Array<string | number> = [...RECOVERABLE_GAP_STATUSES];
  if (onlyMissingProvenance) {
    conditions.push("(contract_address IS NULL OR config_key IS NULL)");
  }
  if (chainId) {
    conditions.push("chain_id = ?");
    binds.push(chainId);
  }
  if (stablecoinInput) {
    conditions.push("stablecoin = ?");
    binds.push(stablecoinInput);
  }
  if (maxAttempts > 0) {
    conditions.push("COALESCE(amount_attempt_count, 0) <= ?");
    binds.push(maxAttempts);
  }

  const rows = await db
    .prepare(
      `SELECT id, stablecoin, chain_id, event_type, address, block_number, timestamp, amount_status,
              amount_attempt_count, amount_last_attempted_at, contract_address, config_key
       FROM blacklist_events
       WHERE ${conditions.join(" AND ")}
       ORDER BY timestamp ASC, id ASC
       LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<GapRow>();

  const candidates = (rows.results ?? []).map(resolveCandidate);
  const resolutionCounts = candidates.reduce(
    (acc, candidate) => {
      acc[candidate.kind] = (acc[candidate.kind] ?? 0) + 1;
      return acc;
    },
    { resolved: 0, missing_config: 0, ambiguous_config: 0 } as Record<ResolvedCandidate["kind"], number>,
  );

  if (dryRun) {
    return jsonResponse({
      ok: true,
      dryRun: true,
      filters: {
        chainId,
        stablecoin: stablecoinInput,
        onlyMissingProvenance,
        maxAttempts,
        limit,
      },
      candidateCount: candidates.length,
      resolutionCounts,
      sample: candidates.slice(0, 10).map((candidate) => ({
        id: candidate.row.id,
        chainId: candidate.row.chain_id,
        stablecoin: candidate.row.stablecoin,
        eventType: candidate.row.event_type,
        timestamp: candidate.row.timestamp,
        attemptCount: candidate.row.amount_attempt_count ?? 0,
        resolution: candidate.kind,
        configKey: candidate.kind === "resolved" ? candidate.config.configKey : null,
      })),
    });
  }

  if (!chainRpcs) {
    return errorResponse(500, "chainRpcs are unavailable");
  }

  const budget = createBudget(900);
  const limiter = createRateLimiter(4);
  const updates: D1PreparedStatement[] = [];
  const attemptAt = Math.floor(Date.now() / 1000);
  let resolved = 0;
  let resolvedZero = 0;
  let providerFailed = 0;
  let configMissing = 0;
  let configAmbiguous = 0;

  for (const candidate of candidates) {
    if (candidate.kind !== "resolved") {
      const errorClass = candidate.kind === "ambiguous_config" ? "ambiguous_config" : "config_missing";
      if (candidate.kind === "ambiguous_config") configAmbiguous++;
      if (candidate.kind === "missing_config") configMissing++;
      updates.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = ?,
               amount_last_provider = ?
           WHERE id = ?`,
        ).bind(attemptAt, errorClass, "none", candidate.row.id),
      );
      continue;
    }

    const { row, config } = candidate;
    if (config.chain.type !== "evm" || config.chain.evmChainId == null) {
      providerFailed++;
      updates.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = ?,
               amount_last_provider = ?,
               amount_status = ?
           WHERE id = ?`,
        ).bind(attemptAt, "provider_unsupported", "none", "provider_failed", row.id),
      );
      continue;
    }

    const amount = await fetchEvmTokenBalance(
      config,
      row.address,
      row.block_number - 1,
      null,
      null,
      limiter,
      budget,
      undefined,
      chainRpcs,
    );

    if (amount == null) {
      providerFailed++;
      updates.push(
        db.prepare(
          `UPDATE blacklist_events
           SET amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
               amount_last_attempted_at = ?,
               amount_last_error_class = ?,
               amount_last_provider = ?,
               amount_status = ?
           WHERE id = ?`,
        ).bind(attemptAt, "provider_null", "chain_rpc", "provider_failed", row.id),
      );
      continue;
    }

    resolved++;
    if (amount === 0) resolvedZero++;
    updates.push(
      db.prepare(
        `UPDATE blacklist_events
         SET amount = ?,
             amount_native = ?,
             amount_usd_at_event = ?,
             amount_source = ?,
             amount_status = ?,
             contract_address = COALESCE(contract_address, ?),
             config_key = COALESCE(config_key, ?),
             amount_attempt_count = COALESCE(amount_attempt_count, 0) + 1,
             amount_last_attempted_at = ?,
             amount_last_error_class = NULL,
             amount_last_provider = ?
         WHERE id = ?`,
      ).bind(
        amount,
        amount,
        computeBlacklistAmountUsdAtEvent(config.stablecoin, amount),
        "historical_balance",
        "resolved",
        config.contractAddress,
        config.configKey,
        attemptAt,
        "chain_rpc",
        row.id,
      ),
    );
  }

  if (updates.length > 0) {
    await db.batch(updates);
  }

  return jsonResponse({
    ok: true,
    dryRun: false,
    filters: {
      chainId,
      stablecoin: stablecoinInput,
      onlyMissingProvenance,
      maxAttempts,
      limit,
    },
    candidateCount: candidates.length,
    resolutionCounts,
    applied: {
      resolved,
      resolvedZero,
      providerFailed,
      configMissing,
      configAmbiguous,
      budgetUsed: budget.count,
      budgetLimit: budget.limit,
    },
  });
}
