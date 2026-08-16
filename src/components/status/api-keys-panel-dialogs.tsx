"use client";

import { useState } from "react";
import type { ApiKeySummary } from "@shared/types";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";
// The Sort control keeps the bare class: its `<select>` shares a flex row with
// the direction toggle rather than filling the label, so it is not a
// `FilterSelect`.

export function TokenRevealDialog({
  revealedToken,
  onClose,
}: {
  revealedToken: {
    label: string;
    token: string;
    idempotencyKey: string;
    idempotentReplay: boolean | null;
    executionCertainty: string | null;
  };
  onClose: () => void;
}) {
  const [acknowledgement, setAcknowledgement] = useState<"copied" | "dismissed" | null>(null);
  const canClose = acknowledgement != null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && canClose) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (!canClose) event.preventDefault();
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{revealedToken.label} one-time token</DialogTitle>
          <DialogDescription>
            This plaintext token will be removed from the page when you close this dialog and cannot be recovered.
          </DialogDescription>
        </DialogHeader>

        <div
          role="status"
          aria-live="assertive"
          className={cn("rounded-md border p-3 text-sm text-amber-900 dark:text-amber-100", SEVERITY_TONE_CLASS.watch.banner)}
        >
          {revealedToken.label}. The token is ready. Copy it to the approved credential store now.
        </div>

        <div className="flex items-start gap-2">
          <pre
            aria-label={`${revealedToken.label} plaintext token`}
            className="min-w-0 flex-1 overflow-auto rounded bg-muted p-3 text-xs"
          >
            {revealedToken.token}
          </pre>
          <CopyButton
            text={revealedToken.token}
            className="size-11 border border-amber-500/30 bg-background text-foreground hover:bg-muted hover:text-foreground"
          />
        </div>

        <div className="font-mono text-[11px] text-muted-foreground">
          replay {revealedToken.idempotentReplay ? "yes" : "no"} · certainty{" "}
          {revealedToken.executionCertainty ?? "confirmed"} · intent {revealedToken.idempotencyKey}
        </div>

        <fieldset className="space-y-2 rounded-md border border-border/60 p-3">
          <legend className="px-1 text-xs font-medium text-foreground">Before closing</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="token-acknowledgement"
              checked={acknowledgement === "copied"}
              onChange={() => setAcknowledgement("copied")}
            />
            I copied this token to the approved credential store.
          </label>
          <label className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-100">
            <input
              type="radio"
              name="token-acknowledgement"
              checked={acknowledgement === "dismissed"}
              onChange={() => setAcknowledgement("dismissed")}
            />
            I am intentionally dismissing this token without saving it and understand it will be lost.
          </label>
        </fieldset>

        <DialogFooter>
          <Button type="button" className="min-h-11" onClick={onClose} disabled={!canClose}>
            {acknowledgement === "dismissed" ? "Dismiss token" : "Finish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TokenUnavailableReplayDialog({
  label,
  apiKey,
  recovery,
  idempotencyKey,
  idempotentReplay,
  executionCertainty,
  onRotate,
  onClose,
}: {
  label: string;
  apiKey: ApiKeySummary;
  recovery: string;
  idempotencyKey: string;
  idempotentReplay: boolean | null;
  executionCertainty: string | null;
  onRotate: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{label} confirmed; token unavailable</DialogTitle>
          <DialogDescription>
            The worker replay confirmed the credential mutation without persisting or returning its one-time secret.
          </DialogDescription>
        </DialogHeader>
        <div
          role="alert"
          className={cn("rounded-md border p-3 text-sm text-amber-900 dark:text-amber-100", SEVERITY_TONE_CLASS.watch.banner)}
        >
          <p className="font-medium">
            {apiKey.name} · ID {apiKey.id} · <span className="font-mono">{apiKey.maskedToken}</span>
          </p>
          <p className="mt-2">{recovery}</p>
          <p className="mt-2 font-mono text-[11px]">
            replay {idempotentReplay ? "yes" : "no"} · certainty {executionCertainty ?? "confirmed"} · intent{" "}
            {idempotencyKey}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" className="min-h-11" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button type="button" className="min-h-11" variant="destructive" onClick={onRotate}>
            Rotate {apiKey.name} (ID {apiKey.id}) now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
