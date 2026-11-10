import { sha256Hex } from "@shared/lib/sha256";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { WORKER_ACTIVE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { throwIfAborted } from "../lib/abort";
import { createCronResult } from "../lib/cron-result";
import { getCache, setCache } from "../lib/db-cache";
import { MINT_BURN_CONFIGS } from "../lib/mint-burn-contracts";
import { readMintBurnWindowContext } from "../lib/mint-burn-flows-service";
import { readMintBurnSupplyReconciliation } from "../lib/mint-burn-supply-reconciliation";
import { deliverOperatorAlert, escapeOperatorAlertHtml as escapeHtml, type OperatorTelegramCreds as TelegramCreds } from "./cron-sentinel-rules";

const ALERT_STATE_KEY = "mint-burn:daily-reconciliation:delivered";

/** Reads durable receipts only; missing/unsupported evidence is diagnostic, never an alert. */
export async function runMintBurnReconciliationWatchdog(db: D1Database, options: {
  nowSec: number;
  signal?: AbortSignal;
  operatorTelegramCreds?: TelegramCreds | null;
}) {
  const { nowSec, signal, operatorTelegramCreds } = options;
  throwIfAborted(signal);
  const context = await readMintBurnWindowContext(db, nowSec,
    MINT_BURN_CONFIGS.filter((config) => WORKER_ACTIVE_IDS.has(config.stablecoinId)));
  const legs = await readMintBurnSupplyReconciliation(db, context.diagnosticConfigs, nowSec);
  // Keep one latest finding per leg/kind; older unresolved days remain in /status.
  const findings = [...legs.values()].flatMap((leg) => {
    const latest = new Map<string, (typeof leg.activeFindings)[number]>();
    for (const finding of leg.activeFindings) {
      if ((latest.get(finding.status)?.day ?? -1) < finding.day) latest.set(finding.status, finding);
    }
    return [...latest.values()].map((finding) => ({ configKey: leg.configKey, ...finding }));
  }).sort((a, b) => a.configKey.localeCompare(b.configKey) || a.status.localeCompare(b.status));
  const firedRuleIds = [...new Set(findings.map((finding) => `mint-burn-${finding.status}`))];
  const signature = sha256Hex(JSON.stringify(findings));
  const previous = await getCache(db, ALERT_STATE_KEY, signal);
  const changed = previous?.value !== signature;
  let delivered = false;
  let deliveryReason: string | null = null;
  if (changed && findings.length > 0) {
    if (!operatorTelegramCreds) deliveryReason = "operator-alert-credentials-missing";
    else {
      const lines = findings.slice(0, 10).map((finding) =>
        `${escapeHtml(finding.configKey)} · ${new Date(finding.day * 1000).toISOString().slice(0, 10)} · ${finding.status}`);
      const result = await deliverOperatorAlert(operatorTelegramCreds,
        `<b>Mint/Burn daily reconciliation</b>\n${lines.join("\n")}\n${findings.length} finding(s). Details: ${SITE_ORIGIN}/status/`, signal);
      if (result.ok) delivered = true;
      else deliveryReason = "operator-alert-delivery-failed";
    }
  }
  // Failed delivery must remain pending; observing the same finding cannot acknowledge it.
  if (changed && (findings.length === 0 || delivered)) await setCache(db, ALERT_STATE_KEY, signature, signal);
  const statusCounts = Object.fromEntries(["ok", "unexplained-residual", "review-suppression", "unavailable", "unsupported-law"]
    .map((status) => [status, [...legs.values()].filter((leg) => leg.status === status).length]));
  const metadata = {
    checkedAt: nowSec,
    statusCounts,
    firedRuleIds,
    ...(findings.length ? { quality: { reason: "mint-burn-supply-reconciliation", reasons: firedRuleIds,
      findingCount: findings.length, findings: findings.slice(0, 10) } } : {}),
    alerts: { operatorConfigured: operatorTelegramCreds != null, pending: changed && findings.length > 0 && !delivered,
      delivered, reason: deliveryReason },
  };
  return deliveryReason
    ? createCronResult({ status: "degraded", itemCount: legs.size, metadata: { ...metadata, reason: deliveryReason } })
    : createCronResult({ itemCount: legs.size, metadata });
}
