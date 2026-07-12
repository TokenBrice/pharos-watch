import type {
  ApiKeySelfServeRequestAdminListResponse,
  ApiKeySelfServeStatus,
} from "@shared/types";
import {
  parseOptionalEnumParam,
  parseOptionalPositiveIntegerParam,
} from "../../lib/api-utils";
import { getNowSec } from "../../lib/api-key-core";
import {
  adminErrorResponse,
  adminJsonResponse,
  makeAdminRoute,
  makeIdempotentAdminRoute,
  type AdminRouteContext,
} from "../../lib/route-wrappers";
import {
  buildAdminMutationResponse,
  deactivateLinkedSelfServeKey,
  listAdminRequests,
  mapAdminRow,
  parseAdminMutationBody,
  recordRequestAdminAction,
  recordSelfServeRevocation,
  selectRequestWithKeyStateByRequestId,
} from "./admin";
import {
  markRequestExpired,
  releaseEmailClaim,
} from "./state";

const ADMIN_STATUS_FILTERS = new Set<ApiKeySelfServeStatus>([
  "pending_verification",
  "issued",
  "rejected",
  "blocked",
  "expired",
]);

interface ApiKeyRequestByIdRouteContext extends AdminRouteContext {
  requestId: string;
}

async function revokeAndDeactivateLinkedSelfServeKey(
  db: D1Database,
  input: {
    apiKeyId: number;
    keyPrefix: string;
    requestId: string;
    nowSec: number;
  },
): Promise<void> {
  await recordSelfServeRevocation(db, {
    apiKeyId: input.apiKeyId,
    keyPrefix: input.keyPrefix,
    requestId: input.requestId,
    nowSec: input.nowSec,
    reason: "admin_reject",
  });
  await deactivateLinkedSelfServeKey(db, input);
}

async function finalizeRejectedRequest(
  db: D1Database,
  input: {
    requestId: string;
    emailHash: string;
    apiKeyId: number | null;
    linkedKeyPrefix: string | null;
    reason: string | null;
    nowSec: number;
  },
): Promise<Response> {
  if (input.apiKeyId != null && input.linkedKeyPrefix) {
    await revokeAndDeactivateLinkedSelfServeKey(db, {
      apiKeyId: input.apiKeyId,
      keyPrefix: input.linkedKeyPrefix,
      requestId: input.requestId,
      nowSec: input.nowSec,
    });
  }
  await releaseEmailClaim(db, input.emailHash, input.requestId, input.nowSec);
  await recordRequestAdminAction(db, {
    action: "api_key_request_reject",
    requestId: input.requestId,
    status: 200,
    resultStatus: "rejected",
    claimStatus: "released",
    reason: input.reason,
    nowSec: input.nowSec,
  });
  return adminJsonResponse(buildAdminMutationResponse(input.requestId, "rejected", "released"));
}

export const handleApiKeyRequestsAdminRoute = makeAdminRoute<AdminRouteContext>(
  "api-key-requests-admin",
  async ({ db, request }) => {
    const url = new URL(request.url);
    const status = parseOptionalEnumParam(url.searchParams.get("status"), ADMIN_STATUS_FILTERS, "status");
    if (status instanceof Response) return status;
    const parsedLimit = parseOptionalPositiveIntegerParam(url.searchParams.get("limit"), "limit", { max: 100 });
    if (parsedLimit instanceof Response) return parsedLimit;
    const rows = await listAdminRequests(db, status ?? null, parsedLimit ?? 50);
    const response: ApiKeySelfServeRequestAdminListResponse = {
      generatedAt: getNowSec(),
      requests: rows.map(mapAdminRow),
    };
    return adminJsonResponse(response);
  },
);

export function handleApiKeyRequestsAdmin(
  db: D1Database,
  trustedAdmin: boolean,
  request: Request,
): Promise<Response> {
  return handleApiKeyRequestsAdminRoute({ db, trustedAdmin, request });
}

export const handleApiKeyRequestRejectRoute = makeIdempotentAdminRoute<ApiKeyRequestByIdRouteContext>(
  "api-key-request-reject",
  "api-key-request-reject",
  async ({ db, request, requestId }) => {
    const parsedBody = await parseAdminMutationBody(request);
    if (parsedBody instanceof Response) return parsedBody;
    const row = await selectRequestWithKeyStateByRequestId(db, requestId);
    if (!row) return adminErrorResponse(404, "API key request not found");
    const nowSec = getNowSec();
    const linkedKeyPrefix = row.linked_key_prefix;
    if (row.api_key_id != null) {
      const mismatch = row.linked_key_tier !== "self-serve"
        || row.linked_key_owner_email !== row.normalized_email
        || !linkedKeyPrefix;
      if (mismatch) {
        return adminErrorResponse(409, "Linked API key does not match the self-serve request");
      }
    }
    if (row.status === "rejected") {
      return finalizeRejectedRequest(db, {
        requestId,
        emailHash: row.email_hash,
        apiKeyId: row.api_key_id,
        linkedKeyPrefix,
        reason: parsedBody.reason,
        nowSec,
      });
    }
    if (row.status !== "pending_verification" && row.status !== "issued") {
      return adminErrorResponse(409, "Only pending or issued self-serve requests can be rejected");
    }
    // Flip the request status first: D1 has no multi-statement transactions, so
    // the 0-changes guard must short-circuit before any key mutation. Otherwise
    // a concurrent status change leaves the key deactivated while the request
    // still reads pending/issued.
    const updated = await db.prepare(
      "UPDATE api_key_requests SET status = 'rejected', rejected_at = ?, updated_at = ? WHERE request_id = ? AND status IN ('pending_verification', 'issued')",
    )
      .bind(nowSec, nowSec, requestId)
      .run();
    if ((updated.meta?.changes ?? 0) === 0) {
      return adminErrorResponse(409, "API key request state changed before rejection");
    }
    return finalizeRejectedRequest(db, {
      requestId,
      emailHash: row.email_hash,
      apiKeyId: row.api_key_id,
      linkedKeyPrefix,
      reason: parsedBody.reason,
      nowSec,
    });
  },
);

export function handleApiKeyRequestReject(
  db: D1Database,
  requestId: string,
  trustedAdmin: boolean,
  request: Request,
): Promise<Response> {
  return handleApiKeyRequestRejectRoute({ db, requestId, trustedAdmin, request });
}

export const handleApiKeyRequestReleaseClaimRoute = makeIdempotentAdminRoute<ApiKeyRequestByIdRouteContext>(
  "api-key-request-release-claim",
  "api-key-request-release-claim",
  async ({ db, request, requestId }) => {
    const parsedBody = await parseAdminMutationBody(request);
    if (parsedBody instanceof Response) return parsedBody;
    const row = await selectRequestWithKeyStateByRequestId(db, requestId);
    if (!row) return adminErrorResponse(404, "API key request not found");
    const nowSec = getNowSec();
    if (row.linked_key_active === 1 && (row.linked_key_expires_at == null || row.linked_key_expires_at > nowSec)) {
      return adminErrorResponse(409, "Cannot release claim while the linked self-serve key is still active");
    }
    await releaseEmailClaim(db, row.email_hash, requestId, nowSec);
    if (row.status === "pending_verification") {
      await markRequestExpired(db, requestId, nowSec);
    }
    const resultStatus = row.status === "pending_verification" ? "expired" : row.status;
    await recordRequestAdminAction(db, {
      action: "api_key_request_release_claim",
      requestId,
      status: 200,
      resultStatus,
      claimStatus: "released",
      reason: parsedBody.reason,
      nowSec,
    });
    return adminJsonResponse(buildAdminMutationResponse(
      requestId,
      resultStatus,
      "released",
    ));
  },
);
