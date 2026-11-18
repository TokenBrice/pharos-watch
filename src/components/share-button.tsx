"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Check, Download, ImageIcon, Link, Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { copyText } from "@/lib/clipboard";
import { triggerBlobDownload } from "@/lib/exports/download";
import { RequestFailure, RequestSequence, isRequestCancellation, requestBlob, requestResponse } from "@/lib/request";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { dossierOgFallbackPath } from "@shared/lib/social-preview-asset";
import { SocialScorecardCreatedSchema, type SocialScorecardCreated } from "@shared/types/social-scorecard";
import { trackEvent } from "@/lib/analytics";
import { getSiteSessionGate, SITE_SESSION_CHECK_ENABLED } from "@/lib/site-session-gate";
import { SITE_SESSION_HINT_HEADER } from "@shared/lib/site-session-constants";

type Status = "idle" | "loading" | "copied" | "error";

interface ShareButtonProps {
  label?: string;
  compactAtDesktop?: boolean;
  stablecoinId?: string;
  /** False when the subject has no published grade to date, such as a not-rated coin. */
  datedScorecard?: boolean;
}

async function fetchOgBlob(signal: AbortSignal, stablecoinId?: string): Promise<Blob> {
  const image = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
  if (!image) throw new Error("Page preview is unavailable");
  const preview = new URL(image, SITE_ORIGIN);
  const fallback = stablecoinId && dossierOgFallbackPath(preview, stablecoinId);
  if (fallback) return requestBlob(fallback, { signal, timeoutMs: 15_000 });
  if (preview.origin !== SITE_ORIGIN || !preview.pathname.startsWith("/og/v2/")
    || !preview.pathname.endsWith(".png") || preview.search || preview.hash) {
    throw new Error("Page preview identity is invalid");
  }
  return requestBlob(preview.pathname, { signal, timeoutMs: 15_000 });
}

async function createDatedScorecard(stablecoinId: string, signal: AbortSignal): Promise<SocialScorecardCreated> {
  // Defer the session client's registration side effect until its rollout is
  // enabled, matching apiRequest's existing lazy session-gate boundary.
  const session = process.env.NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK === "true"
    && SITE_SESSION_CHECK_ENABLED && process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim()
    ? getSiteSessionGate() ?? await import("@/lib/site-session-client")
    : null;
  if (session && !session.hasValidSiteSession()) await session.waitForSiteSession(signal);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const result = await requestResponse("/_site-data/scorecard", {
      signal, timeoutMs: 20_000, allowHttpError: true,
      init: {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stablecoinId }),
      },
    }, async (response) => {
      if (response.status === 401 && response.headers.get(SITE_SESSION_HINT_HEADER) === "required") {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) throw new RequestFailure("http", "/_site-data/scorecard", "Scorecard creation failed", { status: response.status });
      return SocialScorecardCreatedSchema.parse(await response.json());
    });
    if (result.data) return result.data;
    session?.invalidateSiteSession();
    if (!session || attempt !== 0) break;
    await session.waitForSiteSession(signal);
  }
  throw new RequestFailure("http", "/_site-data/scorecard", "Site session required", { status: 401 });
}

export function ShareButton({ stablecoinId, label = "Share", compactAtDesktop = false, datedScorecard = true }: ShareButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [datedShare, setDatedShare] = useState<SocialScorecardCreated | null>(null);
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const surface = stablecoinId === "safety-scores" ? "safety-scores" : stablecoinId ? "stablecoin" : "route";
  const [canCopyImage] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof ClipboardItem !== "undefined" &&
      typeof navigator?.clipboard?.write === "function",
  );

  const resetTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const requestSequence = useRef(new RequestSequence());

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
      requestSequence.current.cancel();
    },
    [],
  );

  const resetStatus = useCallback(() => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus("idle"), 2000);
  }, []);

  const copyLink = useCallback(async () => {
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
    const canonicalUrl = new URL(canonical || window.location.pathname, SITE_ORIGIN);
    canonicalUrl.search = "";
    canonicalUrl.hash = "";
    const url = canonicalUrl.toString();
    try {
      const result = await requestSequence.current.run(() => copyText(url));
      setManualCopyUrl(result.ok ? null : url);
      setErrorMessage(result.ok ? null : "Clipboard access is blocked. Copy the link manually.");
      setStatus(result.ok ? "copied" : "error");
      trackEvent("social_share", { action: "copy_link", outcome: result.ok ? "success" : "error", surface });
      resetStatus();
    } catch (error) {
      if (isRequestCancellation(error)) return;
      setStatus("error");
      setErrorMessage("Could not copy the link.");
      trackEvent("social_share", { action: "copy_link", outcome: "error", surface });
      resetStatus();
    }
  }, [resetStatus, surface]);

  const shareDatedScorecard = useCallback(async () => {
    if (!stablecoinId) return;
    clearTimeout(resetTimer.current ?? undefined);
    setStatus("loading");
    setErrorMessage(null);
    setManualCopyUrl(null);
    setDatedShare(null);
    try {
      await requestSequence.current.run(async (signal) => {
        const snapshot = await createDatedScorecard(stablecoinId, signal);
        signal.throwIfAborted();
        const url = new URL(snapshot.url);
        const imageUrl = new URL(snapshot.imageUrl);
        if (url.origin !== SITE_ORIGIN || imageUrl.origin !== SITE_ORIGIN
          || !/^\/share\/scorecard\/[a-f0-9]{64}\/$/.test(url.pathname)
          || imageUrl.pathname !== `${url.pathname.slice(0, -1)}.png`
          || url.search || url.hash || imageUrl.search || imageUrl.hash
          || url.username || url.password || imageUrl.username || imageUrl.password) {
          throw new Error("Invalid retained scorecard response");
        }
        const result = await copyText(snapshot.url);
        signal.throwIfAborted();
        setDatedShare(snapshot);
        setManualCopyUrl(result.ok ? null : snapshot.url);
        setErrorMessage(result.ok ? null : "Scorecard created. Clipboard access is blocked; copy the link manually.");
        setStatus(result.ok ? "copied" : "error");
        trackEvent("social_share", { action: "dated_scorecard", outcome: result.ok ? "success" : "error", surface });
      });
    } catch (error) {
      if (isRequestCancellation(error)) return;
      setStatus("error");
      setErrorMessage("Could not create a dated scorecard. Published data may be unavailable; try again later.");
      trackEvent("social_share", { action: "dated_scorecard", outcome: "error", surface });
    }
    resetStatus();
  }, [stablecoinId, resetStatus, surface]);

  const cancelRequest = useCallback(() => {
    requestSequence.current.cancel();
    setStatus("idle");
  }, []);

  const copyImage = useCallback(async () => {
    clearTimeout(resetTimer.current ?? undefined);
    setStatus("loading");
    setErrorMessage(null);
    try {
      await requestSequence.current.run(async (signal) => {
        // WebKit requires the clipboard write to start in the selection gesture;
        // the ClipboardItem resolves the abortable image fetch afterward.
        const blob = fetchOgBlob(signal, stablecoinId);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      });
      setStatus("copied");
      trackEvent("social_share", { action: "copy_image", outcome: "success", surface });
    } catch (err) {
      if (isRequestCancellation(err)) return;
      console.warn("[share] image copy failed:", err instanceof Error ? err.message : String(err));
      setStatus("error");
      setErrorMessage("Could not copy the image. Try downloading the PNG.");
      trackEvent("social_share", { action: "copy_image", outcome: "error", surface });
    }
    resetStatus();
  }, [resetStatus, stablecoinId, surface]);

  const downloadPng = useCallback(async () => {
    clearTimeout(resetTimer.current ?? undefined);
    setStatus("loading");
    setErrorMessage(null);
    try {
      const blob = await requestSequence.current.run((signal) => fetchOgBlob(signal, stablecoinId));
      triggerBlobDownload(blob, `pharos-${stablecoinId ?? "preview"}.png`);
      setStatus("idle");
      trackEvent("social_share", { action: "download_png", outcome: "success", surface });
    } catch (err) {
      if (isRequestCancellation(err)) return;
      console.warn("[share] download failed:", err instanceof Error ? err.message : String(err));
      setStatus("error");
      setErrorMessage("Could not download the PNG. Try again later.");
      trackEvent("social_share", { action: "download_png", outcome: "error", surface });
      resetStatus();
    }
  }, [stablecoinId, resetStatus, surface]);

  const triggerIcon =
    status === "loading" ? <Loader2 className="animate-spin" /> : status === "copied" ? <Check /> : <Share2 />;

  const triggerLabel = status === "copied" ? "Copied!" : status === "error" ? "Failed" : label;

  return (
    <div className="relative inline-flex flex-col items-end gap-2">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={status === "loading"}
          aria-busy={status === "loading"}
          aria-label={triggerLabel}
          className={cn(
            "min-h-11 rounded-full px-4 lg:min-h-9 lg:rounded-md",
            compactAtDesktop && "lg:size-8 lg:min-h-0 lg:px-0",
          )}
        >
          {triggerIcon}
          <span className={compactAtDesktop ? "lg:sr-only" : undefined}>{triggerLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={copyLink}>
          <Link />
          Copy link
        </DropdownMenuItem>
        {stablecoinId && datedScorecard && (
          <DropdownMenuItem onSelect={shareDatedScorecard}>
            <Share2 />
            Share dated scorecard
          </DropdownMenuItem>
        )}
        {canCopyImage && (
          <DropdownMenuItem onSelect={copyImage}>
            <ImageIcon />
            Copy as image
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={downloadPng}>
          <Download />
          Download PNG
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
      {status === "loading" && <Button variant="ghost" size="sm" onClick={cancelRequest}>Cancel sharing</Button>}
      {errorMessage && <p role="alert" className="max-w-xs text-xs text-destructive">{errorMessage}</p>}
      {manualCopyUrl && (
        <label className="block max-w-xs text-xs text-muted-foreground">
          Copy this link manually
          <input readOnly aria-label="Share link" value={manualCopyUrl} onFocus={(event) => event.currentTarget.select()} className="pharos-focus-ring mt-1 w-full rounded-md border bg-background px-2 py-1 font-mono text-xs" />
        </label>
      )}
      {datedShare && (
        <div role="status" className="flex gap-3 text-xs">
          <a href={datedShare.url} className="underline">Open dated scorecard</a>
          <a href={datedShare.imageUrl} download className="underline">Download dated PNG</a>
        </div>
      )}
    </div>
  );
}
