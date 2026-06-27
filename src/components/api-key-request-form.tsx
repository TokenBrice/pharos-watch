"use client";

import {
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
  SELF_SERVE_USE_CASE_MAX_LENGTH,
  SELF_SERVE_USE_CASE_MIN_LENGTH,
} from "@shared/lib/ops-limits";
import { PUBLIC_API_HOST, PUBLIC_API_KEY_HEADER } from "@shared/lib/public-api-contract";
import { ApiKeySelfServeCadenceSchema } from "@shared/types/api-key-requests";
import { AlertCircle, CheckCircle2, Copy, KeyRound, Loader2, MailCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  useApiKeyRequestFormState,
} from "@/hooks/use-api-key-request-form-state";
import {
  API_KEY_REQUEST_CADENCE_OPTIONS,
  API_KEY_REQUEST_ENDPOINT_OPTIONS,
  API_KEY_REQUEST_EXPIRY_DAYS,
  API_KEY_REQUEST_OWNERSHIP_LIMIT_LABEL,
  API_KEY_REQUEST_SAMPLE_PATH,
  EMAIL_MAX_LENGTH,
  EXPECTED_VOLUME_MAX_LENGTH,
  NAME_MAX_LENGTH,
  ORGANIZATION_MAX_LENGTH,
  PROJECT_URL_MAX_LENGTH,
  endpointId,
  formatSelfServeExpiry,
} from "@/lib/api-key-request-form-view-model";

export function ApiKeyRequestForm() {
  const {
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
  } = useApiKeyRequestFormState();

  return (
    <div
      className={cn(
        "grid gap-5",
        issuedKey
          ? "lg:grid-cols-[minmax(0,0.46fr)_minmax(28rem,0.54fr)]"
          : "lg:grid-cols-[minmax(0,0.58fr)_minmax(20rem,0.42fr)]",
      )}
    >
      <form onSubmit={handleSubmit} className="pharos-card-shell p-4 sm:p-5">
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
              onChange={(event) => {
                const parsed = ApiKeySelfServeCadenceSchema.safeParse(event.target.value);
                if (parsed.success) setExpectedCadence(parsed.data);
              }}
              disabled={requestStatus === "submitting"}
            >
              {API_KEY_REQUEST_CADENCE_OPTIONS.map((option) => (
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
            {API_KEY_REQUEST_ENDPOINT_OPTIONS.map((option) => {
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
            Self-serve keys are limited to {SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE} rpm and expire after {API_KEY_REQUEST_EXPIRY_DAYS} days.
          </p>
        </div>
      </form>

      <aside className={cn("space-y-4", issuedKey ? "lg:sticky lg:top-24 lg:self-start" : "")}>
        <section
          className={cn(
            "pharos-card-shell p-4 sm:p-5",
            issuedKey
              ? "border-emerald-500/45 bg-emerald-500/8 ring-1 ring-emerald-500/20"
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
                  Prefix {issuedKey.key.keyPrefix} - Expires {formatSelfServeExpiry(issuedKey.key.expiresAt)}
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

              <div className="overflow-hidden rounded-xl border border-emerald-500/35 bg-zinc-950 text-zinc-100">
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
                onClick={markTokenSaved}
              >
                {tokenSecured ? "Key Saved" : "I Saved This Key"}
              </Button>
            </div>
          ) : null}
        </section>

        <section
          className={cn(
            "pharos-card-shell p-4 text-sm leading-relaxed text-muted-foreground sm:p-5",
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
              <dd className="font-mono text-lg font-semibold text-foreground">{API_KEY_REQUEST_EXPIRY_DAYS} days</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Ownership</dt>
              <dd className="font-medium text-foreground">{API_KEY_REQUEST_OWNERSHIP_LIMIT_LABEL}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Base URL</dt>
              <dd className="font-mono text-xs text-foreground">{PUBLIC_API_HOST}</dd>
            </div>
          </dl>
          <p className="mt-4">
            Use <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">{PUBLIC_API_KEY_HEADER}</code> on protected public routes such as <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">{API_KEY_REQUEST_SAMPLE_PATH}</code>.
          </p>
        </section>
      </aside>
    </div>
  );
}
