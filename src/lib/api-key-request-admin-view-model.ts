import type { ApiKeySelfServeRequestAdminSummary, ApiKeySelfServeStatus } from "@shared/types";

export const API_KEY_REQUEST_STATUS_FILTERS: readonly ("all" | ApiKeySelfServeStatus)[] = [
  "all",
  "pending_verification",
  "issued",
  "rejected",
  "blocked",
  "expired",
];

export const API_KEY_REQUEST_STATUS_LABELS: Record<"all" | ApiKeySelfServeStatus, string> = {
  all: "All",
  pending_verification: "Pending",
  issued: "Issued",
  rejected: "Rejected",
  blocked: "Blocked",
  expired: "Expired",
};

export const REQUEST_RISK_FLAG_SCORE = 50;

export const API_KEY_REQUEST_ACTION_LABELS = {
  reject: "reject",
  "release-claim": "release claim",
} as const;

export type ApiKeyRequestAction = keyof typeof API_KEY_REQUEST_ACTION_LABELS;

export interface ApiKeyRequestSummaryItem {
  label: string;
  value: string;
  detail: string;
}

export interface ApiKeyRequestCardViewModel {
  busy: boolean;
  canReject: boolean;
  canReleaseClaim: boolean;
  hasActiveUnexpiredKey: boolean;
  rejectLabel: string;
  releaseClaimLabel: string;
  releaseClaimTitle: string;
  requesterLabel: string;
  nextAction: string;
}

export function statusClassName(status: ApiKeySelfServeStatus): string {
  switch (status) {
    case "issued":
      return "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
    case "pending_verification":
      return "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-300";
    case "rejected":
    case "blocked":
      return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
    case "expired":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

export function formatApiKeyRequestTime(epochSeconds: number | null): string {
  if (epochSeconds == null) return "never";
  return new Date(epochSeconds * 1000).toLocaleString();
}

export function formatApiKeyRequestRelativeTime(epochSeconds: number | null, nowSeconds: number): string {
  if (epochSeconds == null) return "never";
  const delta = epochSeconds - nowSeconds;
  const abs = Math.abs(delta);
  const minutes = Math.round(abs / 60);
  if (minutes < 90) {
    return delta >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }
  const hours = Math.round(abs / 3600);
  if (hours < 48) {
    return delta >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  const days = Math.round(abs / 86_400);
  return delta >= 0 ? `in ${days}d` : `${days}d ago`;
}

export function describeRequester(request: ApiKeySelfServeRequestAdminSummary): string {
  return request.organization || request.requesterName || "Unlabeled requester";
}

export function createApiKeyRequestIdempotencyKey(action: ApiKeyRequestAction, requestId: string): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is required to generate a collision-resistant idempotency key");
  }
  return `api-key-request:${action}:${requestId}:${crypto.randomUUID()}`;
}

function hasActiveUnexpiredLinkedKey(
  request: ApiKeySelfServeRequestAdminSummary,
  generatedAt: number,
): boolean {
  return request.linkedKeyActive === true
    && (request.linkedKeyExpiresAt == null || request.linkedKeyExpiresAt > generatedAt);
}

function canReleaseRequestClaim(
  request: ApiKeySelfServeRequestAdminSummary,
  generatedAt: number,
): boolean {
  return request.status !== "pending_verification"
    && !hasActiveUnexpiredLinkedKey(request, generatedAt)
    && request.claimStatus !== "released";
}

function describeNextAction(
  request: ApiKeySelfServeRequestAdminSummary,
  generatedAt: number,
): string {
  const hasLiveKey = hasActiveUnexpiredLinkedKey(request, generatedAt);
  const canReleaseClaim = canReleaseRequestClaim(request, generatedAt);

  if (request.status === "pending_verification") {
    return request.emailVerified
      ? "Email is verified; review risk context, then let issuance complete or reject if the requester should not receive access."
      : "Waiting on email verification. Reject only when the requester or risk context is disqualifying.";
  }

  if (request.status === "issued") {
    if (hasLiveKey) {
      return "Live key is active. Rejecting this request also deactivates the linked key and releases the email claim.";
    }
    if (canReleaseClaim) {
      return "Linked key is inactive or expired. Release the stale claim to unblock a future self-serve request.";
    }
    return "Issued request is settled. Review linked-key usage before rotating or deactivating from the key panel.";
  }

  if (request.status === "expired") {
    return canReleaseClaim
      ? "Verification expired with a retained claim. Release the stale claim if no manual follow-up is needed."
      : "Verification expired and the claim is already clear.";
  }

  if (request.status === "blocked") {
    return "Blocked by consistency or policy safeguards. Check risk reasons and linked key state before any manual follow-up.";
  }

  return canReleaseClaim
    ? "Rejected request still has a retained claim. Release it if the email should be allowed to request again."
    : "Rejected request is closed and the claim is clear.";
}

function describeReleaseClaimTitle(
  request: ApiKeySelfServeRequestAdminSummary,
  hasActiveUnexpiredKey: boolean,
): string {
  if (hasActiveUnexpiredKey) {
    return "Release is blocked while the linked key is active and unexpired.";
  }
  if (request.status === "pending_verification") {
    return "Pending verification claims should be rejected or allowed to expire.";
  }
  if (request.claimStatus === "released") {
    return "Claim is already released.";
  }
  return "Release the retained email claim.";
}

export function buildApiKeyRequestSummary(
  requests: readonly ApiKeySelfServeRequestAdminSummary[],
  generatedAt: number,
  statusFilter: "all" | ApiKeySelfServeStatus,
  limit: number,
): ApiKeyRequestSummaryItem[] {
  let needsReview = 0;
  let risky = 0;
  let claimCleanup = 0;
  let activeKeys = 0;

  for (const request of requests) {
    if (request.status === "pending_verification") needsReview += 1;
    if (request.riskScore >= REQUEST_RISK_FLAG_SCORE || request.riskReasons.length > 0) risky += 1;
    if (canReleaseRequestClaim(request, generatedAt)) claimCleanup += 1;
    if (hasActiveUnexpiredLinkedKey(request, generatedAt)) activeKeys += 1;
  }

  return [
    {
      label: "Displayed",
      value: String(requests.length),
      detail: `up to ${limit} ${API_KEY_REQUEST_STATUS_LABELS[statusFilter].toLowerCase()}`,
    },
    { label: "Needs review", value: String(needsReview), detail: "pending verification" },
    { label: "Risk flags", value: String(risky), detail: `score >= ${REQUEST_RISK_FLAG_SCORE} or reasons` },
    { label: "Claim cleanup", value: String(claimCleanup), detail: "safe to release" },
    { label: "Live linked keys", value: String(activeKeys), detail: "active and unexpired" },
  ];
}

export function buildApiKeyRequestCardViewModel(
  request: ApiKeySelfServeRequestAdminSummary,
  generatedAt: number,
  busyRequestId: string | null,
): ApiKeyRequestCardViewModel {
  const busy = busyRequestId === request.requestId;
  const hasActiveUnexpiredKey = hasActiveUnexpiredLinkedKey(request, generatedAt);
  const canReleaseClaim = canReleaseRequestClaim(request, generatedAt);
  const canReject = request.status === "pending_verification" || request.status === "issued";
  const rejectLabel = request.status === "issued" && hasActiveUnexpiredKey
    ? "Reject + deactivate key"
    : request.status === "pending_verification"
      ? "Reject pending request"
      : "Reject request";

  return {
    busy,
    canReject,
    canReleaseClaim,
    hasActiveUnexpiredKey,
    rejectLabel,
    releaseClaimLabel: "Release stale claim",
    releaseClaimTitle: describeReleaseClaimTitle(request, hasActiveUnexpiredKey),
    requesterLabel: describeRequester(request),
    nextAction: describeNextAction(request, generatedAt),
  };
}
