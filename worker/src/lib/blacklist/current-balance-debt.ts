import { CONTRACT_CONFIGS } from "../blacklist-contracts";
import { blacklistEventOrderSql } from "@shared/lib/blacklist-event-order";
import { CURRENT_BALANCE_DEBT_PREFIX, syncCurrentBalanceCacheForRows, type CurrentBalanceFetchContext } from "./current-balance-cache";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached } from "./run-budget";
import type { BlacklistRow } from "./shared";
import { canonicalBlacklistAddress } from "@shared/lib/tron-address";
import { blacklistAddressSpellings } from "../tron-address";

export async function reconcileCurrentBalanceDebt(
  db: D1Database,
  context: CurrentBalanceFetchContext,
  circuits: { etherscanAllowed: boolean; tronGridAllowed: boolean },
): Promise<void> {
  const candidates = await db.prepare(`SELECT events.* FROM cache AS debt
    JOIN blacklist_events AS events ON events.id = debt.value
    WHERE debt.key GLOB '${CURRENT_BALANCE_DEBT_PREFIX}*'
    ORDER BY debt.updated_at, debt.key LIMIT 24`).all<BlacklistRow>();
  const seen = new Set<string>();
  for (const row of candidates.results ?? []) {
    if (blacklistRuntimeBudgetReached(context.runBudget) || blacklistSubrequestBudgetReached(context.runBudget)) break;
    const identity = `${row.config_key}:${canonicalBlacklistAddress(row.chain_id, row.address)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const config = CONTRACT_CONFIGS.find((candidate) => candidate.configKey === row.config_key);
    if (!config) continue;
    if (config.chain.type === "tron" ? !circuits.tronGridAllowed : !circuits.etherscanAllowed) continue;
    const history = await db.prepare(`SELECT * FROM blacklist_events
      WHERE config_key = ? AND (LOWER(address) IN (?, ?) OR address = ?) AND suppression_reason IS NULL
      ORDER BY ${blacklistEventOrderSql("ASC")}`)
      .bind(config.configKey, ...await blacklistAddressSpellings(row.chain_id, row.address)).all<BlacklistRow>();
    await syncCurrentBalanceCacheForRows(db, config, history.results ?? [], context);
    // Rotate unresolved/provider-failed work behind untouched debt. No TTL.
    await db.prepare(`UPDATE cache SET updated_at = ? WHERE key = ?`)
      .bind(Math.floor(Date.now() / 1000), `${CURRENT_BALANCE_DEBT_PREFIX}${row.id}`).run();
  }
}
