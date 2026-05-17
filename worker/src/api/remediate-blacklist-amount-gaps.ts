import { BLACKLIST_STABLECOINS, type BlacklistStablecoin } from "@shared/types/market";
import { getBlacklistPriceAssetId } from "@shared/lib/blacklist";
import { requireAdmin } from "../lib/auth";
import { runTrustedAdminMutation } from "../lib/route-wrappers";
import { errorResponse, jsonResponse, parseOptionalRequestJsonObject, parseQueryParams } from "../lib/api-utils";
import {
  getBlacklistConfigByContract,
  getBlacklistConfigByKey,
  getBlacklistConfigsForSymbolAndChain,
  type ContractEventConfig,
} from "../lib/blacklist-contracts";
import { createBudget, createRateLimiter } from "../lib/evm-logs";
import type { ChainRpcConfig } from "../lib/chain-registry";
import {
  recoverBlacklistAmountForRow,
} from "../cron/blacklist/amount-recovery";
import {
  blacklistRuntimeBudgetReached,
  blacklistSubrequestBudgetReached,
  type BlacklistRunBudget,
} from "../cron/blacklist/run-budget";
import { fetchBlacklistAssetPriceFromCache } from "../cron/blacklist/row-preparation";

const VALID_STABLECOINS = new Set<BlacklistStablecoin>(BLACKLIST_STABLECOINS);
const RECOVERABLE_GAP_STATUSES = ["recoverable_pending", "provider_failed", "ambiguous"] as const;
const RUNTIME_BUDGET_MS = 8 * 60_000;

type GapRow = {
  id: string;
  stablecoin: string;
  chain_id: string;
  event_type: string;
  address: string;
  tx_hash: string;
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

  return handleRemediateBlacklistAmountGapsTrusted(db, url, request, chainRpcs);
}

export async function handleRemediateBlacklistAmountGapsTrusted(
  db: D1Database,
  url: URL,
  request: Request | undefined,
  chainRpcs?: Map<string, ChainRpcConfig>,
): Promise<Response> {
  return runTrustedAdminMutation(async () => {
    const body = await parseOptionalRequestJsonObject(request);
    if (body instanceof Response) return body;
    const dryRun = parseBooleanInput(body.dryRun ?? url.searchParams.get("dryRun"), true);
    const onlyMissingProvenance = parseBooleanInput(
      body.onlyMissingProvenance ?? url.searchParams.get("onlyMissingProvenance"),
      false,
    );

    const numericParams = parseQueryParams(url.searchParams, {
      limit: { type: "int", default: 25, min: 1, max: 200 },
      maxAttempts: { type: "int", default: 25, min: 0, max: 10_000 },
    });
    if (numericParams instanceof Response) return numericParams;
    const { limit: limitParam, maxAttempts: maxAttemptsParam } = numericParams;
    const limit = typeof body.limit === "number" ? Math.trunc(body.limit) : limitParam;
    if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
      return errorResponse(400, "Invalid limit parameter");
    }

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
        `SELECT id, stablecoin, chain_id, event_type, address, tx_hash, block_number, timestamp, amount_status,
                amount_attempt_count, amount_last_attempted_at, contract_address, config_key
         FROM blacklist_events
         WHERE ${conditions.join(" AND ")}
         ORDER BY timestamp ASC, id ASC
         LIMIT ?`,
      )
      .bind(...binds, limit + 1)
      .all<GapRow>();

    const selectedRows = rows.results ?? [];
    const truncated = selectedRows.length > limit;
    const candidates = selectedRows.slice(0, limit).map(resolveCandidate);
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
        truncated,
        budgetExhausted: false,
        skippedDueBudget: 0,
        budgetUsed: 0,
        budgetLimit: 900,
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
    const runBudget = {
      subrequestBudget: budget,
      deadlineMs: Date.now() + RUNTIME_BUDGET_MS,
      minimumConfigWindowMs: 0,
    } satisfies BlacklistRunBudget;
    const assetPriceCache = new Map<BlacklistStablecoin, number | null>();
    const updates: D1PreparedStatement[] = [];
    const attemptAt = Math.floor(Date.now() / 1000);
    let resolved = 0;
    let resolvedZero = 0;
    let providerFailed = 0;
    let configMissing = 0;
    let configAmbiguous = 0;
    let budgetExhausted = false;
    let skippedDueBudget = 0;

    for (let index = 0; index < candidates.length; index++) {
      if (blacklistRuntimeBudgetReached(runBudget) || blacklistSubrequestBudgetReached(runBudget)) {
        budgetExhausted = true;
        skippedDueBudget = candidates.length - index;
        break;
      }

      const candidate = candidates[index]!;
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
      let assetPriceUsd = assetPriceCache.get(config.stablecoin);
      if (!assetPriceCache.has(config.stablecoin)) {
        assetPriceUsd = getBlacklistPriceAssetId(config.stablecoin)
          ? await fetchBlacklistAssetPriceFromCache(db, config.stablecoin)
          : null;
        assetPriceCache.set(config.stablecoin, assetPriceUsd ?? null);
      }

      const recovery = await recoverBlacklistAmountForRow(row, config, {
        etherscanApiKey: null,
        drpcApiKey: null,
        etherscanLimiter: limiter,
        runBudget,
        chainRpcs,
        assetPriceUsd,
      });

      if (recovery.amount == null) {
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
          ).bind(
            attemptAt,
            recovery.lastErrorClass ?? "provider_null",
            recovery.lastProvider,
            recovery.amountStatus,
            row.id,
          ),
        );
        continue;
      }

      resolved++;
      if (recovery.amount === 0) resolvedZero++;
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
          recovery.amount,
          recovery.amount,
          recovery.amountUsd,
          recovery.amountSource,
          recovery.amountStatus,
          config.contractAddress,
          config.configKey,
          attemptAt,
          recovery.lastProvider,
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
      truncated,
      budgetExhausted,
      skippedDueBudget,
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
  });
}
