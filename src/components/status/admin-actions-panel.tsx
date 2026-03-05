"use client";

import { useState } from "react";
import { getStatusPageActions, type StatusPageAction } from "@shared/lib/api-endpoints";
import { API_BASE } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const ADMIN_ACTIONS: StatusPageAction[] = getStatusPageActions();

interface AdminActionButtonProps {
  action: StatusPageAction;
  adminKey: string;
}

function AdminActionButton({ action, adminKey }: AdminActionButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${action.path}`, {
        method: action.method,
        headers: { "X-Admin-Key": adminKey },
      });
      const text = await res.text();
      if (!res.ok) {
        setError(`${res.status}: ${text}`);
      } else {
        try {
          const json = JSON.parse(text);
          setResult(JSON.stringify(json, null, 2));
        } catch {
          setResult(text);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
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
        <Button variant={action.destructive ? "destructive" : "outline"} size="sm" className="w-full">
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

interface AdminActionsPanelProps {
  adminKey: string;
}

export function AdminActionsPanel({ adminKey }: AdminActionsPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Admin Actions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {ADMIN_ACTIONS.map((action) => (
            <AdminActionButton key={action.path} action={action} adminKey={adminKey} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
