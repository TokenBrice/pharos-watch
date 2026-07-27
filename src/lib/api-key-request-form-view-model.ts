import {
  SELF_SERVE_MAX_ACTIVE_KEYS_PER_EMAIL,
  SELF_SERVE_USE_CASE_MAX_LENGTH,
  SELF_SERVE_USE_CASE_MIN_LENGTH,
} from "@shared/lib/ops-limits";
import {
  SELF_SERVE_API_KEY_EXPIRY_DAYS,
  buildPublicApiCurlCommand,
} from "@shared/lib/public-api-contract";
import { slugifyId } from "@shared/lib/format";
import type {
  ApiKeySelfServeCadence,
  ApiKeySelfServeIssueResponse,
  ApiKeySelfServePendingResponse,
  ApiKeySelfServeRequest,
} from "@shared/types";

export const EMAIL_MAX_LENGTH = 200;
export const NAME_MAX_LENGTH = 80;
export const ORGANIZATION_MAX_LENGTH = 120;
export const PROJECT_URL_MAX_LENGTH = 300;
export const EXPECTED_VOLUME_MAX_LENGTH = 300;

export const API_KEY_REQUEST_ENDPOINT_OPTIONS = [
  { path: "/api/stablecoins", label: "Stablecoin list" },
  { path: "/api/stablecoin/:id", label: "Stablecoin detail" },
  { path: "/api/peg-summary", label: "Peg summary" },
  { path: "/api/depeg-events", label: "Depeg events" },
  { path: "/api/dex-liquidity", label: "DEX liquidity" },
  { path: "/api/yield-rankings", label: "Yield rankings" },
  { path: "/api/report-cards/v9", label: "Safety Scores" },
  { path: "/api/chains", label: "Chains" },
  { path: "unknown", label: "Not sure yet" },
] as const;

export const API_KEY_REQUEST_CADENCE_OPTIONS: readonly { value: ApiKeySelfServeCadence; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "every_5_min", label: "Every 5 minutes" },
  { value: "every_1_min", label: "Every minute" },
  { value: "manual", label: "Manual or ad hoc" },
  { value: "other", label: "Other" },
];

export const API_KEY_REQUEST_EXPIRY_DAYS = SELF_SERVE_API_KEY_EXPIRY_DAYS;
export const API_KEY_REQUEST_SAMPLE_PATH = "/api/stablecoins";
export const API_KEY_REQUEST_OWNERSHIP_LIMIT_LABEL = SELF_SERVE_MAX_ACTIVE_KEYS_PER_EMAIL === 1
  ? "One active key per email"
  : `${SELF_SERVE_MAX_ACTIVE_KEYS_PER_EMAIL} active keys per email`;

export type RequestStatus = "idle" | "submitting" | "pending" | "error";
export type VerificationStatus = "idle" | "verifying" | "issued" | "error";

export interface ApiKeyRequestWorkflowState {
  email: string;
  requesterName: string;
  organization: string;
  projectUrl: string;
  useCase: string;
  expectedCadence: ApiKeySelfServeCadence;
  expectedVolume: string;
  selectedEndpoints: string[];
  acceptedTerms: boolean;
  website: string;
  requestStatus: RequestStatus;
  requestError: string | null;
  pendingRequest: ApiKeySelfServePendingResponse | null;
  verificationStatus: VerificationStatus;
  verificationError: string | null;
  issuedKey: ApiKeySelfServeIssueResponse | null;
  copied: "token" | "curl" | null;
  copyError: string | null;
  tokenCopied: boolean;
  revealAcknowledged: boolean;
}

export type ApiKeyRequestWorkflowAction =
  | { type: "setField"; field: "email" | "requesterName" | "organization" | "projectUrl" | "useCase" | "expectedVolume" | "website"; value: string }
  | { type: "setExpectedCadence"; value: ApiKeySelfServeCadence }
  | { type: "setAcceptedTerms"; value: boolean }
  | { type: "toggleEndpoint"; path: string }
  | { type: "submitStarted" }
  | { type: "submitSucceeded"; payload: ApiKeySelfServePendingResponse }
  | { type: "submitFailed"; error: string }
  | { type: "verificationStarted" }
  | { type: "verificationSucceeded"; payload: ApiKeySelfServeIssueResponse }
  | { type: "verificationFailed"; error: string }
  | { type: "copySucceeded"; kind: "token" | "curl" }
  | { type: "copyFailed"; error: string }
  | { type: "clearCopied" }
  | { type: "tokenSaved" };

export const INITIAL_API_KEY_REQUEST_WORKFLOW_STATE: ApiKeyRequestWorkflowState = {
  email: "",
  requesterName: "",
  organization: "",
  projectUrl: "",
  useCase: "",
  expectedCadence: "hourly",
  expectedVolume: "",
  selectedEndpoints: ["/api/stablecoins"],
  acceptedTerms: false,
  website: "",
  requestStatus: "idle",
  requestError: null,
  pendingRequest: null,
  verificationStatus: "idle",
  verificationError: null,
  issuedKey: null,
  copied: null,
  copyError: null,
  tokenCopied: false,
  revealAcknowledged: false,
};

export function apiKeyRequestWorkflowReducer(
  state: ApiKeyRequestWorkflowState,
  action: ApiKeyRequestWorkflowAction,
): ApiKeyRequestWorkflowState {
  switch (action.type) {
    case "setField":
      return { ...state, [action.field]: action.value };
    case "setExpectedCadence":
      return { ...state, expectedCadence: action.value };
    case "setAcceptedTerms":
      return { ...state, acceptedTerms: action.value };
    case "toggleEndpoint":
      return { ...state, selectedEndpoints: toggleEndpointSelection(state.selectedEndpoints, action.path) };
    case "submitStarted":
      return { ...state, requestStatus: "submitting", requestError: null, pendingRequest: null };
    case "submitSucceeded":
      return { ...state, requestStatus: "pending", pendingRequest: action.payload };
    case "submitFailed":
      return { ...state, requestStatus: "error", requestError: action.error };
    case "verificationStarted":
      return { ...state, verificationStatus: "verifying", verificationError: null, issuedKey: null };
    case "verificationSucceeded":
      return {
        ...state,
        copied: null,
        copyError: null,
        tokenCopied: false,
        revealAcknowledged: false,
        issuedKey: action.payload,
        verificationStatus: "issued",
      };
    case "verificationFailed":
      return { ...state, verificationStatus: "error", verificationError: action.error };
    case "copySucceeded":
      return {
        ...state,
        copied: action.kind,
        copyError: null,
        tokenCopied: action.kind === "token" ? true : state.tokenCopied,
      };
    case "copyFailed":
      return { ...state, copied: null, copyError: action.error };
    case "clearCopied":
      return { ...state, copied: null };
    case "tokenSaved":
      return { ...state, revealAcknowledged: true, copyError: null };
  }
}

export function endpointId(path: string): string {
  return `endpoint-${slugifyId(path)}`;
}

export function formatSelfServeExpiry(epochSeconds: number | null): string {
  if (epochSeconds == null) return "No expiry";
  return new Date(epochSeconds * 1000).toLocaleString();
}

export function buildCurlCommand(token: string): string {
  return buildPublicApiCurlCommand({ tokenReference: token, includeAcceptHeader: true });
}

export function isProjectUrlValid(projectUrlValue: string): boolean {
  if (!projectUrlValue) return true;
  try {
    const parsed = new URL(projectUrlValue);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export function canSubmitApiKeyRequest(state: ApiKeyRequestWorkflowState): boolean {
  const projectUrlValue = state.projectUrl.trim();
  const trimmedUseCaseLength = state.useCase.trim().length;

  return state.requestStatus !== "submitting"
    && state.email.trim().length > 3
    && state.email.trim().length <= EMAIL_MAX_LENGTH
    && state.requesterName.trim().length <= NAME_MAX_LENGTH
    && state.organization.trim().length <= ORGANIZATION_MAX_LENGTH
    && projectUrlValue.length <= PROJECT_URL_MAX_LENGTH
    && isProjectUrlValid(projectUrlValue)
    && state.expectedVolume.trim().length <= EXPECTED_VOLUME_MAX_LENGTH
    && trimmedUseCaseLength >= SELF_SERVE_USE_CASE_MIN_LENGTH
    && trimmedUseCaseLength <= SELF_SERVE_USE_CASE_MAX_LENGTH
    && state.acceptedTerms;
}

export function buildApiKeySelfServeRequestPayload(state: ApiKeyRequestWorkflowState): ApiKeySelfServeRequest {
  return {
    email: state.email.trim(),
    ...(state.requesterName.trim() ? { requesterName: state.requesterName.trim() } : {}),
    ...(state.organization.trim() ? { organization: state.organization.trim() } : {}),
    ...(state.projectUrl.trim() ? { projectUrl: state.projectUrl.trim() } : {}),
    useCase: state.useCase.trim(),
    intendedEndpoints: state.selectedEndpoints,
    expectedCadence: state.expectedCadence,
    ...(state.expectedVolume.trim() ? { expectedVolume: state.expectedVolume.trim() } : {}),
    acceptedTerms: state.acceptedTerms,
    website: state.website,
  };
}

function toggleEndpointSelection(current: readonly string[], path: string): string[] {
  if (current.includes(path)) {
    return current.filter((item) => item !== path);
  }
  if (path === "unknown") {
    return ["unknown"];
  }
  return [...current.filter((item) => item !== "unknown"), path];
}
