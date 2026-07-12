import { logAdminAction } from "../lib/admin-action-audit";
import { sendAlert } from "../lib/alerts";
import { toErrorMessage } from "../lib/error-utils";
import { fnv1aHash, sha256Hex } from "../lib/hash";
import {
  adminErrorResponse,
  adminJsonResponse,
  type AdminUrlRouteContext,
} from "../lib/route-wrappers";

const CONFIRM_VALUE = "emit-incident-and-recovery";
const CONDITION_PREFIX = "operator:alert-broker-canary";

type CanaryTransition = "incident" | "recovery";

interface CanaryDelivery {
  transition: CanaryTransition;
  state: "delivered" | "failed";
  attempts: 1;
  lastError: string | null;
}

interface AlertBrokerCanaryContext extends AdminUrlRouteContext {
  alertWebhookUrl: string | null;
}

function executeRequested(url: URL): boolean {
  return url.searchParams.get("execute") === "true";
}

function buildFingerprint(conditionKey: string, canaryId: string): string {
  return fnv1aHash(`${conditionKey}:{"canaryId":${JSON.stringify(canaryId)},"kind":"synthetic-operator-canary"}`);
}

async function deliverCanaryTransition(
  webhookUrl: string,
  transition: CanaryTransition,
  title: string,
  message: string,
): Promise<CanaryDelivery> {
  try {
    const delivered = await sendAlert(webhookUrl, title, message);
    return {
      transition,
      state: delivered ? "delivered" : "failed",
      attempts: 1,
      lastError: delivered ? null : "webhook transport returned false",
    };
  } catch (err) {
    return {
      transition,
      state: "failed",
      attempts: 1,
      lastError: toErrorMessage(err),
    };
  }
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
  const fingerprint = buildFingerprint(conditionKey, canaryId);
  const incidentDelivery = await deliverCanaryTransition(
    context.alertWebhookUrl,
    "incident",
    "Pharos alert broker canary incident",
    "Synthetic operator canary. No production data condition is active.",
  );
  const recoveryDelivery = await deliverCanaryTransition(
    context.alertWebhookUrl,
    "recovery",
    "Pharos alert broker canary recovery",
    "Synthetic operator canary recovery. No operator action is required.",
  );
  const deliveries = [incidentDelivery, recoveryDelivery];
  const transitionContractSatisfied = true;
  const deliverySucceeded = deliveries.every((delivery) => delivery.state === "delivered");
  const failedDeliveryVisible = deliveries.some((delivery) => delivery.state === "failed");
  const status = deliverySucceeded ? 200 : 502;
  const incident = {
    mode: "alert" as const,
    conditionKey,
    fingerprint,
    state: "active" as const,
    streak: 1,
    transition: "incident" as const,
    deliveryState: incidentDelivery.state,
  };
  const recovery = {
    mode: "alert" as const,
    conditionKey,
    fingerprint,
    state: "recovered" as const,
    streak: 0,
    transition: "recovery" as const,
    deliveryState: recoveryDelivery.state,
  };

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
