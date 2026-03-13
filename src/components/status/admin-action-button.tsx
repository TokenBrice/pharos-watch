"use client";

import { useState } from "react";
import type { StatusPageAction } from "@shared/lib/api-endpoints";
import { buildAdminApiPath, buildAdminFetchInit, type AdminAccess } from "@/lib/admin-access";
import { buildRequestUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface AdminActionExecution {
  action: StatusPageAction;
  ok: boolean;
  output: string;
  executedAt: number;
}

interface AdminActionButtonProps {
  action: StatusPageAction;
  adminAccess: AdminAccess;
  buttonClassName?: string;
  fullWidth?: boolean;
  onFinished?: (execution: AdminActionExecution) => void;
}

export function AdminActionButton({
  action,
  adminAccess,
  buttonClassName,
  fullWidth = true,
  onFinished,
}: AdminActionButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch(buildRequestUrl(buildAdminApiPath(action.path, adminAccess)), {
        method: action.method,
        ...buildAdminFetchInit(),
      });
      const text = await res.text();

      if (!res.ok) {
        const output = `${res.status}: ${text}`;
        setError(output);
        onFinished?.({
          action,
          ok: false,
          output,
          executedAt: Math.floor(Date.now() / 1000),
        });
        return;
      }

      let output = text;
      try {
        output = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Keep plain text output.
      }
      setResult(output);
      onFinished?.({
        action,
        ok: true,
        output,
        executedAt: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      const output = err instanceof Error ? err.message : "Unknown error";
      setError(output);
      onFinished?.({
        action,
        ok: false,
        output,
        executedAt: Math.floor(Date.now() / 1000),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (isOpen) {
          setResult(null);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={action.destructive ? "destructive" : "outline"}
          size="sm"
          className={`${fullWidth ? "w-full" : ""}${buttonClassName ? ` ${buttonClassName}` : ""}`.trim()}
        >
          {action.label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          <DialogDescription>{action.confirm}</DialogDescription>
        </DialogHeader>
        {result && <pre className="max-h-60 overflow-auto rounded bg-muted p-3 text-xs">{result}</pre>}
        {error && (
          <pre className="max-h-60 overflow-auto rounded bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400">
            {error}
          </pre>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            Cancel
          </Button>
          <Button variant={action.destructive ? "destructive" : "default"} onClick={handleConfirm} disabled={loading}>
            {loading ? "Running..." : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
