import {
  loadAlertBrokerEpisodeDeliveries,
  reportAlertCondition,
} from "../lib/alert-broker";
import { logAdminAction } from "../lib/admin-action-audit";
import { sha256Hex } from "../lib/hash";
import {
  adminErrorResponse,
  adminJsonResponse,
  type AdminUrlRouteContext,
} from "../lib/route-wrappers";

const CONFIRM_VALUE = "emit-incident-and-recovery";
const CONDITION_PREFIX = "operator:alert-broker-canary";

interface AlertBrokerCanaryContext extends AdminUrlRouteContext {
  alertWebhookUrl: string | null;
}

function executeRequested(url: URL): boolean {
  return url.searchParams.get("execute") === "true";
}

export async function handleAlertBrokerCanary(
  context: AlertBrokerCanaryContext,
): Promise<Response> {
  const targetConfigured = context.alertWebhookUrl != null;
  if (!executeRequested(context.url)) {
    await logAdminAction(context.db, {
      action: "alert-broker-canary",
      target: "configured-alert-webhook",
      result: "ok",
      httpStatus: 200,
      details: {
        dryRun: true,
        targetConfigured,
        requires: {
          execute: "true",
          confirm: CONFIRM_VALUE,
          idempotencyKey: true,
        },
      },
    }, context.request);
    return adminJsonResponse({
      ok: true,
      dryRun: true,
      targetConfigured,
      wouldEmit: ["incident", "recovery"],
      executeQuery: `?execute=true&confirm=${CONFIRM_VALUE}`,
      requiresIdempotencyKey: true,
    });
  }

  if (context.url.searchParams.get("confirm") !== CONFIRM_VALUE) {
    return adminErrorResponse(400, `Live canary requires confirm=${CONFIRM_VALUE}`);
  }
  const idempotencyKey = context.request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return adminErrorResponse(400, "Live canary requires an Idempotency-Key header between 8 and 128 characters");
  }
  if (!context.alertWebhookUrl) {
    return adminErrorResponse(409, "ALERT_WEBHOOK_URL is not configured; refusing a live canary");
  }

  const canaryId = (await sha256Hex(idempotencyKey)).slice(0, 24);
  const conditionKey = `${CONDITION_PREFIX}:${canaryId}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const common = {
    conditionKey,
    fingerprint: { canaryId, kind: "synthetic-operator-canary" },
    severity: "warning" as const,
    title: "Pharos alert broker canary incident",
    message: "Synthetic operator canary. No production data condition is active.",
    recoveryTitle: "Pharos alert broker canary recovery",
    recoveryMessage: "Synthetic operator canary recovery. No operator action is required.",
    metadata: { canaryId, synthetic: true, owner: "operator" },
    minStreak: 1,
    cooldownSec: 0,
    mode: "alert" as const,
    webhookUrl: context.alertWebhookUrl,
  };
  const incident = await reportAlertCondition(context.db, {
    ...common,
    active: true,
    nowSec,
  });
  const recovery = await reportAlertCondition(context.db, {
    ...common,
    active: false,
    nowSec: nowSec + 1,
  });
  const deliveries = await loadAlertBrokerEpisodeDeliveries(context.db, conditionKey, 1);
  const incidentRows = deliveries.filter((row) => row.transition === "incident");
  const recoveryRows = deliveries.filter((row) => row.transition === "recovery");
  const transitionContractSatisfied = incidentRows.length === 1 && recoveryRows.length === 1;
  const deliverySucceeded = transitionContractSatisfied
    && deliveries.every((row) => row.state === "delivered");
  const failedDeliveryVisible = deliveries.some((row) =>
    row.state === "failed" || row.state === "missing_target"
  );
  const status = deliverySucceeded ? 200 : 502;

  await logAdminAction(context.db, {
    action: "alert-broker-canary",
    target: conditionKey,
    result: deliverySucceeded ? "ok" : "error",
    httpStatus: status,
    details: {
      dryRun: false,
      canaryId,
      transitionContractSatisfied,
      deliverySucceeded,
      failedDeliveryVisible,
      incidentDeliveryState: incident.deliveryState,
      recoveryDeliveryState: recovery.deliveryState,
    },
  }, context.request);

  return adminJsonResponse({
    ok: deliverySucceeded,
    dryRun: false,
    canaryId,
    conditionKey,
    transitionContractSatisfied,
    deliverySucceeded,
    failedDeliveryVisible,
    incident,
    recovery,
    deliveries,
  }, { status });
}
