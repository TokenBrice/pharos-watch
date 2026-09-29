"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { KeyRound, Loader2 } from "lucide-react";
import { DONOR_API_KEY_MIN_USD, DONOR_KEY_CLAIM_MAX_AGE_SEC } from "@shared/lib/ops-limits";
import {
  API_ACCESS_TELEGRAM_HANDLE,
  API_ACCESS_TELEGRAM_URL,
  API_ACCESS_X_HANDLE,
  API_ACCESS_X_URL,
  API_PAGE_ANCHORS,
  PUBLIC_API_ARTIFACTS,
  buildPublicApiCurlCommand,
} from "@shared/lib/public-api-contract";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { buildDonorClaimSiweMessage, generateDonorClaimNonce } from "@shared/lib/donor-key-claim";
import { getAddress } from "viem/utils";
import { formatIsoDate } from "@shared/lib/format";
import type { DonorKeyClaimResponse } from "@shared/types";
import { Button } from "@/components/ui/button";
import { IssuedTokenPanel } from "@/components/issued-token-panel";
import { copyText as writeClipboardText } from "@/lib/clipboard";
import { DonorKeyClaimError, claimDonorKey, hexUtf8 } from "@/lib/donor-key-claim-client";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useUnsavedTokenGuard } from "@/hooks/use-unsaved-token-guard";
import { beginPendingApiKeyIssuance, clearPendingApiKey } from "@/components/pending-api-key-recovery";

type ClaimStatus = "idle" | "connecting" | "signing" | "submitting" | "issued" | "error";

interface ClaimFailure {
  status: number | null;
  text: ReactNode;
}

/** Minimal EIP-1193 surface; the page never loads a wallet library. */
interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const NO_PROVIDER_COPY = "No browser wallet found. Use a wallet extension, or open this page in:";

/** The claim section URL a mobile wallet opens in its in-app browser. */
const CLAIM_PAGE_URL = `${SITE_ORIGIN}/api/#${API_PAGE_ANCHORS.claim}`;
/** MetaMask deep links take the host and path without the scheme. */
const METAMASK_CLAIM_URL = `https://link.metamask.io/dapp/${CLAIM_PAGE_URL.replace(/^https?:\/\//, "")}`;
const COINBASE_WALLET_CLAIM_URL = `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(CLAIM_PAGE_URL)}`;

const CLAIM_MAX_AGE_MINUTES = DONOR_KEY_CLAIM_MAX_AGE_SEC / 60;

const TELEGRAM_CONTACT_LINK = (
  <a href={API_ACCESS_TELEGRAM_URL} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
    @{API_ACCESS_TELEGRAM_HANDLE}
  </a>
);

const X_CONTACT_LINK = (
  <a href={API_ACCESS_X_URL} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
    @{API_ACCESS_X_HANDLE}
  </a>
);

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

  if (error.reason === "grade_unavailable") {
    return { status: error.status, text: "Safety grades are temporarily unavailable, so this wallet's eligibility cannot be confirmed yet. Try again later." };
  }
  if (error.reason === "ineligible" && error.qualifyingUsd != null && error.ledgerUpdatedAt != null) {
    const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(error.qualifyingUsd);
    return {
      status: error.status,
      text: `This wallet has ${amount} of $${DONOR_API_KEY_MIN_USD} in qualifying donations as of ${formatIsoDate(error.ledgerUpdatedAt)}. The qualifying stablecoins are listed on this page, and the donor list is updated every Sunday.`,
    };
  }
  const reasonStatus = error.reason == null ? error.status
    : error.reason === "ineligible" || error.reason === "claim_revoked" || error.reason === "claims_closed" ? 403
      : error.reason === "claim_exists" || error.reason === "claim_orphaned" ? 409
        : error.reason === "rate_limited" ? 429
          : error.reason === "body_invalid" || error.reason === "siwe_invalid" || error.reason === "signature_invalid" ? 400
            : 503;
  switch (reasonStatus) {
    case 400:
      return {
        status: 400,
        text: `The signature could not be verified. Smart-contract wallets (Safe, Coinbase Smart Wallet and similar) cannot claim yet. If this is a regular wallet, check the device clock (the message is valid for ${CLAIM_MAX_AGE_MINUTES} minutes) and try again.`,
      };
    case 403:
      if (error.reason === "ineligible" || (error.reason == null && error.ledgerUpdatedAt != null)) {
        return {
          status: 403,
          text: `This wallet has not reached $${DONOR_API_KEY_MIN_USD} in qualifying donations${error.ledgerUpdatedAt == null ? "" : ` in the ledger reconciled on ${formatIsoDate(error.ledgerUpdatedAt)}`}. The qualifying stablecoins are listed on this page, and the donor list is updated every Sunday.`,
        };
      }
      if (error.reason === "claim_revoked" || (error.reason == null && /revok/i.test(error.message))) {
        return {
          status: 403,
          text: (
            <>
              The key for this wallet was deactivated. If you think that is wrong, message {TELEGRAM_CONTACT_LINK} on
              Telegram or DM {X_CONTACT_LINK} on X.
            </>
          ),
        };
      }
      if (error.reason === "claims_closed" || (error.reason == null && /paus|clos/i.test(error.message))) {
        return { status: 403, text: "Supporter key claims are paused. Try again after the next release." };
      }
      return { status: 403, text: error.message };
    case 409:
      return {
        status: 409,
        text: (
          <>
            This wallet already claimed its key. Lost it? Message {TELEGRAM_CONTACT_LINK} on Telegram (or DM{" "}
            {X_CONTACT_LINK} on X) for a rotation.
          </>
        ),
      };
    case 429:
      return { status: 429, text: "Too many attempts, wait a minute." };
    case 503:
      return { status: 503, text: "Supporter key claims are unavailable right now. Claims pause while the current Safety Score publication is held or unavailable. Try again later." };
    default:
      return { status: error.status, text: error.message };
  }
}

/** Copy, focus, and unsaved-token handling for the one-time reveal. */
function useIssuedTokenControls(token: string | null, issuing: boolean) {
  const [copied, setCopied] = useState<"token" | "curl" | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [tokenSecured, setTokenSecured] = useState(false);
  const tokenCodeRef = useRef<HTMLElement | null>(null);
  const copyTokenButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!token) return;
    copyTokenButtonRef.current?.focus();
  }, [token]);

  const retainIssuedToken = useUnsavedTokenGuard(token, tokenSecured, issuing);

  const copyText = useCallback((kind: "token" | "curl", value: string) => {
    void writeClipboardText(value).then((result) => {
      if (!result.ok) {
        setCopied(null);
        setCopyError("Copy failed. Select the text and copy it manually before leaving this page.");
        return;
      }
      setCopied(kind);
      setCopyError(null);
      if (kind === "token") {
        clearPendingApiKey(value);
        setTokenSecured(true);
      }
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
    retainIssuedToken,
  };
}

export function DonorKeyClaim() {
  const [status, setStatus] = useState<ClaimStatus>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<ClaimFailure | null>(null);
  const [siweMessage, setSiweMessage] = useState<string | null>(null);
  const [issued, setIssued] = useState<DonorKeyClaimResponse | null>(null);
  const [providerMissing, setProviderMissing] = useState(false);
  const [walletFocusRequest, setWalletFocusRequest] = useState(0);
  const walletLinkRef = useRef<HTMLAnchorElement | null>(null);
  const { copied: pageLinkCopied, copy: copyPageLink } = useCopyToClipboard(1800);
  const controls = useIssuedTokenControls(issued?.token ?? null, status === "submitting");
  const { retainIssuedToken } = controls;

  useEffect(() => {
    // Wallet injection only exists in the browser, so detection waits for
    // mount and the server and hydration markup stay identical.
    setProviderMissing(readProvider() === null);
    // Some wallets inject after load and announce it with this event.
    const recheck = () => setProviderMissing(readProvider() === null);
    window.addEventListener("ethereum#initialized", recheck, { once: true });
    return () => window.removeEventListener("ethereum#initialized", recheck);
  }, []);

  useEffect(() => {
    if (providerMissing && walletFocusRequest > 0) walletLinkRef.current?.focus();
  }, [providerMissing, walletFocusRequest]);

  const handleClaim = useCallback(async () => {
    const provider = readProvider();
    if (!provider) {
      setProviderMissing(true);
      setWalletFocusRequest((request) => request + 1);
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
      const finishIssuance = beginPendingApiKeyIssuance();
      try {
        const result = await claimDonorKey({ message, signature });
        retainIssuedToken(result.token);
        setIssued(result);
        setStatus("issued");
      } finally {
        finishIssuance();
      }
    } catch (error) {
      if (isUserRejection(error)) {
        setStatus("idle");
        setNote("The request was declined in the wallet. Nothing was sent to Pharos.");
        return;
      }
      setFailure(describeClaimFailure(error));
      setStatus("error");
    }
  }, [retainIssuedToken]);

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
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Save it as <code className="font-mono text-foreground">PHAROS_API_KEY</code> and call from a server or
          script; browsers on other sites are blocked. Next:{" "}
          <Link href="/about/api/#endpoint-directory" className="pharos-prose-link">endpoint directory</Link>
          {" · "}
          <a href={PUBLIC_API_ARTIFACTS.postmanCollection} className="pharos-prose-link">Postman collection</a>
          {" · "}
          <Link href="/about/api/#polling-guidance" className="pharos-prose-link">polling guidance</Link>.
        </p>
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
      <Button type="button" size="lg" onClick={() => void handleClaim()} disabled={busy} className="w-full sm:w-auto">
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <KeyRound className="h-4 w-4" aria-hidden="true" />
        )}
        {busy ? busyLabel : "Claim supporter key"}
      </Button>

      {providerMissing ? (
        <div className="space-y-2.5 rounded-md border border-border/60 bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
          <p>{NO_PROVIDER_COPY}</p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <a ref={walletLinkRef} href={METAMASK_CLAIM_URL}>Open in MetaMask</a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={COINBASE_WALLET_CLAIM_URL}>Open in Coinbase Wallet</a>
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => void copyPageLink(CLAIM_PAGE_URL)}>
              {pageLinkCopied ? "Link copied" : "Copy page link"}
            </Button>
          </div>
        </div>
      ) : null}

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

      {note ? (
        <p role="status" className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {note}
        </p>
      ) : null}

      {failure ? (
        <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {failure.text}
        </div>
      ) : null}
    </div>
  );
}
