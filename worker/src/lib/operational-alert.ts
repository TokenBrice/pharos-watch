import { reportAlertCondition, type AlertBrokerSeverity } from "./alert-broker";
import { sendAlert } from "./alerts";

export interface OperationalAlertInput {
  db: D1Database;
  conditionKey: string;
  active: boolean;
  severity: AlertBrokerSeverity;
  title: string;
  message: string;
  recoveryTitle?: string;
  recoveryMessage?: string;
  fingerprint?: unknown;
  metadata?: Record<string, unknown>;
  webhookUrl?: string | null;
  brokerMode?: string;
  minStreak?: number;
  cooldownSec?: number;
}

/**
 * Routes scheduled operational conditions through the durable broker. The
 * legacy fallback is retained only for non-scheduled callers that have not
 * supplied a broker mode; all scheduled runtime call sites pass one.
 */
export async function deliverOperationalAlert(input: OperationalAlertInput): Promise<boolean> {
  if (input.brokerMode == null) {
    if (!input.active) {
      return sendAlert(
        input.webhookUrl,
        input.recoveryTitle ?? `${input.title} recovered`,
        input.recoveryMessage ?? input.message,
      );
    }
    return sendAlert(input.webhookUrl, input.title, input.message);
  }

  await reportAlertCondition(input.db, {
    conditionKey: input.conditionKey,
    active: input.active,
    fingerprint: input.fingerprint ?? { conditionKey: input.conditionKey },
    severity: input.severity,
    title: input.title,
    message: input.message,
    recoveryTitle: input.recoveryTitle,
    recoveryMessage: input.recoveryMessage,
    metadata: input.metadata,
    minStreak: input.minStreak,
    cooldownSec: input.cooldownSec,
    mode: input.brokerMode,
    webhookUrl: input.webhookUrl,
  });
  return true;
}
