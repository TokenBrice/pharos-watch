export type ApiKeySelfServeStatus =
  | "pending_verification"
  | "issued"
  | "rejected"
  | "blocked"
  | "expired";

export type ApiKeySelfServeClaimStatus = "pending_verification" | "issued" | "released";

export type ApiKeySelfServeCadence =
  | "hourly"
  | "every_5_min"
  | "every_1_min"
  | "manual"
  | "other";

export interface ApiKeySelfServeRequest {
  email: string;
  requesterName?: string;
  organization?: string;
  projectUrl?: string;
  useCase: string;
  intendedEndpoints?: string[];
  expectedCadence: ApiKeySelfServeCadence;
  expectedVolume?: string;
  acceptedTerms: boolean;
  website?: string;
}

export interface ApiKeySelfServePendingResponse {
  status: "pending_verification";
  message: string;
}

export interface ApiKeySelfServeVerifyRequest {
  token: string;
}

export interface ApiKeySelfServeIssueResponse {
  status: "issued";
  key: {
    keyPrefix: string;
    maskedToken: string;
    tier: "self-serve";
    trafficClass: "external";
    rateLimitPerMinute: 30;
    expiresAt: number | null;
  };
  token: string;
  usage: {
    baseUrl: string;
    headerName: string;
    retryGuidance: string;
  };
}

export interface ApiKeySelfServeRequestAdminSummary {
  requestId: string;
  status: ApiKeySelfServeStatus;
  email: string;
  requesterName: string | null;
  organization: string | null;
  projectUrl: string | null;
  useCase: string;
  intendedEndpoints: string[];
  expectedCadence: string | null;
  expectedVolume: string | null;
  acceptedTerms: boolean;
  emailVerified: boolean;
  linkedKeyId: number | null;
  linkedKeyPrefix: string | null;
  linkedKeyActive: boolean | null;
  linkedKeyExpiresAt: number | null;
  rateLimitPerMinute: number;
  selfServeExpiresAt: number | null;
  riskScore: number;
  riskReasons: string[];
  claimStatus: ApiKeySelfServeClaimStatus | null;
  verificationSentAt: number | null;
  verificationExpiresAt: number | null;
  issuedAt: number | null;
  rejectedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApiKeySelfServeRequestAdminListResponse {
  generatedAt: number;
  requests: ApiKeySelfServeRequestAdminSummary[];
}

export interface ApiKeySelfServeAdminMutationResponse {
  ok: true;
  requestId: string;
  status: ApiKeySelfServeStatus;
  claimStatus: ApiKeySelfServeClaimStatus | null;
}
