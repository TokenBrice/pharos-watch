"use client";

import { SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE } from "@shared/lib/ops-limits";
import { PUBLIC_API_HOST, PUBLIC_API_KEY_HEADER } from "@shared/lib/public-api-contract";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { IssuedTokenPanel } from "@/components/issued-token-panel";
import type { useApiKeyRequestFormState } from "@/hooks/use-api-key-request-form-state";
import {
  API_KEY_REQUEST_EXPIRY_DAYS,
  API_KEY_REQUEST_OWNERSHIP_LIMIT_LABEL,
  API_KEY_REQUEST_SAMPLE_PATH,
} from "@/lib/api-key-request-form-view-model";
import { cn } from "@/lib/utils";

type ApiKeyRequestFormModel = ReturnType<typeof useApiKeyRequestFormState>;

function ApiKeyPolicyCard({ issued }: { issued: boolean }) {
  return (
    <section
      className={cn(
        "pharos-card-shell p-4 text-sm leading-relaxed text-muted-foreground sm:p-5",
        issued ? "border-emerald-500/25 bg-emerald-500/6" : "",
      )}
    >
      <p className="pharos-kicker">{issued ? "Issued Key Policy" : "Default Policy"}</p>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs uppercase text-muted-foreground">Quota</dt>
          <dd className="pharos-numeric text-lg font-semibold text-foreground">
            {SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE} rpm
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-muted-foreground">Expiry</dt>
          <dd className="pharos-numeric text-lg font-semibold text-foreground">{API_KEY_REQUEST_EXPIRY_DAYS} days</dd>
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
        Use <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">{PUBLIC_API_KEY_HEADER}</code>{" "}
        on protected public routes such as{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">{API_KEY_REQUEST_SAMPLE_PATH}</code>.
      </p>
    </section>
  );
}

export function ApiKeyRequestReveal({ model }: { model: ApiKeyRequestFormModel }) {
  const {
    copied,
    copyError,
    copyText,
    copyTokenButtonRef,
    curlCommand,
    issuedKey,
    markTokenSaved,
    selectTokenText,
    tokenCodeRef,
    tokenSecured,
    verificationError,
    verificationStatus,
  } = model;

  return (
    <aside className={cn("space-y-4", issuedKey ? "lg:sticky lg:top-24 lg:self-start" : "")}>
      <section
        className={cn(
          "pharos-card-shell p-4 sm:p-5",
          issuedKey ? "border-emerald-500/45 bg-emerald-500/8 ring-1 ring-emerald-500/20" : "",
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
          <IssuedTokenPanel
            token={issuedKey.token}
            keyPrefix={issuedKey.key.keyPrefix}
            expiresAt={issuedKey.key.expiresAt}
            curlCommand={curlCommand}
            onceCopy="It is only displayed once after email verification."
            copied={copied}
            copyError={copyError}
            copyText={copyText}
            selectTokenText={selectTokenText}
            tokenCodeRef={tokenCodeRef}
            copyTokenButtonRef={copyTokenButtonRef}
            tokenSecured={tokenSecured}
            markTokenSaved={markTokenSaved}
          />
        ) : null}
      </section>

      <ApiKeyPolicyCard issued={Boolean(issuedKey)} />
    </aside>
  );
}
