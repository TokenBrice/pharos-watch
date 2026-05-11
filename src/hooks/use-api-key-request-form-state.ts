"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SELF_SERVE_USE_CASE_MAX_LENGTH,
  SELF_SERVE_USE_CASE_MIN_LENGTH,
} from "@shared/lib/ops-limits";
import type {
  ApiKeySelfServeCadence,
  ApiKeySelfServeIssueResponse,
  ApiKeySelfServePendingResponse,
  ApiKeySelfServeRequest,
} from "@shared/types";
import {
  readVerificationTokenFromUrl,
  stripVerificationTokenFromUrl,
  submitApiKeyRequest,
  takePreSanitizedVerificationToken,
  verifyApiKeyRequestToken,
} from "@/lib/api-key-self-serve";

export const EMAIL_MAX_LENGTH = 200;
export const NAME_MAX_LENGTH = 80;
export const ORGANIZATION_MAX_LENGTH = 120;
export const PROJECT_URL_MAX_LENGTH = 300;
export const EXPECTED_VOLUME_MAX_LENGTH = 300;

export type RequestStatus = "idle" | "submitting" | "pending" | "error";
export type VerificationStatus = "idle" | "verifying" | "issued" | "error";

function buildCurlCommand(token: string): string {
  return [
    "curl https://api.pharos.watch/api/stablecoins \\",
    `  -H "X-API-Key: ${token}" \\`,
    "  -H \"Accept: application/json\"",
  ].join("\n");
}

export function useApiKeyRequestFormState() {
  const [email, setEmail] = useState("");
  const [requesterName, setRequesterName] = useState("");
  const [organization, setOrganization] = useState("");
  const [projectUrl, setProjectUrl] = useState("");
  const [useCase, setUseCase] = useState("");
  const [expectedCadence, setExpectedCadence] = useState<ApiKeySelfServeCadence>("hourly");
  const [expectedVolume, setExpectedVolume] = useState("");
  const [selectedEndpoints, setSelectedEndpoints] = useState<string[]>(["/api/stablecoins"]);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [website, setWebsite] = useState("");
  const [requestStatus, setRequestStatus] = useState<RequestStatus>("idle");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<ApiKeySelfServePendingResponse | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<VerificationStatus>("idle");
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [issuedKey, setIssuedKey] = useState<ApiKeySelfServeIssueResponse | null>(null);
  const [copied, setCopied] = useState<"token" | "curl" | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [revealAcknowledged, setRevealAcknowledged] = useState(false);
  const consumedVerificationTokenRef = useRef<string | null>(null);
  const copyTokenButtonRef = useRef<HTMLButtonElement | null>(null);
  const tokenCodeRef = useRef<HTMLElement | null>(null);

  const curlCommand = useMemo(() => issuedKey ? buildCurlCommand(issuedKey.token) : "", [issuedKey]);
  const trimmedUseCaseLength = useCase.trim().length;
  const projectUrlValue = projectUrl.trim();
  const projectUrlValid = !projectUrlValue || (() => {
    try {
      const parsed = new URL(projectUrlValue);
      return parsed.protocol === "https:" && parsed.hostname.length > 0;
    } catch {
      return false;
    }
  })();
  const tokenSecured = tokenCopied || revealAcknowledged;

  const canSubmit =
    requestStatus !== "submitting"
    && email.trim().length > 3
    && email.trim().length <= EMAIL_MAX_LENGTH
    && requesterName.trim().length <= NAME_MAX_LENGTH
    && organization.trim().length <= ORGANIZATION_MAX_LENGTH
    && projectUrlValue.length <= PROJECT_URL_MAX_LENGTH
    && projectUrlValid
    && expectedVolume.trim().length <= EXPECTED_VOLUME_MAX_LENGTH
    && trimmedUseCaseLength >= SELF_SERVE_USE_CASE_MIN_LENGTH
    && trimmedUseCaseLength <= SELF_SERVE_USE_CASE_MAX_LENGTH
    && acceptedTerms;

  const copyText = useCallback(async (kind: "token" | "curl", value: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setCopyError(null);
      if (kind === "token") {
        setTokenCopied(true);
      }
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
      setCopyError("Copy failed. Select the text and copy it manually before leaving this page.");
    }
  }, []);

  const selectTokenText = useCallback(() => {
    const tokenNode = tokenCodeRef.current;
    const selection = window.getSelection?.();
    if (!tokenNode || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(tokenNode);
    selection.removeAllRanges();
    selection.addRange(range);
    tokenNode.focus();
  }, []);

  const verifyToken = useCallback(async (token: string) => {
    setVerificationStatus("verifying");
    setVerificationError(null);
    setIssuedKey(null);

    try {
      const payload = await verifyApiKeyRequestToken(token);
      setCopied(null);
      setCopyError(null);
      setTokenCopied(false);
      setRevealAcknowledged(false);
      setIssuedKey(payload);
      setVerificationStatus("issued");
    } catch (error) {
      setVerificationError(error instanceof Error ? error.message : "Verification failed");
      setVerificationStatus("error");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = takePreSanitizedVerificationToken() ?? readVerificationTokenFromUrl();
    if (!token || consumedVerificationTokenRef.current === token) return;
    consumedVerificationTokenRef.current = token;
    stripVerificationTokenFromUrl();
    void verifyToken(token);
  }, [verifyToken]);

  useEffect(() => {
    if (!issuedKey) return;
    copyTokenButtonRef.current?.focus();
  }, [issuedKey]);

  useEffect(() => {
    if (!issuedKey || tokenSecured) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [issuedKey, tokenSecured]);

  const toggleEndpoint = useCallback((path: string): void => {
    setSelectedEndpoints((current) => {
      if (current.includes(path)) {
        return current.filter((item) => item !== path);
      }
      if (path === "unknown") {
        return ["unknown"];
      }
      return [...current.filter((item) => item !== "unknown"), path];
    });
  }, []);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRequestStatus("submitting");
    setRequestError(null);
    setPendingRequest(null);

    const body: ApiKeySelfServeRequest = {
      email: email.trim(),
      ...(requesterName.trim() ? { requesterName: requesterName.trim() } : {}),
      ...(organization.trim() ? { organization: organization.trim() } : {}),
      ...(projectUrl.trim() ? { projectUrl: projectUrl.trim() } : {}),
      useCase: useCase.trim(),
      intendedEndpoints: selectedEndpoints,
      expectedCadence,
      ...(expectedVolume.trim() ? { expectedVolume: expectedVolume.trim() } : {}),
      acceptedTerms,
      website,
    };

    try {
      const payload = await submitApiKeyRequest(body);
      setPendingRequest(payload);
      setRequestStatus("pending");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Could not submit API key request");
      setRequestStatus("error");
    }
  }, [
    acceptedTerms,
    email,
    expectedCadence,
    expectedVolume,
    organization,
    projectUrl,
    requesterName,
    selectedEndpoints,
    useCase,
    website,
  ]);

  const markTokenSaved = useCallback(() => {
    setRevealAcknowledged(true);
    setCopyError(null);
  }, []);

  return {
    acceptedTerms,
    canSubmit,
    copied,
    copyError,
    copyText,
    copyTokenButtonRef,
    curlCommand,
    email,
    expectedCadence,
    expectedVolume,
    handleSubmit,
    issuedKey,
    markTokenSaved,
    organization,
    pendingRequest,
    projectUrl,
    projectUrlValid,
    projectUrlValue,
    requestError,
    requesterName,
    requestStatus,
    selectedEndpoints,
    selectTokenText,
    setAcceptedTerms,
    setEmail,
    setExpectedCadence,
    setExpectedVolume,
    setOrganization,
    setProjectUrl,
    setRequesterName,
    setUseCase,
    setWebsite,
    toggleEndpoint,
    tokenCodeRef,
    tokenSecured,
    trimmedUseCaseLength,
    useCase,
    verificationError,
    verificationStatus,
    website,
  };
}
