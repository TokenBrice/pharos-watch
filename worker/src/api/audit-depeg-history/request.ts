import { D1_BATCH_SIZE } from "../../lib/constants";
import { errorResponse, methodNotAllowedResponse, parseQueryParams } from "../../lib/api-utils";

export type RepairMode = "synthetic-splits" | "contradictory-recovery-price";

export interface AuditPaginatedRequest {
  limit: number;
  offset: number;
  dryRun: boolean;
  symbolFilter: string | null;
}

export interface ParsedAuditRequest extends AuditPaginatedRequest {
  minSupply: number;
  deleteIds: number[] | null;
  repairMode: RepairMode | null;
}

const AUDIT_DEPEG_HISTORY_LIMIT = 25;
const DELETE_ID_PATTERN = /^\d+$/;

function parseDeleteIds(value: string): number[] | Response {
  const tokens = value.split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0 || !DELETE_ID_PATTERN.test(token))) {
    return errorResponse(400, "Invalid delete parameter: expected comma-separated numeric event IDs");
  }

  const ids = tokens.map((token) => Number.parseInt(token, 10));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    return errorResponse(400, "Invalid delete parameter: expected positive event IDs");
  }
  if (ids.length > D1_BATCH_SIZE) {
    return errorResponse(
      400,
      `Too many delete IDs: at most ${D1_BATCH_SIZE} may be requested before stability recompute (received ${ids.length})`,
    );
  }
  return ids;
}

function parseRepairMode(value: string | null): RepairMode | null | Response {
  if (value == null || value.length === 0) return null;
  if (value === "synthetic-splits" || value === "contradictory-recovery-price") return value;
  return errorResponse(400, `Unsupported repair mode: ${value}`);
}

export function parseAuditRequest(url: URL, request?: Request): ParsedAuditRequest | Response {
  const parsed = parseQueryParams(url.searchParams, {
    limit: {
      type: "int",
      default: AUDIT_DEPEG_HISTORY_LIMIT,
      min: 1,
      max: AUDIT_DEPEG_HISTORY_LIMIT,
      rangePolicy: "reject",
    },
    offset: { type: "int", default: 0, min: 0, max: 100_000 },
    "min-supply": { type: "int", default: 0, min: 0, max: Number.MAX_SAFE_INTEGER, name: "min-supply" },
  });
  if (parsed instanceof Response) return parsed;

  const deleteParam = url.searchParams.get("delete");
  const hasDeleteParam = deleteParam != null;
  const repairMode = parseRepairMode(url.searchParams.get("repair"));
  if (repairMode instanceof Response) return repairMode;
  if (hasDeleteParam && repairMode) {
    return errorResponse(400, "Use either delete=... or repair=..., not both");
  }

  const dryRun = url.searchParams.get("dry-run") === "true";
  const method = request?.method ?? "GET";
  if (method === "GET" && !dryRun) {
    return methodNotAllowedResponse(
      "Method not allowed. GET supports dry-run=true only; use POST for mutations.",
      ["POST"],
    );
  }

  const deleteIds = deleteParam == null ? null : parseDeleteIds(deleteParam);
  if (deleteIds instanceof Response) return deleteIds;

  return {
    limit: parsed.limit,
    offset: parsed.offset,
    minSupply: parsed["min-supply"],
    deleteIds,
    repairMode,
    dryRun,
    symbolFilter: url.searchParams.get("symbol")?.toUpperCase() ?? null,
  };
}
