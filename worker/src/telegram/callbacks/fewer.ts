import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { DEWS_BAND_CODE_BY_VALUE, TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import { isDepegStepValue, TELEGRAM_DEWS_BANDS, type TelegramDewsBand } from "@shared/types/status/telegram";
import { executeAtomicBatch } from "../../lib/db";
import { FEWER_FAMILY_SETTING_CODES, nextFewerSettingValue } from "../common/alerts-formatting";
import { prepareCoinSettingStatements } from "../webhook/telegram-webhook-settings-mutations";
import {
  callbackChatType,
  callbackUsername,
  hasExactParts,
  isSubscribableStablecoinId,
  runCallbackMutation,
  type CallbackHandler,
} from "./_shared";

const FEWER_CODES = new Set<string>(Object.values(FEWER_FAMILY_SETTING_CODES));
const DEPEG_CODE = TELEGRAM_ALERT_PERSISTENCE.depeg.settingCode;
const DEWS_CODE = TELEGRAM_ALERT_PERSISTENCE.dews.settingCode;

const OFF_LABEL_BY_CODE: Record<string, string> = {
  [DEPEG_CODE]: "depeg alerts",
  [DEWS_CODE]: "stress alerts",
  [TELEGRAM_ALERT_PERSISTENCE.safety.settingCode]: "Safety alerts",
  [TELEGRAM_ALERT_PERSISTENCE.freeze.settingCode]: "freeze alerts",
  [TELEGRAM_ALERT_PERSISTENCE.reserve.settingCode]: "reserve alerts",
};

interface FewerTarget {
  id: string;
  code: string;
  /** `/settings` value: a depeg step, a DEWS band code, or "0" for off. */
  value: string;
}

/**
 * The coin's current effective tuning for the family, as a `/settings` value:
 * "0" when the family is off for the coin (explicit per-coin off, or nothing
 * routes it any more), a depeg step or DEWS band code, or null for a depeg
 * follow without a worsening step. A direct row that owns the family wins;
 * otherwise the strictest of every followed preset and the global follow
 * (preset membership is not resolved, which can only make this quieter).
 */
async function loadEffectiveFewerSetting(db: D1Database, chatId: string, id: string, code: string): Promise<string | null> {
  const [direct, presets, subscriber] = await Promise.all([
    db.prepare(
      `SELECT alert_depeg, alert_depeg_override, alert_dews, alert_dews_override,
              depeg_worsening_bps_step, dews_min_band
         FROM telegram_subscriptions
        WHERE chat_id = ? AND stablecoin_id = ?`,
    ).bind(chatId, id).first<{
      alert_depeg: number | null; alert_depeg_override: number | null;
      alert_dews: number | null; alert_dews_override: number | null;
      depeg_worsening_bps_step: number | null; dews_min_band: string | null;
    }>(),
    db.prepare(
      `SELECT alert_depeg, alert_dews, depeg_worsening_bps_step
         FROM telegram_preset_subscriptions
        WHERE chat_id = ? AND (alert_depeg = 1 OR alert_dews = 1)`,
    ).bind(chatId).all<{ alert_depeg: number | null; alert_dews: number | null; depeg_worsening_bps_step: number | null }>(),
    db.prepare(
      `SELECT global_alert_depeg, global_alert_dews, global_depeg_worsening_bps_step
         FROM telegram_subscribers
        WHERE chat_id = ?`,
    ).bind(chatId).first<{ global_alert_depeg: number | null; global_alert_dews: number | null; global_depeg_worsening_bps_step: number | null }>(),
  ]);
  const presetRows = presets.results ?? [];
  if (code === DEWS_CODE) {
    if (direct?.alert_dews === 1) {
      return DEWS_BAND_CODE_BY_VALUE[
        TELEGRAM_DEWS_BANDS.includes(direct.dews_min_band as TelegramDewsBand) ? direct.dews_min_band as TelegramDewsBand : TELEGRAM_DEWS_BANDS[0]
      ];
    }
    const inherited = direct?.alert_dews_override !== 1 &&
      (presetRows.some((row) => row.alert_dews === 1) || subscriber?.global_alert_dews === 1);
    // Presets and global DEWS have no floor tuning: they alert from ALERT.
    return inherited ? DEWS_BAND_CODE_BY_VALUE[TELEGRAM_DEWS_BANDS[0]] : "0";
  }
  if (direct?.alert_depeg === 1) {
    return isDepegStepValue(direct.depeg_worsening_bps_step) ? String(direct.depeg_worsening_bps_step) : null;
  }
  if (direct?.alert_depeg_override === 1) return "0";
  const sources = [
    ...presetRows.filter((row) => row.alert_depeg === 1),
    ...(subscriber?.global_alert_depeg === 1 ? [{ depeg_worsening_bps_step: subscriber.global_depeg_worsening_bps_step }] : []),
  ];
  if (sources.length === 0) return "0";
  const steps = sources.map((row) => row.depeg_worsening_bps_step).filter(isDepegStepValue);
  return steps.length > 0 ? String(Math.max(...steps)) : null;
}

/** Quietness rank of a `/settings` value: higher is quieter, off is quietest. */
function fewerRank(code: string, value: string): number {
  if (value === "0") return Number.POSITIVE_INFINITY;
  if (code === DEPEG_CODE) return Number(value);
  return TELEGRAM_DEWS_BANDS.findIndex((band) => DEWS_BAND_CODE_BY_VALUE[band] === value);
}

/**
 * The value a tap writes. Safety, freeze and reserve always turn off. A
 * carried value (or, for legacy buttons, one notch above the current value)
 * is clamped so it is never noisier than the current effective setting and
 * never re-enables a sub-alert that is off: a depeg follow without a step has
 * worsening alerts off, and any step would turn them on.
 */
async function resolveFewerValue(
  db: D1Database,
  chatId: string,
  id: string,
  code: string,
  carried: string | undefined,
): Promise<string> {
  if (code !== DEPEG_CODE && code !== DEWS_CODE) return "0";
  const current = await loadEffectiveFewerSetting(db, chatId, id, code);
  if (current === "0" || (code === DEPEG_CODE && current == null)) return "0";
  if (carried == null) {
    return nextFewerSettingValue(code, code === DEPEG_CODE
      ? Number(current)
      : TELEGRAM_DEWS_BANDS.find((band) => DEWS_BAND_CODE_BY_VALUE[band] === current));
  }
  return fewerRank(code, carried) >= fewerRank(code, current!) ? carried : current!;
}

function fewerToast({ id, code, value }: FewerTarget, privateChat: boolean): string {
  const symbol = TRACKED_META_BY_ID.get(id)?.symbol ?? id;
  const undo = privateChat ? "Undo in Manage Alerts." : "Undo with /settings.";
  if (value === "0") return `${symbol}: ${OFF_LABEL_BY_CODE[code]} off. ${undo}`;
  if (code === DEPEG_CODE) return `${symbol}: depeg alerts now only past ${(Number(value) / 100).toFixed(1)}%. ${undo}`;
  const band = TELEGRAM_DEWS_BANDS.find((candidate) => DEWS_BAND_CODE_BY_VALUE[candidate] === value);
  return `${symbol}: stress alerts now only at ${band} and above. ${undo}`;
}

/** A carried target value must be one the family's setting accepts. */
function isFewerValueFor(code: string, value: string): boolean {
  if (value === "0") return true;
  if (code === DEPEG_CODE) return isDepegStepValue(Number(value));
  if (code === DEWS_CODE) return TELEGRAM_DEWS_BANDS.some((band) => DEWS_BAND_CODE_BY_VALUE[band] === value);
  return false;
}

/**
 * "Fewer like this" under an alert (`fewer:<coinId>:<settingCode>:<value>`).
 * The button carries the target value, computed from the tuning that routed
 * the alert, so a repeated or retried tap sets the same value instead of
 * stepping again: depeg raises the worsening step, DEWS raises the minimum
 * band, and Safety, freeze and reserve turn off for that coin. A stale tap
 * never undoes a later quieter setting (`resolveFewerValue` clamps it). Buttons
 * sent before the value was carried (`fewer:<coinId>:<settingCode>`) step
 * from the current effective settings.
 */
export const handleFewerCallback: CallbackHandler = async (context) => {
  const { db, cb, chatId, parsed } = context;
  const code = parsed.parts[2] ?? "";
  const carried = parsed.parts[3];
  const valid = isSubscribableStablecoinId(parsed.arg) && FEWER_CODES.has(code) && (
    hasExactParts(parsed.parts, 3) || (hasExactParts(parsed.parts, 4) && carried != null && isFewerValueFor(code, carried))
  );
  const value = !valid ? null : await resolveFewerValue(db, chatId, parsed.arg!, code, carried);
  await runCallbackMutation<FewerTarget>(context, {
    validate: () => (valid && value != null ? { id: parsed.arg!, code, value } : null),
    requireAdmin: true,
    eventType: "subscribe",
    actionDetail: "fewer",
    logAction: "fewer",
    logMessage: "fewer callback write failed",
    write: async ({ id, code: setting, value: next }, options) => {
      const prepared = prepareCoinSettingStatements(db, chatId, callbackUsername(cb), id, setting, next);
      await executeAtomicBatch(db, [...prepared.statements, ...(options.operationStatements ?? [])]);
    },
    successText: (target) => fewerToast(target, callbackChatType(cb) === "private"),
    failureText: "Could not save setting. Please try again.",
  });
};
