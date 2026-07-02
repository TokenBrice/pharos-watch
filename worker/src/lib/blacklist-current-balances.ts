import {
  buildBlacklistAddressCountKey,
  buildBlacklistContractBalanceKey,
} from "@shared/lib/blacklist";
import type { BlacklistStablecoin } from "@shared/types/market";
import type { D1Database } from "@cloudflare/workers-types";
import { recordRuntimeFallbackUsage } from "./runtime-fallback-telemetry";

export interface BlacklistCurrentBalanceRow {
  id: string;
  stablecoin: BlacklistStablecoin;
  chainId: string;
  address: string;
  configKey: string | null;
  contractAddress: string | null;
  amountNative: number | null;
  amountUsd: number | null;
  source: string;
  status: "resolved" | "provider_failed";
  observedAt: number;
  lastSuccessfulObservedAt: number | null;
  attemptCount: number;
  lastAttemptedAt: number | null;
  lastErrorClass: string | null;
  consecutiveFailures: number;
}

function buildBlacklistCurrentBalanceId(
  stablecoin: BlacklistStablecoin,
  chainId: string,
  address: string,
  configKey?: string | null,
  contractAddress?: string | null,
): string {
  return buildBlacklistContractBalanceKey(stablecoin, chainId, address, configKey, contractAddress);
}

class BlacklistCurrentBalanceMap extends Map<string, BlacklistCurrentBalanceRow> {
  private readonly legacyFallbacks = new Map<string, BlacklistCurrentBalanceRow | null>();
  private readonly loggedLegacyFallbackKeys = new Set<string>();

  addLegacyFallback(key: string, row: BlacklistCurrentBalanceRow): void {
    this.legacyFallbacks.set(key, this.legacyFallbacks.has(key) ? null : row);
  }

  override get(key: string): BlacklistCurrentBalanceRow | undefined {
    const scoped = super.get(key);
    if (scoped) return scoped;
    const legacy = this.legacyFallbacks.get(key) ?? undefined;
    if (legacy && !this.loggedLegacyFallbackKeys.has(key)) {
      this.loggedLegacyFallbackKeys.add(key);
      recordRuntimeFallbackUsage("blacklist-current-balance-legacy-identity", {
        key,
        stablecoin: legacy.stablecoin,
        chainId: legacy.chainId,
      });
    }
    return legacy;
  }
}

async function markExistingCurrentBalanceProviderFailed(
  db: D1Database,
  row: Omit<BlacklistCurrentBalanceRow, "id">,
  id: string,
  options: { attachIdentity: boolean },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE blacklist_current_balances
       SET config_key = CASE WHEN ? = 1 THEN COALESCE(?, config_key) ELSE config_key END,
           contract_address = CASE WHEN ? = 1 THEN COALESCE(?, contract_address) ELSE contract_address END,
           status = ?,
           observed_at = CASE
             WHEN amount_native IS NOT NULL OR amount_usd IS NOT NULL THEN observed_at
             ELSE ?
           END,
           last_successful_observed_at = COALESCE(
             last_successful_observed_at,
             CASE WHEN status = 'resolved' THEN observed_at ELSE NULL END
           ),
           attempt_count = attempt_count + 1,
           last_attempted_at = ?,
           last_error_class = ?,
           consecutive_failures = COALESCE(consecutive_failures, 0) + 1
       WHERE id = ?`,
    )
    .bind(
      options.attachIdentity ? 1 : 0,
      row.configKey,
      options.attachIdentity ? 1 : 0,
      row.contractAddress,
      row.status,
      row.observedAt,
      row.lastAttemptedAt,
      row.lastErrorClass,
      id,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function loadBlacklistCurrentBalanceMap(
  db: D1Database,
): Promise<Map<string, BlacklistCurrentBalanceRow>> {
  const result = await db
    .prepare(
      `SELECT id, stablecoin, chain_id, address, config_key, contract_address,
              amount_native, amount_usd, source, status, observed_at,
              last_successful_observed_at, attempt_count, last_attempted_at,
              last_error_class, consecutive_failures
       FROM blacklist_current_balances`,
    )
    .all<{
      id: string;
      stablecoin: BlacklistStablecoin;
      chain_id: string;
      address: string;
      config_key: string | null;
      contract_address: string | null;
      amount_native: number | null;
      amount_usd: number | null;
      source: string;
      status: "resolved" | "provider_failed";
      observed_at: number;
      last_successful_observed_at: number | null;
      attempt_count: number;
      last_attempted_at: number | null;
      last_error_class: string | null;
      consecutive_failures: number | null;
    }>();

  const rows = (result.results ?? []).map((row) => {
    const snapshot: BlacklistCurrentBalanceRow = {
      id: row.id,
      stablecoin: row.stablecoin,
      chainId: row.chain_id,
      address: row.address,
      configKey: row.config_key ?? null,
      contractAddress: row.contract_address ?? null,
      amountNative: row.amount_native,
      amountUsd: row.amount_usd,
      source: row.source,
      status: row.status,
      observedAt: row.observed_at,
      lastSuccessfulObservedAt: row.last_successful_observed_at ?? (
        row.status === "resolved" ? row.observed_at : null
      ),
      attemptCount: row.attempt_count,
      lastAttemptedAt: row.last_attempted_at,
      lastErrorClass: row.last_error_class,
      consecutiveFailures: row.consecutive_failures ?? (row.status === "provider_failed" ? 1 : 0),
    };
    return snapshot;
  });

  const scopedAddressKeys = new Set<string>();
  for (const row of rows) {
    if (row.configKey != null || row.contractAddress != null) {
      scopedAddressKeys.add(buildBlacklistAddressCountKey(row.stablecoin, row.chainId, row.address));
    }
  }

  const map = new BlacklistCurrentBalanceMap();
  for (const row of rows) {
    const legacyKey = buildBlacklistAddressCountKey(row.stablecoin, row.chainId, row.address);
    if (row.configKey == null && row.contractAddress == null) {
      if (scopedAddressKeys.has(legacyKey)) continue;
    } else {
      map.addLegacyFallback(legacyKey, row);
    }
    map.set(
      buildBlacklistCurrentBalanceId(row.stablecoin, row.chainId, row.address, row.configKey, row.contractAddress),
      row,
    );
  }

  return map;
}

export async function upsertBlacklistCurrentBalance(
  db: D1Database,
  row: Omit<BlacklistCurrentBalanceRow, "id">,
): Promise<void> {
  const id = buildBlacklistCurrentBalanceId(
    row.stablecoin,
    row.chainId,
    row.address,
    row.configKey,
    row.contractAddress,
  );

  if (row.status === "provider_failed") {
    const updatedScoped = await markExistingCurrentBalanceProviderFailed(db, row, id, {
      attachIdentity: true,
    });
    if (updatedScoped) return;

    const legacyId = buildBlacklistAddressCountKey(row.stablecoin, row.chainId, row.address);
    if (legacyId !== id) {
      const updatedLegacy = await markExistingCurrentBalanceProviderFailed(db, row, legacyId, {
        attachIdentity: false,
      });
      if (updatedLegacy) return;
    }
  }

  await db
    .prepare(
      `INSERT INTO blacklist_current_balances
         (id, stablecoin, chain_id, address, config_key, contract_address,
          amount_native, amount_usd, source, status, observed_at,
          last_successful_observed_at, attempt_count, last_attempted_at,
          last_error_class, consecutive_failures)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         config_key = COALESCE(excluded.config_key, blacklist_current_balances.config_key),
         contract_address = COALESCE(excluded.contract_address, blacklist_current_balances.contract_address),
         amount_native = CASE
           WHEN excluded.status = 'provider_failed'
             THEN COALESCE(blacklist_current_balances.amount_native, excluded.amount_native)
           ELSE excluded.amount_native
         END,
         amount_usd = CASE
           WHEN excluded.status = 'provider_failed'
             THEN COALESCE(blacklist_current_balances.amount_usd, excluded.amount_usd)
           ELSE excluded.amount_usd
         END,
         source = CASE
           WHEN excluded.status = 'provider_failed'
             THEN COALESCE(blacklist_current_balances.source, excluded.source)
           ELSE excluded.source
         END,
         status = excluded.status,
         observed_at = CASE
           WHEN excluded.status = 'provider_failed'
             AND (blacklist_current_balances.amount_native IS NOT NULL OR blacklist_current_balances.amount_usd IS NOT NULL)
             THEN blacklist_current_balances.observed_at
           ELSE excluded.observed_at
         END,
         last_successful_observed_at = CASE
           WHEN excluded.status = 'provider_failed'
             THEN COALESCE(
               blacklist_current_balances.last_successful_observed_at,
               CASE
                 WHEN blacklist_current_balances.status = 'resolved' THEN blacklist_current_balances.observed_at
                 ELSE NULL
               END
             )
           ELSE excluded.observed_at
         END,
         attempt_count = blacklist_current_balances.attempt_count + 1,
         last_attempted_at = excluded.last_attempted_at,
         last_error_class = excluded.last_error_class,
         consecutive_failures = CASE
           WHEN excluded.status = 'provider_failed'
             THEN COALESCE(blacklist_current_balances.consecutive_failures, 0) + 1
           ELSE 0
         END`,
    )
    .bind(
      id,
      row.stablecoin,
      row.chainId,
      row.address,
      row.configKey,
      row.contractAddress,
      row.amountNative,
      row.amountUsd,
      row.source,
      row.status,
      row.observedAt,
      row.status === "resolved" ? row.observedAt : row.lastSuccessfulObservedAt,
      row.attemptCount,
      row.lastAttemptedAt,
      row.lastErrorClass,
      row.status === "provider_failed" ? row.consecutiveFailures || 1 : 0,
    )
    .run();
}
