import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import { DonorKeyClaimResponseSchema } from "@shared/types/api-keys";
import type { DonorKeyClaimRequest, DonorKeyClaimResponse } from "@shared/types";
import { ApiFetchError, apiFetch } from "@/lib/api";

/**
 * UTF-8 bytes of `text` as a `0x`-prefixed lowercase hex string. `personal_sign`
 * takes hex-encoded data; passing the raw string works in some wallets and is
 * re-interpreted as hex by others, which would sign the wrong bytes.
 */
export function hexUtf8(text: string): string {
  let hex = "0x";
  for (const byte of new TextEncoder().encode(text)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Typed failure of `POST /api/donor-key-claims` so the UI can branch on status. */
export class DonorKeyClaimError extends Error {
  readonly status: number;
  /** Epoch seconds of the donation-ledger reconciliation, present on 403 ineligible. */
  readonly ledgerUpdatedAt: number | null;

  constructor(status: number, message: string, ledgerUpdatedAt: number | null = null) {
    super(message);
    this.name = "DonorKeyClaimError";
    this.status = status;
    this.ledgerUpdatedAt = ledgerUpdatedAt;
  }
}

function toClaimError(error: ApiFetchError): DonorKeyClaimError {
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = error.bodyText ? JSON.parse(error.bodyText) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = null;
  }

  const message = typeof payload?.error === "string" && payload.error.trim().length > 0
    ? payload.error
    : `Request failed with status ${error.status}`;
  const ledgerUpdatedAt = typeof payload?.ledgerUpdatedAt === "number" ? payload.ledgerUpdatedAt : null;
  return new DonorKeyClaimError(error.status, message, ledgerUpdatedAt);
}

/** Exchange a signed SIWE message for a supporter API key. The token is shown once. */
export async function claimDonorKey(body: DonorKeyClaimRequest): Promise<DonorKeyClaimResponse> {
  try {
    return await apiFetch<DonorKeyClaimResponse>(API_PATHS.donorKeyClaims(), DonorKeyClaimResponseSchema, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof ApiFetchError) throw toClaimError(error);
    throw error;
  }
}
