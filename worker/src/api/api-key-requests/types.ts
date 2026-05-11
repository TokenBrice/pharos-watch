import { z } from "zod";

export interface ApiKeySelfServeEnv {
  API_KEY_SELF_SERVE_IP_SALT?: string;
  API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER?: string;
  API_KEY_SELF_SERVE_REQUEST_PEPPER?: string;
  API_KEY_SELF_SERVE_EMAIL_FROM?: string;
  API_KEY_SELF_SERVE_EMAIL_REPLY_TO?: string;
  API_KEY_SELF_SERVE_PUBLIC_BASE_URL?: string;
  RESEND_API_KEY?: string;
  GITHUB_PAT?: string;
}

export interface RequiredInitialSelfServeEnv {
  API_KEY_SELF_SERVE_IP_SALT: string;
  API_KEY_SELF_SERVE_EMAIL_HASH_PEPPER: string;
  API_KEY_SELF_SERVE_REQUEST_PEPPER: string;
  API_KEY_SELF_SERVE_EMAIL_FROM: string;
  API_KEY_SELF_SERVE_EMAIL_REPLY_TO: string;
  API_KEY_SELF_SERVE_PUBLIC_BASE_URL: string;
  RESEND_API_KEY: string;
  GITHUB_PAT?: string;
}

export interface RequiredVerifySelfServeEnv {
  API_KEY_SELF_SERVE_IP_SALT: string;
  API_KEY_SELF_SERVE_REQUEST_PEPPER: string;
}

export const ApiKeySelfServeRequestSchema = z.object({
  email: z.string().trim().min(3, "Email is required").max(200, "Email must be 200 characters or fewer"),
  requesterName: z.string().trim().max(80, "Name must be 80 characters or fewer").optional(),
  organization: z.string().trim().max(120, "Organization must be 120 characters or fewer").optional(),
  projectUrl: z.string().trim().max(300, "Project URL must be 300 characters or fewer")
    .refine((value) => !value || value.startsWith("https://"), "Project URL must use https://")
    .optional(),
  useCase: z.string().trim().min(40, "Use case must be 40-2000 characters").max(2000, "Use case must be 40-2000 characters"),
  intendedEndpoints: z.array(z.string().trim().max(160)).max(20).optional(),
  expectedCadence: z.enum(["hourly", "every_5_min", "every_1_min", "manual", "other"], {
    message: "Expected cadence is required",
  }),
  expectedVolume: z.string().trim().max(300, "Expected volume must be 300 characters or fewer").optional(),
  acceptedTerms: z.literal(true, {
    message: "You must accept the fair-use terms",
  }),
  website: z.string().optional(),
}).strict();

export const ApiKeySelfServeVerifySchema = z.object({
  token: z.string().trim().min(20, "Verification token is required").max(256, "Verification token is invalid"),
}).strict();

export type ParsedApiKeySelfServeRequest = z.infer<typeof ApiKeySelfServeRequestSchema>;
export type ParsedApiKeySelfServeVerify = z.infer<typeof ApiKeySelfServeVerifySchema>;
