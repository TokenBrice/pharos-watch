"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildApiUrl } from "@/lib/api";

type FeedbackType = "bug" | "data-correction" | "feature-request";
type ContactChannel = "telegram" | "x";

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
  "data-correction":
    "e.g. USDC shows $0.00 price since yesterday. CoinGecko shows $1.0001.",
  "feature-request": "Describe the feature and why it would be useful.",
};

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
  const [contactConsent, setContactConsent] = useState(false);
  const [contactChannel, setContactChannel] = useState<ContactChannel>("telegram");
  const [contactHandle, setContactHandle] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [submissionId, setSubmissionId] = useState("");

  const reset = useCallback(() => {
    setType(defaultType);
    setTitle("");
    setDescription("");
    setExpectedValue("");
    setContactConsent(false);
    setContactChannel("telegram");
    setContactHandle("");
    setStatus("idle");
    setErrorMsg("");
    setSubmissionId("");
  }, [defaultType]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset]
  );

  const handleSubmit = useCallback(async () => {
    setStatus("loading");
    setErrorMsg("");

    const pageUrl =
      typeof window !== "undefined"
        ? `${window.location.pathname}${window.location.search}${window.location.hash}`
        : "/";

    const body = {
      type,
      ...(title.trim() ? { title: title.trim() } : {}),
      description: description.trim(),
      ...(expectedValue.trim() ? { expectedValue: expectedValue.trim() } : {}),
      ...(stablecoinId ? { stablecoinId } : {}),
      ...(stablecoinName ? { stablecoinName } : {}),
      ...(pegValue ? { pegValue } : {}),
      ...(contactConsent
        ? {
            contactConsent: true,
            contactChannel,
            contactHandle: contactHandle.trim(),
          }
        : {}),
      pageUrl,
      website: "",
    };

    try {
      const res = await fetch(buildApiUrl("/api/feedback"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; submissionId?: string };
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error ?? "Something went wrong. Please try again.");
        setStatus("error");
      } else {
        setSubmissionId(data.submissionId ?? "");
        setStatus("success");
      }
    } catch {
      setErrorMsg("Network error. Please try again.");
      setStatus("error");
    }
  }, [
    type,
    title,
    description,
    expectedValue,
    stablecoinId,
    stablecoinName,
    pegValue,
    contactConsent,
    contactChannel,
    contactHandle,
  ]);

  const needsTitle = type === "bug" || type === "feature-request";
  const hasValidContact =
    !contactConsent || contactHandle.trim().length >= 2;
  const isValid =
    description.trim().length >= 10 &&
    description.trim().length <= 2000 &&
    (!needsTitle || (title.trim().length >= 3 && title.trim().length <= 100)) &&
    hasValidContact;

  const pageUrl =
    typeof window !== "undefined"
      ? `${window.location.pathname}${window.location.search}${window.location.hash}`
      : "";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
        </DialogHeader>

        {status === "success" ? (
          <div className="py-8 text-center space-y-2">
            <p className="text-lg font-medium">Thanks — submitted!</p>
            <p className="text-sm text-muted-foreground">
              We review all submissions and prioritize data corrections.
            </p>
            {submissionId ? (
              <p className="text-xs text-muted-foreground">
                Reference ID: <span className="font-mono text-foreground">{submissionId}</span>
              </p>
            ) : null}
            <Button variant="outline" className="mt-4" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Type selector */}
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {(["bug", "data-correction", "feature-request"] as FeedbackType[]).map((t) => (
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
            {(stablecoinName || pageUrl) && (
              <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
                {stablecoinName && <div><span className="font-medium">Stablecoin:</span> {stablecoinName}</div>}
                {pegValue && <div><span className="font-medium">Current value:</span> {pegValue}</div>}
                {pageUrl && <div><span className="font-medium">Page:</span> {pageUrl}</div>}
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
              <Label htmlFor="fb-desc">
                {type === "data-correction" ? "What is wrong?" : "Description"}
              </Label>
              <Textarea
                id="fb-desc"
                placeholder={DESCRIPTION_HINTS[type]}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={2000}
                disabled={status === "loading"}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground text-right">
                {description.length}/2000
              </p>
            </div>

            {/* Expected value (data-correction only) */}
            {type === "data-correction" && (
              <div className="space-y-1.5">
                <Label htmlFor="fb-expected">
                  Expected value / source{" "}
                  <span className="text-muted-foreground">(optional)</span>
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

            <div className="space-y-2 rounded-md border border-border/60 bg-card/40 px-3 py-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={contactConsent}
                  onChange={(e) => setContactConsent(e.target.checked)}
                  disabled={status === "loading"}
                  className="mt-0.5 h-4 w-4 rounded border-border bg-background"
                />
                <span>
                  Share a private follow-up contact
                  <span className="block text-xs text-muted-foreground">
                    Optional. Stored privately by Pharos and not posted publicly to GitHub.
                  </span>
                </span>
              </label>

              {contactConsent ? (
                <div className="space-y-3">
                  <div className="flex gap-1 rounded-lg bg-muted p-1">
                    {(["telegram", "x"] as ContactChannel[]).map((channel) => (
                      <button
                        key={channel}
                        type="button"
                        aria-pressed={contactChannel === channel}
                        onClick={() => setContactChannel(channel)}
                        className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                          contactChannel === channel
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {channel === "telegram" ? "Telegram" : "X"}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="fb-contact">
                      {contactChannel === "telegram" ? "Telegram handle" : "X handle"}
                    </Label>
                    <Input
                      id="fb-contact"
                      placeholder={contactChannel === "telegram" ? "@username" : "@handle"}
                      value={contactHandle}
                      onChange={(e) => setContactHandle(e.target.value)}
                      maxLength={100}
                      disabled={status === "loading"}
                    />
                    <p className="text-xs text-muted-foreground">
                      We only use this for follow-up on your submission.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Honeypot */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              aria-hidden="true"
              style={{ position: "absolute", left: "-9999px", opacity: 0, pointerEvents: "none" }}
              readOnly
              value=""
            />

            {/* Error */}
            {status === "error" && errorMsg && (
              <p className="text-sm text-destructive">{errorMsg}</p>
            )}

            {/* Submit */}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={status === "loading"}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!isValid || status === "loading"}
              >
                {status === "loading" ? "Submitting…" : "Submit"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
