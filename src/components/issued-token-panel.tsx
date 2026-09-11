"use client";

import type { RefObject } from "react";
import { Copy, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface IssuedTokenPanelProps {
  token: string;
  keyPrefix: string;
  /** Epoch seconds, or `null` for a key with no scheduled expiry. */
  expiresAt: number | null;
  curlCommand: string;
  /** Flow-specific note under the headline, e.g. when the token is shown once. */
  onceCopy: string;
  copied: "token" | "curl" | null;
  copyError: string | null;
  copyText: (kind: "token" | "curl", value: string) => void;
  selectTokenText: () => void;
  tokenCodeRef: RefObject<HTMLElement | null>;
  copyTokenButtonRef: RefObject<HTMLButtonElement | null>;
  tokenSecured: boolean;
  markTokenSaved: () => void;
}

/**
 * One-time token reveal shared by the self-serve email flow and the supporter
 * key claim: token block, curl sample, copy handling, and the unsaved-token
 * warning. Copy state and refs stay with the caller so each flow keeps its own
 * before-unload guard and focus handling.
 */
export function IssuedTokenPanel({
  token,
  keyPrefix,
  expiresAt,
  curlCommand,
  onceCopy,
  copied,
  copyError,
  copyText,
  selectTokenText,
  tokenCodeRef,
  copyTokenButtonRef,
  tokenSecured,
  markTokenSaved,
}: IssuedTokenPanelProps) {
  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/12 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300">
        <p className="text-base font-semibold">Copy this token now.</p>
        <p className="mt-1 text-xs leading-relaxed opacity-90">{onceCopy}</p>
        <p className="mt-2 text-xs opacity-90">
          Prefix {keyPrefix} - {expiresAt == null ? "No expiry" : `Expires ${new Date(expiresAt * 1000).toLocaleString()}`}
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
          <Button type="button" size="xs" variant="outline" onClick={selectTokenText}>Select Token</Button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-emerald-500/35 bg-[var(--code-surface-bg)] text-[var(--code-surface-fg)]">
        <div className="flex items-center justify-between border-b border-[var(--code-surface-border)] px-4 py-3">
          <span className="text-xs font-semibold uppercase text-[var(--code-surface-muted)]">Token</span>
          <Button
            ref={copyTokenButtonRef}
            type="button"
            size="xs"
            variant="ghost"
            className="h-7 text-[var(--code-surface-muted)] hover:bg-[var(--code-surface-border)] hover:text-[var(--code-surface-fg)]"
            onClick={() => copyText("token", token)}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {copied === "token" ? "Copied" : "Copy"}
          </Button>
        </div>
        <code ref={tokenCodeRef} tabIndex={-1} className="block break-all px-4 py-4 font-mono text-sm leading-relaxed outline-none sm:text-[0.95rem]">
          {token}
        </code>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-[var(--code-surface-bg)] text-[var(--code-surface-fg)]">
        <div className="flex items-center justify-between border-b border-[var(--code-surface-border)] px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase text-[var(--code-surface-muted)]">
            <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
            Sample
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-7 text-[var(--code-surface-muted)] hover:bg-[var(--code-surface-border)] hover:text-[var(--code-surface-fg)]"
            onClick={() => copyText("curl", curlCommand)}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {copied === "curl" ? "Copied" : "Copy"}
          </Button>
        </div>
        <pre className="overflow-x-auto px-3 py-3 text-xs leading-relaxed"><code>{curlCommand}</code></pre>
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
  );
}
