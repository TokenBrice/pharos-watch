import { z } from "zod";
import type { ApiKeySelfServeClaimStatus, ApiKeySelfServeStatus } from "@shared/types";
import { SELF_SERVE_USE_CASE_MAX_LENGTH, SELF_SERVE_USE_CASE_MIN_LENGTH } from "@shared/lib/ops-limits";
import type { MinimalD1Database } from "../../lib/minimal-d1";

const HONEYPOT_MAX_LENGTH = 300;

export interface ApiKeySelfServeEnv {
  API_KEY_SELF_SERVE_IP_SALT?: string;
  API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER?: string;
  API_KEY_SELF_SERVE_REQUEST_PEPPER?: string;
  API_KEY_SELF_SERVE_EMAIL_FROM?: string;
  API_KEY_SELF_SERVE_EMAIL_REPLY_TO?: string;
  API_KEY_SELF_SERVE_PUBLIC_BASE_URL?: string;
  RESEND_API_KEY?: string;
}

export type ApiKeyRequestDb = MinimalD1Database;

export interface ApiKeyRequestRow {
  request_id: string;
  api_key_id: number | null;
  status: ApiKeySelfServeStatus;
  normalized_email: string;
  email_hash: string;
  email_verified: number;
  requester_name: string | null;
  organization: string | null;
  project_url: string | null;
  use_case: string;
  intended_endpoints_json: string | null;
  expected_cadence: string | null;
  expected_volume: string | null;
  accepted_terms: number;
  self_serve_rate_limit_per_minute: number;
  self_serve_expires_at: number | null;
  ip_hash: string;
  user_agent_hash: string | null;
  verification_token_hash: string | null;
  verification_sent_at: number | null;
  verification_expires_at: number | null;
  issuance_locked_at: number | null;
  issued_at: number | null;
  rejected_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ApiKeyRequestAdminRow extends ApiKeyRequestRow {
  claim_status: ApiKeySelfServeClaimStatus | null;
  linked_key_owner_email: string | null;
  linked_key_prefix: string | null;
  linked_key_tier: string | null;
  linked_key_active: number | null;
  linked_key_expires_at: number | null;
}

export interface RequiredInitialSelfServeEnv {
  API_KEY_SELF_SERVE_IP_SALT: string;
  API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER: string;
  API_KEY_SELF_SERVE_REQUEST_PEPPER: string;
  API_KEY_SELF_SERVE_EMAIL_FROM: string;
  API_KEY_SELF_SERVE_EMAIL_REPLY_TO: string;
  API_KEY_SELF_SERVE_PUBLIC_BASE_URL: string;
  RESEND_API_KEY: string;
}

export interface RequiredVerifySelfServeEnv {
  API_KEY_SELF_SERVE_IP_SALT: string;
  API_KEY_SELF_SERVE_REQUEST_PEPPER: string;
}

export const ApiKeySelfServeRequestSchema = z
  .object({
    email: z.string().trim().min(3, "Email is required").max(200, "Email must be 200 characters or fewer"),
    requesterName: z.string().trim().max(80, "Name must be 80 characters or fewer").optional(),
    organization: z.string().trim().max(120, "Organization must be 120 characters or fewer").optional(),
    projectUrl: z
      .string()
      .trim()
      .max(300, "Project URL must be 300 characters or fewer")
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return url.protocol === "https:" && Boolean(url.hostname);
        } catch {
          return false;
        }
      }, "Project URL must be a valid https:// URL")
      .optional(),
    useCase: z
      .string()
      .trim()
      .min(
        SELF_SERVE_USE_CASE_MIN_LENGTH,
        `Use case must be ${SELF_SERVE_USE_CASE_MIN_LENGTH}-${SELF_SERVE_USE_CASE_MAX_LENGTH} characters`,
      )
      .max(
        SELF_SERVE_USE_CASE_MAX_LENGTH,
        `Use case must be ${SELF_SERVE_USE_CASE_MIN_LENGTH}-${SELF_SERVE_USE_CASE_MAX_LENGTH} characters`,
      ),
    intendedEndpoints: z.array(z.string().trim().max(160)).max(20).optional(),
    expectedCadence: z.enum(["hourly", "every_5_min", "every_1_min", "manual", "other"], {
      message: "Expected cadence is required",
    }),
    expectedVolume: z.string().trim().max(300, "Expected volume must be 300 characters or fewer").optional(),
    acceptedTerms: z.literal(true, {
      message: "You must accept the fair-use terms",
    }),
    website: z.string().max(HONEYPOT_MAX_LENGTH).optional(),
  })
  .strict();

export const ApiKeySelfServeVerifySchema = z
  .object({
    token: z.string().trim().min(20, "Verification token is required").max(256, "Verification token is invalid"),
  })
  .strict();

export type ParsedApiKeySelfServeRequest = z.infer<typeof ApiKeySelfServeRequestSchema>;
export type ParsedApiKeySelfServeVerify = z.infer<typeof ApiKeySelfServeVerifySchema>;
