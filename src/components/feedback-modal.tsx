"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildApiUrl } from "@/lib/api";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import { RequestFailure, RequestSequence, isRequestCancellation, requestJson } from "@/lib/request";
import {
  FEEDBACK_TYPES,
  FeedbackResponseSchema,
  type FeedbackResponse,
  type FeedbackType,
} from "@shared/types/feedback";

interface FeedbackModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultType?: FeedbackType;
  stablecoinId?: string;
  stablecoinName?: string;
  pegValue?: string;
}

const TYPE_LABELS: Record<FeedbackType, string> = {
  bug: "Bug Report",
  "data-correction": "Data Correction",
  "feature-request": "Feature Request",
};

const DESCRIPTION_HINTS: Record<FeedbackType, string> = {
  bug: "Describe what happened and what you expected instead.",
  "data-correction": "e.g. USDC shows $0.00 price since yesterday. CoinGecko shows $1.0001.",
  "feature-request": "Describe the feature and why it would be useful.",
};

function feedbackRequestErrorMessage(error: unknown): string {
  if (error instanceof RequestFailure && error.kind === "http" && error.bodyText) {
    try {
      const parsed = JSON.parse(error.bodyText) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
    } catch {
      // Fall through to the stable endpoint-neutral message.
    }
  }
  if (error instanceof RequestFailure && error.kind === "timeout") return "Request timed out. Please try again.";
  return "Network error. Please try again.";
}

function getCurrentPageUrl() {
  return typeof window === "undefined"
    ? "/"
    : `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function createFeedbackIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `feedback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function FeedbackModal({
  open,
  onOpenChange,
  defaultType = "bug",
  stablecoinId,
  stablecoinName,
  pegValue,
}: FeedbackModalProps) {
  const [type, setType] = useState<FeedbackType>(defaultType);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [expectedValue, setExpectedValue] = useState("");
  const [contactHandle, setContactHandle] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [pageUrl, setPageUrl] = useState(getCurrentPageUrl);
  const requestSequence = useRef(new RequestSequence());
  const submissionIdentity = useRef<{ payload: string; key: string } | null>(null);

  useEffect(() => () => requestSequence.current.cancel(), []);

  const reset = useCallback(() => {
    setType(defaultType);
    setTitle("");
    setDescription("");
    setExpectedValue("");
    setContactHandle("");
    setWebsite("");
    setStatus("idle");
    setErrorMsg("");
    submissionIdentity.current = null;
  }, [defaultType]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        requestSequence.current.cancel();
        reset();
      }
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handleSubmit = useCallback(async () => {
    setStatus("loading");
    setErrorMsg("");

    const currentPageUrl = getCurrentPageUrl();
    setPageUrl(currentPageUrl);

    const body = {
      type,
      ...(title.trim() ? { title: title.trim() } : {}),
      description: description.trim(),
      ...(expectedValue.trim() ? { expectedValue: expectedValue.trim() } : {}),
      ...(stablecoinId ? { stablecoinId } : {}),
      ...(stablecoinName ? { stablecoinName } : {}),
      ...(pegValue ? { pegValue } : {}),
      ...(contactHandle.trim() ? { contactHandle: contactHandle.trim() } : {}),
      pageUrl: currentPageUrl,
      website,
    };
    const payload = JSON.stringify(body);
    if (submissionIdentity.current?.payload !== payload) {
      submissionIdentity.current = { payload, key: createFeedbackIdempotencyKey() };
    }
    const idempotencyKey = submissionIdentity.current.key;

    try {
      const data = await requestSequence.current.run((signal) =>
        requestJson<FeedbackResponse>(buildApiUrl(API_PATHS.feedback()), {
          signal,
          schema: FeedbackResponseSchema,
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
              "Idempotency-Key": idempotencyKey,
            },
            body: payload,
          },
        }),
      );
      if (!data.ok) {
        setErrorMsg(data.error ?? "Something went wrong. Please try again.");
        setStatus("error");
      } else {
        submissionIdentity.current = null;
        setStatus("success");
      }
    } catch (error) {
      if (isRequestCancellation(error)) return;
      if (error instanceof RequestFailure && error.kind === "http" && error.status === 500) {
        // GitHub explicitly rejected this attempt, so the Worker persisted a
        // terminal no-effect response and released its quota reservation.
        submissionIdentity.current = null;
      }
      setErrorMsg(feedbackRequestErrorMessage(error));
      setStatus("error");
    }
  }, [type, title, description, expectedValue, stablecoinId, stablecoinName, pegValue, contactHandle, website]);

  const displayPageUrl = open ? getCurrentPageUrl() : pageUrl;

  const needsTitle = type === "bug" || type === "feature-request";
  const contactValid =
    contactHandle.trim().length === 0 || (contactHandle.trim().length >= 2 && contactHandle.trim().length <= 100);
  const isValid =
    description.trim().length >= 10 &&
    description.trim().length <= 2000 &&
    (!needsTitle || (title.trim().length >= 3 && title.trim().length <= 100)) &&
    contactValid;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
        </DialogHeader>

        {status === "success" ? (
          <div className="py-8 text-center space-y-2">
            <p className="text-lg font-medium">Thanks — submitted!</p>
            <p className="text-sm text-muted-foreground">We review all submissions and prioritize data corrections.</p>
            <Button variant="outline" className="mt-4" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Type selector */}
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {FEEDBACK_TYPES.map((t) => (
                <button
                  key={t}
                  aria-pressed={type === t}
                  onClick={() => setType(t)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    type === t
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>

            {/* Context banner */}
            {(stablecoinName || displayPageUrl) && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
                {stablecoinName && (
                  <div>
                    <span className="font-medium">Stablecoin:</span> {stablecoinName}
                  </div>
                )}
                {pegValue && (
                  <div>
                    <span className="font-medium">Current value:</span> {pegValue}
                  </div>
                )}
                {displayPageUrl && (
                  <div>
                    <span className="font-medium">Page:</span> {displayPageUrl}
                  </div>
                )}
              </div>
            )}

            {/* Title field (bug + feature-request) */}
            {needsTitle && (
              <div className="space-y-1.5">
                <Label htmlFor="fb-title">Title</Label>
                <Input
                  id="fb-title"
                  placeholder={type === "bug" ? "e.g. Sidebar breaks on mobile" : "e.g. Add EUR peg heatmap"}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={100}
                  disabled={status === "loading"}
                />
              </div>
            )}

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="fb-desc">{type === "data-correction" ? "What is wrong?" : "Description"}</Label>
              <Textarea
                id="fb-desc"
                placeholder={DESCRIPTION_HINTS[type]}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={2000}
                disabled={status === "loading"}
                className="max-w-full resize-none whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                style={{ fieldSizing: "fixed" }}
              />
              <p className="text-xs text-muted-foreground text-right">{description.length}/2000</p>
            </div>

            {/* Expected value (data-correction only) */}
            {type === "data-correction" && (
              <div className="space-y-1.5">
                <Label htmlFor="fb-expected">
                  Expected value / source <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="fb-expected"
                  placeholder="e.g. CoinGecko shows $1.0001"
                  value={expectedValue}
                  onChange={(e) => setExpectedValue(e.target.value)}
                  maxLength={200}
                  disabled={status === "loading"}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="fb-contact">
                Contact handle <span className="text-xs text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="fb-contact"
                placeholder="@PharosWatch"
                value={contactHandle}
                onChange={(e) => setContactHandle(e.target.value)}
                maxLength={100}
                disabled={status === "loading"}
              />
              <p className="text-xs text-muted-foreground">This handle will be included publicly on GitHub issues.</p>
            </div>

            {/* Honeypot */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              aria-hidden="true"
              autoComplete="off"
              style={{ position: "absolute", left: "-9999px", opacity: 0, pointerEvents: "none" }}
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />

            {/* Error */}
            {status === "error" && errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}

            {/* Submit */}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={status === "loading"}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!isValid || status === "loading"}>
                {status === "loading" ? "Submitting…" : "Submit"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
