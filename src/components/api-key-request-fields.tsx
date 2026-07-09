"use client";

import {
  SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE,
  SELF_SERVE_USE_CASE_MAX_LENGTH,
  SELF_SERVE_USE_CASE_MIN_LENGTH,
} from "@shared/lib/ops-limits";
import { ApiKeySelfServeCadenceSchema } from "@shared/types/api-key-requests";
import { AlertCircle, KeyRound, Loader2, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { useApiKeyRequestFormState } from "@/hooks/use-api-key-request-form-state";
import {
  API_KEY_REQUEST_CADENCE_OPTIONS,
  API_KEY_REQUEST_ENDPOINT_OPTIONS,
  API_KEY_REQUEST_EXPIRY_DAYS,
  EMAIL_MAX_LENGTH,
  EXPECTED_VOLUME_MAX_LENGTH,
  NAME_MAX_LENGTH,
  ORGANIZATION_MAX_LENGTH,
  PROJECT_URL_MAX_LENGTH,
  endpointId,
} from "@/lib/api-key-request-form-view-model";
import { cn } from "@/lib/utils";

type ApiKeyRequestFormModel = ReturnType<typeof useApiKeyRequestFormState>;

const FIELD_CLASS =
  "pharos-focus-ring h-9 w-full rounded-md border border-border/60 bg-background/45 px-3 py-1 text-base text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm";

const TEXTAREA_CLASS =
  "pharos-focus-ring w-full resize-none rounded-md border border-border/60 bg-background/45 px-3 py-2 text-base text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

export function ApiKeyRequestFields({ model }: { model: ApiKeyRequestFormModel }) {
  const {
    acceptedTerms,
    canSubmit,
    email,
    expectedCadence,
    expectedVolume,
    handleSubmit,
    organization,
    pendingRequest,
    projectUrl,
    projectUrlValid,
    projectUrlValue,
    requestError,
    requesterName,
    requestStatus,
    selectedEndpoints,
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
    trimmedUseCaseLength,
    useCase,
    website,
  } = model;

  return (
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
          <input
            id="api-email"
            type="email"
            autoComplete="email"
            className={FIELD_CLASS}
            maxLength={EMAIL_MAX_LENGTH}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={requestStatus === "submitting"}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="api-name">Name</Label>
          <input
            id="api-name"
            autoComplete="name"
            className={FIELD_CLASS}
            maxLength={NAME_MAX_LENGTH}
            value={requesterName}
            onChange={(event) => setRequesterName(event.target.value)}
            disabled={requestStatus === "submitting"}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="api-org">Organization</Label>
          <input
            id="api-org"
            autoComplete="organization"
            className={FIELD_CLASS}
            maxLength={ORGANIZATION_MAX_LENGTH}
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
            disabled={requestStatus === "submitting"}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="api-url">Project URL</Label>
          <input
            id="api-url"
            type="url"
            placeholder="https://"
            className={FIELD_CLASS}
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
        <textarea
          id="api-use-case"
          value={useCase}
          onChange={(event) => setUseCase(event.target.value)}
          rows={5}
          maxLength={SELF_SERVE_USE_CASE_MAX_LENGTH}
          aria-describedby="api-use-case-help"
          disabled={requestStatus === "submitting"}
          className={TEXTAREA_CLASS}
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
            className={FIELD_CLASS}
            value={expectedCadence}
            onChange={(event) => {
              const parsed = ApiKeySelfServeCadenceSchema.safeParse(event.target.value);
              if (parsed.success) setExpectedCadence(parsed.data);
            }}
            disabled={requestStatus === "submitting"}
          >
            {API_KEY_REQUEST_CADENCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="api-volume">Expected Volume</Label>
          <input
            id="api-volume"
            placeholder="e.g. 2,000 requests/day"
            className={FIELD_CLASS}
            maxLength={EXPECTED_VOLUME_MAX_LENGTH}
            aria-describedby="api-volume-help"
            value={expectedVolume}
            onChange={(event) => setExpectedVolume(event.target.value)}
            disabled={requestStatus === "submitting"}
          />
          <p id="api-volume-help" className="text-xs text-muted-foreground">
            Optional. {EXPECTED_VOLUME_MAX_LENGTH} characters max.
          </p>
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
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  checked
                    ? "border-transparent bg-foreground text-background"
                    : "border-border/60 bg-background/45 text-muted-foreground hover:text-foreground",
                )}
              >
                <input
                  id={id}
                  type="checkbox"
                  className="size-4 accent-foreground"
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
        <input
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
          className="mt-0.5 size-4 accent-foreground"
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
  );
}
