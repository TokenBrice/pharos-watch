"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { KeyRound, Loader2 } from "lucide-react";
import { DONOR_API_KEY_MIN_USD } from "@shared/lib/ops-limits";
import { buildPublicApiCurlCommand } from "@shared/lib/public-api-contract";
import { buildDonorClaimSiweMessage, generateDonorClaimNonce } from "@shared/lib/donor-key-claim";
import { getAddress } from "viem/utils";
import { formatIsoDate } from "@shared/lib/format";
import type { DonorKeyClaimResponse } from "@shared/types";
import { Button } from "@/components/ui/button";
import { IssuedTokenPanel } from "@/components/issued-token-panel";
import { copyText as writeClipboardText } from "@/lib/clipboard";
import { DonorKeyClaimError, claimDonorKey, hexUtf8 } from "@/lib/donor-key-claim-client";

type ClaimStatus = "idle" | "no-provider" | "connecting" | "signing" | "submitting" | "issued" | "error";

interface ClaimFailure {
  status: number | null;
  text: string;
}

/** Minimal EIP-1193 surface; the page never loads a wallet library. */
interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const NO_PROVIDER_COPY =
  "Open this page inside your wallet's in-app browser, or use a desktop browser wallet. Only externally-owned wallets can sign.";

function readProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
  return candidate && typeof candidate.request === "function" ? candidate : null;
}

function firstAccount(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const account = result[0];
  return typeof account === "string" && account.length > 0 ? account : null;
}

/** EIP-1193 user-rejection code. */
function isUserRejection(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code: unknown }).code === 4001;
}

function describeClaimFailure(error: unknown): ClaimFailure {
  if (!(error instanceof DonorKeyClaimError)) {
    return { status: null, text: "The claim could not be completed. Check your connection and try again." };
  }

  switch (error.status) {
    case 400:
      return { status: 400, text: "The wallet could not be verified. Try again." };
    case 403:
      if (error.ledgerUpdatedAt != null) {
        return {
          status: 403,
          text: `This wallet has not reached $${DONOR_API_KEY_MIN_USD} in the donation ledger reconciled on ${formatIsoDate(error.ledgerUpdatedAt)}. New donations count after the weekly reconciliation and the next release.`,
        };
      }
      if (/revok/i.test(error.message)) {
        return { status: 403, text: "The key for this wallet was deactivated. Ask through the feedback form if you think that is wrong." };
      }
      if (/paus|clos/i.test(error.message)) {
        return { status: 403, text: "Supporter key claims are paused for now. Try again after the next release." };
      }
      return { status: 403, text: error.message };
    case 409:
      return { status: 409, text: "This wallet already claimed its key. Lost it? Ask for a rotation through the" };
    case 429:
      return { status: 429, text: "Too many attempts, wait a minute." };
    case 503:
      return { status: 503, text: "Supporter key claims are unavailable right now. Try again later." };
    default:
      return { status: error.status, text: error.message };
  }
}

/** Copy, focus, and unsaved-token handling for the one-time reveal. */
function useIssuedTokenControls(token: string | null) {
  const [copied, setCopied] = useState<"token" | "curl" | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [tokenSecured, setTokenSecured] = useState(false);
  const tokenCodeRef = useRef<HTMLElement | null>(null);
  const copyTokenButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!token) return;
    copyTokenButtonRef.current?.focus();
  }, [token]);

  useEffect(() => {
    if (!token || tokenSecured) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [token, tokenSecured]);

  const copyText = useCallback((kind: "token" | "curl", value: string) => {
    void writeClipboardText(value).then((result) => {
      if (!result.ok) {
        setCopied(null);
        setCopyError("Copy failed. Select the text and copy it manually before leaving this page.");
        return;
      }
      setCopied(kind);
      setCopyError(null);
      if (kind === "token") setTokenSecured(true);
      window.setTimeout(() => setCopied(null), 1800);
    });
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

  const markTokenSaved = useCallback(() => {
    setTokenSecured(true);
    setCopyError(null);
  }, []);

  return {
    copied,
    copyError,
    copyText,
    copyTokenButtonRef,
    markTokenSaved,
    selectTokenText,
    tokenCodeRef,
    tokenSecured,
  };
}

export function DonorKeyClaim() {
  const [status, setStatus] = useState<ClaimStatus>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<ClaimFailure | null>(null);
  const [siweMessage, setSiweMessage] = useState<string | null>(null);
  const [issued, setIssued] = useState<DonorKeyClaimResponse | null>(null);
  const controls = useIssuedTokenControls(issued?.token ?? null);

  const handleClaim = useCallback(async () => {
    const provider = readProvider();
    if (!provider) {
      setStatus("no-provider");
      return;
    }

    setNote(null);
    setFailure(null);
    setStatus("connecting");

    try {
      const requested = firstAccount(await provider.request({ method: "eth_requestAccounts" }));
      if (!requested) {
        setStatus("idle");
        setNote("The wallet did not share an account. Try again.");
        return;
      }

      // The active account can change while the wallet prompt is open, and the
      // signature must come from the account written into the message.
      const active = firstAccount(await provider.request({ method: "eth_accounts" }));
      if (!active || active.toLowerCase() !== requested.toLowerCase()) {
        setStatus("idle");
        setSiweMessage(null);
        setNote("The active wallet account changed. Start the claim again.");
        return;
      }

      // EIP-55 checksum: wallets only render the SIWE domain warning for a
      // checksummed address; the Worker accepts either case.
      const message = buildDonorClaimSiweMessage({
        address: getAddress(active),
        nonce: generateDonorClaimNonce(),
        issuedAt: new Date(),
      });
      setSiweMessage(message);
      setStatus("signing");

      const signature = await provider.request({
        method: "personal_sign",
        params: [hexUtf8(message), active],
      });
      if (typeof signature !== "string") {
        setStatus("error");
        setFailure({ status: null, text: "The wallet returned an unexpected signature. Try again." });
        return;
      }
      // The account can also change while the signing prompt is open; a
      // signature from another account would only earn a 400, but say why.
      const signer = firstAccount(await provider.request({ method: "eth_accounts" }));
      if (!signer || signer.toLowerCase() !== active.toLowerCase()) {
        setStatus("idle");
        setSiweMessage(null);
        setNote("The active wallet account changed during signing. Start the claim again.");
        return;
      }

      setStatus("submitting");
      setIssued(await claimDonorKey({ message, signature }));
      setStatus("issued");
    } catch (error) {
      if (isUserRejection(error)) {
        setStatus("idle");
        setNote("The request was declined in the wallet. Nothing was sent to Pharos.");
        return;
      }
      setFailure(describeClaimFailure(error));
      setStatus("error");
    }
  }, []);

  if (status === "issued" && issued) {
    return (
      <div className="mt-4">
        <p className="pharos-kicker">Supporter Key Issued</p>
        <IssuedTokenPanel
          token={issued.token}
          keyPrefix={issued.key.keyPrefix}
          expiresAt={issued.key.expiresAt}
          curlCommand={buildPublicApiCurlCommand({ tokenReference: issued.token, includeAcceptHeader: true })}
          onceCopy={`It is only displayed once. The key allows ${issued.key.rateLimitPerMinute} requests per minute and has no scheduled expiry.`}
          copied={controls.copied}
          copyError={controls.copyError}
          copyText={controls.copyText}
          selectTokenText={controls.selectTokenText}
          tokenCodeRef={controls.tokenCodeRef}
          copyTokenButtonRef={controls.copyTokenButtonRef}
          tokenSecured={controls.tokenSecured}
          markTokenSaved={controls.markTokenSaved}
        />
      </div>
    );
  }

  const busy = status === "connecting" || status === "signing" || status === "submitting";
  const busyLabel = status === "connecting"
    ? "Waiting for the wallet"
    : status === "signing"
      ? "Waiting for the signature"
      : "Issuing the key";

  return (
    <div className="mt-4 space-y-3">
      <Button type="button" onClick={() => void handleClaim()} disabled={busy} className="w-full sm:w-auto">
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <KeyRound className="h-4 w-4" aria-hidden="true" />
        )}
        {busy ? busyLabel : "Claim supporter key"}
      </Button>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Sign only on pharos.watch. If the wallet warns that the requesting site does not match pharos.watch, reject
        the request: a signed claim can be redeemed by whoever holds it first.
      </p>

      {siweMessage ? (
        <details className="rounded-xl border border-border/60 bg-background/70 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-foreground">Read the text before approving it</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">{siweMessage}</pre>
        </details>
      ) : null}

      {status === "no-provider" ? (
        <p role="status" className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {NO_PROVIDER_COPY}
        </p>
      ) : null}

      {note ? (
        <p role="status" className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {note}
        </p>
      ) : null}

      {failure ? (
        <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {failure.text}
          {failure.status === 409 ? (
            <>
              {" "}
              <Link href="/feedback/" className="pharos-prose-link">
                feedback form
              </Link>
              .
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
