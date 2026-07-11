import { SchemaValidationError, apiRequest } from "@/lib/api";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM,
  TelegramMiniAppErrorResponseSchema,
  TelegramMiniAppBulkWatchlistResponseSchema,
  TelegramMiniAppPortabilityResponseSchema,
  TelegramMiniAppResponseSchema,
  TelegramMiniAppSnapshotSchema,
  TelegramMiniAppStateSchema as SharedTelegramMiniAppStateSchema,
  telegramMiniAppStateRevision,
  type TelegramMiniAppMutableState,
  type TelegramMiniAppResponse,
  type TelegramMiniAppPortabilityResponse,
  type TelegramMiniAppBulkWatchlistResponse,
  type TelegramMiniAppState,
} from "@shared/lib/telegram-mini-app-contract";
import { TELEGRAM_MINI_APP_CATALOG } from "@shared/lib/telegram-mini-app-catalog";
import type { ZodType } from "zod";
import { isMiniAppErrorCode, MiniAppRequestError, type MiniAppErrorCode } from "./error-messages";

export const TelegramMiniAppStateSchema = SharedTelegramMiniAppStateSchema;

export interface TelegramMiniAppClientSnapshot {
  state: TelegramMiniAppState;
  stateRevision: string;
}

function formatZodIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join(", ");
}

function parseRetryAfterSec(value: unknown): number | null {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(60 * 60, Math.ceil(parsed));
}

export async function postMiniAppJson<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T> {
  const response = await apiRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let code: MiniAppErrorCode | null = null;
    let retryAfterSec: number | null = null;
    let contractVersion: string | null = null;
    let catalogVersion: string | null = null;
    try {
      const payload: unknown = await response.json();
      const parsed = TelegramMiniAppErrorResponseSchema.safeParse(payload);
      if (parsed.success) {
        code = parsed.data.code;
        retryAfterSec = parseRetryAfterSec(parsed.data.retryAfterSec);
        contractVersion = parsed.data.contractVersion ?? null;
        catalogVersion = parsed.data.catalogVersion ?? null;
      } else if (payload && typeof payload === "object") {
        const loose = payload as { code?: unknown; retryAfterSec?: unknown };
        if (isMiniAppErrorCode(loose.code)) code = loose.code;
        retryAfterSec = parseRetryAfterSec(loose.retryAfterSec);
      }
    } catch {
      // Body was not JSON or was empty. Status still selects the fallback copy.
    }
    retryAfterSec ??= parseRetryAfterSec(response.headers?.get?.("Retry-After"));
    throw new MiniAppRequestError(response.status, code, retryAfterSec, {
      contractVersion,
      catalogVersion,
    });
  }

  const payload: unknown = await response.json();
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new SchemaValidationError(path, formatZodIssues(result.error.issues));
  }
  return result.data;
}

function hydrateMiniAppResponse(response: TelegramMiniAppResponse): TelegramMiniAppClientSnapshot {
  const compact = TelegramMiniAppSnapshotSchema.safeParse(response);
  if (!compact.success) {
    // Rolling deploy: a new static client can still consume an older Worker's
    // full-catalog response. The next matching Worker response becomes compact.
    const legacy = SharedTelegramMiniAppStateSchema.parse(response);
    const { catalog: _catalog, ...mutableState } = legacy;
    return {
      state: legacy,
      stateRevision: telegramMiniAppStateRevision(mutableState as TelegramMiniAppMutableState),
    };
  }
  const snapshot = compact.data;
  if (snapshot.contractVersion !== TELEGRAM_MINI_APP_CONTRACT_VERSION) {
    throw new MiniAppRequestError(409, "contract-version-mismatch", null, {
      contractVersion: snapshot.contractVersion,
      catalogVersion: snapshot.catalogVersion,
    });
  }
  if (snapshot.catalogVersion !== TELEGRAM_MINI_APP_CATALOG_VERSION) {
    throw new MiniAppRequestError(409, "catalog-version-mismatch", null, {
      contractVersion: snapshot.contractVersion,
      catalogVersion: snapshot.catalogVersion,
    });
  }
  return {
    state: {
      ...snapshot.state,
      catalog: TELEGRAM_MINI_APP_CATALOG as unknown as TelegramMiniAppState["catalog"],
    },
    stateRevision: snapshot.stateRevision,
  };
}

export async function postMiniAppSnapshot(path: string, body: unknown): Promise<TelegramMiniAppClientSnapshot> {
  const query = new URLSearchParams({
    [TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM]: TELEGRAM_MINI_APP_CONTRACT_VERSION,
    [TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM]: TELEGRAM_MINI_APP_CATALOG_VERSION,
  });
  const separator = path.includes("?") ? "&" : "?";
  const response = await postMiniAppJson(`${path}${separator}${query}`, body, TelegramMiniAppResponseSchema);
  return hydrateMiniAppResponse(response);
}

/**
 * Portable watchlist reads use the same versioned, signed Mini App transport
 * as mutations but intentionally return a token or exact preview, not state.
 */
export async function postMiniAppPortability(path: string, body: unknown): Promise<TelegramMiniAppPortabilityResponse> {
  const query = new URLSearchParams({
    [TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM]: TELEGRAM_MINI_APP_CONTRACT_VERSION,
    [TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM]: TELEGRAM_MINI_APP_CATALOG_VERSION,
  });
  const separator = path.includes("?") ? "&" : "?";
  const response = await postMiniAppJson(
    `${path}${separator}${query}`,
    body,
    TelegramMiniAppPortabilityResponseSchema,
  );
  if (response.contractVersion !== TELEGRAM_MINI_APP_CONTRACT_VERSION) {
    throw new MiniAppRequestError(409, "contract-version-mismatch", null, {
      contractVersion: response.contractVersion,
      catalogVersion: response.catalogVersion,
    });
  }
  if (response.catalogVersion !== TELEGRAM_MINI_APP_CATALOG_VERSION) {
    throw new MiniAppRequestError(409, "catalog-version-mismatch", null, {
      contractVersion: response.contractVersion,
      catalogVersion: response.catalogVersion,
    });
  }
  return response;
}

/** Server-side bulk selection previews are signed reads, like portability previews. */
export async function postMiniAppBulkWatchlistPreview(
  path: string,
  body: unknown,
): Promise<TelegramMiniAppBulkWatchlistResponse> {
  const query = new URLSearchParams({
    [TELEGRAM_MINI_APP_CONTRACT_VERSION_PARAM]: TELEGRAM_MINI_APP_CONTRACT_VERSION,
    [TELEGRAM_MINI_APP_CATALOG_VERSION_PARAM]: TELEGRAM_MINI_APP_CATALOG_VERSION,
  });
  const separator = path.includes("?") ? "&" : "?";
  const response = await postMiniAppJson(
    `${path}${separator}${query}`,
    body,
    TelegramMiniAppBulkWatchlistResponseSchema,
  );
  if (response.contractVersion !== TELEGRAM_MINI_APP_CONTRACT_VERSION) {
    throw new MiniAppRequestError(409, "contract-version-mismatch", null, {
      contractVersion: response.contractVersion,
      catalogVersion: response.catalogVersion,
    });
  }
  if (response.catalogVersion !== TELEGRAM_MINI_APP_CATALOG_VERSION) {
    throw new MiniAppRequestError(409, "catalog-version-mismatch", null, {
      contractVersion: response.contractVersion,
      catalogVersion: response.catalogVersion,
    });
  }
  return response;
}

export async function postMiniAppState(path: string, body: unknown): Promise<TelegramMiniAppState> {
  return (await postMiniAppSnapshot(path, body)).state;
}

const VERSION_REFRESH_STORAGE_KEY = "pharos-mini-app-version-refresh";

interface VersionRefreshStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function refreshMiniAppBundleOnce(
  versions: { contractVersion?: string | null; catalogVersion?: string | null },
  dependencies: { storage?: VersionRefreshStorage | null; refresh?: () => void } = {},
): boolean {
  const target = `${versions.contractVersion ?? "unknown"}:${versions.catalogVersion ?? "unknown"}`;
  let storage = dependencies.storage;
  if (storage === undefined && typeof window !== "undefined") {
    try {
      storage = window.sessionStorage;
    } catch {
      return false;
    }
  }
  if (!storage) return false;
  const refresh = dependencies.refresh ?? (() => window.location.reload());

  try {
    if (storage.getItem(VERSION_REFRESH_STORAGE_KEY) === target) return false;
    storage.setItem(VERSION_REFRESH_STORAGE_KEY, target);
  } catch {
    return false;
  }
  refresh();
  return true;
}

export function isMiniAppVersionMismatch(error: unknown): error is MiniAppRequestError {
  return (
    error instanceof MiniAppRequestError &&
    (error.code === "contract-version-mismatch" || error.code === "catalog-version-mismatch")
  );
}
