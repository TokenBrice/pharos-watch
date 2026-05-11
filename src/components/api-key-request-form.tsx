"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints";
import {
  SELF_SERVE_API_KEY_EXPIRY_SEC,
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
  SELF_SERVE_MAX_ACTIVE_KEYS_PER_EMAIL,
  SELF_SERVE_USE_CASE_MAX_LENGTH,
  SELF_SERVE_USE_CASE_MIN_LENGTH,
} from "@shared/lib/ops-limits";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import type {
  ApiKeySelfServeCadence,
  ApiKeySelfServeIssueResponse,
  ApiKeySelfServePendingResponse,
  ApiKeySelfServeRequest,
} from "@shared/types";
import { AlertCircle, CheckCircle2, Copy, KeyRound, Loader2, MailCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { buildApiUrl } from "@/lib/api";

declare global {
  interface Window {
    __PHAROS_API_KEY_VERIFY_TOKEN__?: string;
    __PHAROS_SANITIZED_PATH__?: string;
  }
}

const ENDPOINT_OPTIONS = [
  { path: "/api/stablecoins", label: "Stablecoin list" },
  { path: "/api/stablecoin/:id", label: "Stablecoin detail" },
  { path: "/api/peg-summary", label: "Peg summary" },
  { path: "/api/depeg-events", label: "Depeg events" },
  { path: "/api/dex-liquidity", label: "DEX liquidity" },
  { path: "/api/yield-rankings", label: "Yield rankings" },
  { path: "/api/report-cards", label: "Report cards" },
  { path: "/api/chains", label: "Chains" },
  { path: "unknown", label: "Not sure yet" },
] as const;

const CADENCE_OPTIONS: readonly { value: ApiKeySelfServeCadence; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "every_5_min", label: "Every 5 minutes" },
  { value: "every_1_min", label: "Every minute" },
  { value: "manual", label: "Manual or ad hoc" },
  { value: "other", label: "Other" },
];

const EXPIRY_DAYS = Math.round(SELF_SERVE_API_KEY_EXPIRY_SEC / 86_400);
const SAMPLE_PATH = "/api/stablecoins";
const OWNERSHIP_LIMIT_LABEL = SELF_SERVE_MAX_ACTIVE_KEYS_PER_EMAIL === 1
  ? "One active key per email"
  : `${SELF_SERVE_MAX_ACTIVE_KEYS_PER_EMAIL} active keys per email`;
const EMAIL_MAX_LENGTH = 200;
const NAME_MAX_LENGTH = 80;
const ORGANIZATION_MAX_LENGTH = 120;
const PROJECT_URL_MAX_LENGTH = 300;
const EXPECTED_VOLUME_MAX_LENGTH = 300;

type RequestStatus = "idle" | "submitting" | "pending" | "error";
type VerificationStatus = "idle" | "verifying" | "issued" | "error";

interface ApiErrorPayload {
  error?: string;
  message?: string;
}

async function readJson<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function resolveErrorMessage(status: number, payload: ApiErrorPayload | null): string {
  return payload?.error ?? payload?.message ?? `Request failed with status ${status}`;
}

function parseHashVerificationToken(hash: string): string | null {
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!rawHash) return null;

  if (rawHash.startsWith("verify=") || rawHash.startsWith("token=")) {
    return new URLSearchParams(rawHash).get("verify")?.trim()
      ?? new URLSearchParams(rawHash).get("token")?.trim()
      ?? null;
  }

  const queryStart = rawHash.indexOf("?");
  if (queryStart >= 0) {
    return new URLSearchParams(rawHash.slice(queryStart + 1)).get("verify")?.trim() ?? null;
  }

  return null;
}

function scrubHashVerificationToken(hash: string): string {
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!rawHash) return "";

  if (rawHash.startsWith("verify=") || rawHash.startsWith("token=")) {
    const params = new URLSearchParams(rawHash);
    params.delete("verify");
    params.delete("token");
    const next = params.toString();
    return next ? `#${next}` : "";
  }

  const queryStart = rawHash.indexOf("?");
  if (queryStart < 0) return hash;

  const path = rawHash.slice(0, queryStart);
  const params = new URLSearchParams(rawHash.slice(queryStart + 1));
  params.delete("verify");
  const next = params.toString();
  return `#${path}${next ? `?${next}` : ""}`;
}

function readVerificationTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  return url.searchParams.get("verify")?.trim() || parseHashVerificationToken(url.hash);
}

function stripVerificationTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const hasLegacyQueryToken = url.searchParams.has("verify");
  const nextHash = scrubHashVerificationToken(url.hash);
  const hashChanged = nextHash !== url.hash;
  if (!hasLegacyQueryToken && !hashChanged) return;

  url.searchParams.delete("verify");
  const search = url.searchParams.toString();
  const nextUrl = `${url.pathname}${search ? `?${search}` : ""}${nextHash}`;
  window.history.replaceState(null, "", nextUrl);
}

function takePreSanitizedVerificationToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = window.__PHAROS_API_KEY_VERIFY_TOKEN__?.trim();
  if (token) {
    delete window.__PHAROS_API_KEY_VERIFY_TOKEN__;
    return token;
  }
  return null;
}

function endpointId(path: string): string {
  return `endpoint-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

function formatExpiry(epochSeconds: number | null): string {
  if (epochSeconds == null) return "No expiry";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function buildCurlCommand(token: string): string {
  return [
    "curl https://api.pharos.watch/api/stablecoins \\",
    `  -H "X-API-Key: ${token}" \\`,
    "  -H \"Accept: application/json\"",
  ].join("\n");
}

export function ApiKeyRequestForm() {
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
      const response = await fetch(buildApiUrl(API_PATHS.apiKeyRequestVerify()), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
        },
        body: JSON.stringify({ token }),
      });
      const payload = await readJson<ApiKeySelfServeIssueResponse | ApiErrorPayload>(response);
      if (!response.ok || !payload || !("status" in payload) || payload.status !== "issued") {
        throw new Error(resolveErrorMessage(response.status, payload && !("status" in payload) ? payload : null));
      }
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

  function toggleEndpoint(path: string): void {
    setSelectedEndpoints((current) => {
      if (current.includes(path)) {
        return current.filter((item) => item !== path);
      }
      if (path === "unknown") {
        return ["unknown"];
      }
      return [...current.filter((item) => item !== "unknown"), path];
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
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
      const response = await fetch(buildApiUrl(API_PATHS.apiKeyRequests()), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
        },
        body: JSON.stringify(body),
      });
      const payload = await readJson<ApiKeySelfServePendingResponse | ApiErrorPayload>(response);
      if (!response.ok || !payload || !("status" in payload) || payload.status !== "pending_verification") {
        throw new Error(resolveErrorMessage(response.status, payload && !("status" in payload) ? payload : null));
      }
      setPendingRequest(payload);
      setRequestStatus("pending");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Could not submit API key request");
      setRequestStatus("error");
    }
  }

  return (
    <div
      className={cn(
        "grid gap-5",
        issuedKey
          ? "lg:grid-cols-[minmax(0,0.46fr)_minmax(28rem,0.54fr)]"
          : "lg:grid-cols-[minmax(0,0.58fr)_minmax(20rem,0.42fr)]",
      )}
    >
      <form onSubmit={handleSubmit} className="rounded-[1.5rem] border border-border/60 bg-card/78 p-4 shadow-[0_18px_40px_oklch(0_0_0_/0.08)] sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="pharos-kicker">Email Verification</p>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">Request API Access</h2>
          </div>
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/75 text-foreground">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
          </span>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="api-email">Email</Label>
            <Input
              id="api-email"
              type="email"
              autoComplete="email"
              maxLength={EMAIL_MAX_LENGTH}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={requestStatus === "submitting"}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="api-name">Name</Label>
            <Input
              id="api-name"
              autoComplete="name"
              maxLength={NAME_MAX_LENGTH}
              value={requesterName}
              onChange={(event) => setRequesterName(event.target.value)}
              disabled={requestStatus === "submitting"}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="api-org">Organization</Label>
            <Input
              id="api-org"
              autoComplete="organization"
              maxLength={ORGANIZATION_MAX_LENGTH}
              value={organization}
              onChange={(event) => setOrganization(event.target.value)}
              disabled={requestStatus === "submitting"}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="api-url">Project URL</Label>
            <Input
              id="api-url"
              type="url"
              placeholder="https://"
              maxLength={PROJECT_URL_MAX_LENGTH}
              aria-describedby="api-url-help"
              aria-invalid={projectUrlValue.length > 0 && !projectUrlValid}
              value={projectUrl}
              onChange={(event) => setProjectUrl(event.target.value)}
              disabled={requestStatus === "submitting"}
            />
            <p id="api-url-help" className="text-xs text-muted-foreground">Optional. HTTPS URLs only.</p>
          </div>
        </div>

        <div className="mt-4 space-y-1.5">
          <Label htmlFor="api-use-case">Use Case</Label>
          <Textarea
            id="api-use-case"
            value={useCase}
            onChange={(event) => setUseCase(event.target.value)}
            rows={5}
            maxLength={SELF_SERVE_USE_CASE_MAX_LENGTH}
            aria-describedby="api-use-case-help"
            disabled={requestStatus === "submitting"}
            className="resize-none"
            required
          />
          <p id="api-use-case-help" className="text-xs text-muted-foreground">
            {trimmedUseCaseLength}/{SELF_SERVE_USE_CASE_MAX_LENGTH}. Minimum {SELF_SERVE_USE_CASE_MIN_LENGTH} characters.
          </p>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="api-cadence">Expected Cadence</Label>
            <select
              id="api-cadence"
              className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={expectedCadence}
              onChange={(event) => setExpectedCadence(event.target.value as ApiKeySelfServeCadence)}
              disabled={requestStatus === "submitting"}
            >
              {CADENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="api-volume">Expected Volume</Label>
            <Input
              id="api-volume"
              placeholder="e.g. 2,000 requests/day"
              maxLength={EXPECTED_VOLUME_MAX_LENGTH}
              aria-describedby="api-volume-help"
              value={expectedVolume}
              onChange={(event) => setExpectedVolume(event.target.value)}
              disabled={requestStatus === "submitting"}
            />
            <p id="api-volume-help" className="text-xs text-muted-foreground">Optional. {EXPECTED_VOLUME_MAX_LENGTH} characters max.</p>
          </div>
        </div>

        <fieldset className="mt-4 space-y-3">
          <legend className="text-sm font-medium text-foreground">Intended Endpoints</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {ENDPOINT_OPTIONS.map((option) => {
              const id = endpointId(option.path);
              const checked = selectedEndpoints.includes(option.path);
              return (
                <label
                  key={option.path}
                  htmlFor={id}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-background/45 px-3 py-2 text-sm transition-colors",
                    checked ? "border-emerald-500/40 bg-emerald-500/10 text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <input
                    id={id}
                    type="checkbox"
                    className="size-4 accent-emerald-600"
                    checked={checked}
                    onChange={() => toggleEndpoint(option.path)}
                    disabled={requestStatus === "submitting"}
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="hidden" aria-hidden="true">
          <Label htmlFor="api-website">Website</Label>
          <Input
            id="api-website"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
          />
        </div>

        <label className="mt-4 flex gap-2 rounded-md border border-border/60 bg-background/45 px-3 py-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-emerald-600"
            checked={acceptedTerms}
            onChange={(event) => setAcceptedTerms(event.target.checked)}
            disabled={requestStatus === "submitting"}
          />
          <span>
            I will use the API for read-only public data, respect 429 Retry-After responses, and avoid storing the token in public client-side code.
          </span>
        </label>

        {requestError ? (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{requestError}</p>
          </div>
        ) : null}

        {pendingRequest ? (
          <div role="status" aria-live="polite" className="mt-4 flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
            <MailCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">Check your inbox to verify this request.</p>
              <p className="mt-1 text-xs opacity-90">If this address can receive verification email, the link will arrive shortly.</p>
            </div>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!canSubmit}>
            {requestStatus === "submitting" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <MailCheck className="h-4 w-4" aria-hidden="true" />
            )}
            Send Verification Email
          </Button>
          <p className="text-xs text-muted-foreground">
            Self-serve keys are limited to {SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE} rpm and expire after {EXPIRY_DAYS} days.
          </p>
        </div>
      </form>

      <aside className={cn("space-y-4", issuedKey ? "lg:sticky lg:top-24 lg:self-start" : "")}>
        <section
          className={cn(
            "rounded-[1.5rem] border border-border/60 bg-card/78 p-4 shadow-[0_18px_40px_oklch(0_0_0_/0.08)] sm:p-5",
            issuedKey
              ? "border-emerald-500/45 bg-emerald-500/8 shadow-[0_24px_70px_oklch(0.73_0.17_160_/0.18)] ring-1 ring-emerald-500/20"
              : "",
          )}
          aria-live={verificationStatus === "issued" || verificationStatus === "verifying" ? "polite" : undefined}
        >
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/75 text-foreground",
                issuedKey ? "size-12 border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-300" : "",
              )}
            >
              {verificationStatus === "verifying" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : verificationStatus === "issued" ? (
                <CheckCircle2 className={cn("h-4 w-4 text-emerald-500", issuedKey ? "h-5 w-5" : "")} aria-hidden="true" />
              ) : (
                <KeyRound className="h-4 w-4" aria-hidden="true" />
              )}
            </span>
            <div className="space-y-1">
              <p className="pharos-kicker">{issuedKey ? "Verification Complete" : "Verification"}</p>
              <h2 className={cn("font-semibold tracking-tight text-foreground", issuedKey ? "text-2xl" : "text-lg")}>
                {issuedKey ? "Your API Key Is Ready" : "One-Time Key Reveal"}
              </h2>
            </div>
          </div>

          {verificationStatus === "idle" ? (
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              The verification link opens this page and exchanges a one-time token for the API key. The key is shown once after email verification.
            </p>
          ) : null}

          {verificationStatus === "verifying" ? (
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">Verifying email and issuing the API key.</p>
          ) : null}

          {verificationError ? (
            <div role="alert" className="mt-4 rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {verificationError}
            </div>
          ) : null}

          {issuedKey ? (
            <div className="mt-5 space-y-4">
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/12 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300">
                <p className="text-base font-semibold">Copy this token now.</p>
                <p className="mt-1 text-xs leading-relaxed opacity-90">
                  It is only displayed once after email verification.
                </p>
                <p className="mt-2 text-xs opacity-90">
                  Prefix {issuedKey.key.keyPrefix} - Expires {formatExpiry(issuedKey.key.expiresAt)}
                </p>
                {!tokenSecured ? (
                  <p className="mt-2 text-xs font-medium opacity-95">
                    This page will warn before closing until the token is copied or marked saved.
                  </p>
                ) : null}
              </div>

              {copyError ? (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                  <span>{copyError}</span>
                  <Button type="button" size="xs" variant="outline" onClick={selectTokenText}>
                    Select Token
                  </Button>
                </div>
              ) : null}

              <div className="overflow-hidden rounded-2xl border border-emerald-500/35 bg-zinc-950 text-zinc-100 shadow-inner">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                  <span className="text-xs font-semibold uppercase text-zinc-400">Token</span>
                  <Button
                    ref={copyTokenButtonRef}
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="h-7 text-zinc-300 hover:bg-white/10 hover:text-white"
                    onClick={() => copyText("token", issuedKey.token)}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    {copied === "token" ? "Copied" : "Copy"}
                  </Button>
                </div>
                <code ref={tokenCodeRef} tabIndex={-1} className="block break-all px-4 py-4 font-mono text-sm leading-relaxed outline-none sm:text-[0.95rem]">{issuedKey.token}</code>
              </div>

              <div className="overflow-hidden rounded-xl border border-border/60 bg-zinc-950 text-zinc-100">
                <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase text-zinc-400">
                    <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                    Sample
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="h-7 text-zinc-300 hover:bg-white/10 hover:text-white"
                    onClick={() => copyText("curl", curlCommand)}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    {copied === "curl" ? "Copied" : "Copy"}
                  </Button>
                </div>
                <pre className="overflow-x-auto px-3 py-3 text-xs leading-relaxed">
                  <code>{curlCommand}</code>
                </pre>
              </div>

              <Button
                type="button"
                variant={tokenSecured ? "outline" : "default"}
                className="w-full"
                onClick={() => {
                  setRevealAcknowledged(true);
                  setCopyError(null);
                }}
              >
                {tokenSecured ? "Key Saved" : "I Saved This Key"}
              </Button>
            </div>
          ) : null}
        </section>

        <section
          className={cn(
            "rounded-[1.5rem] border border-border/60 bg-card/78 p-4 text-sm leading-relaxed text-muted-foreground shadow-[0_18px_40px_oklch(0_0_0_/0.08)] sm:p-5",
            issuedKey ? "border-emerald-500/25 bg-emerald-500/6" : "",
          )}
        >
          <p className="pharos-kicker">{issuedKey ? "Issued Key Policy" : "Default Policy"}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Quota</dt>
              <dd className="font-mono text-lg font-semibold text-foreground">{SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE} rpm</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Expiry</dt>
              <dd className="font-mono text-lg font-semibold text-foreground">{EXPIRY_DAYS} days</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Ownership</dt>
              <dd className="font-medium text-foreground">{OWNERSHIP_LIMIT_LABEL}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Base URL</dt>
              <dd className="font-mono text-xs text-foreground">https://api.pharos.watch</dd>
            </div>
          </dl>
          <p className="mt-4">
            Use <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">X-API-Key</code> on protected public routes such as <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">{SAMPLE_PATH}</code>.
          </p>
        </section>
      </aside>
    </div>
  );
}
