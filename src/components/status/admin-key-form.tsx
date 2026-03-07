"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyStateSurface } from "@/components/empty-state-surface";

interface AdminKeyFormProps {
  onSubmit: (key: string) => void;
}

export function AdminKeyForm({ onSubmit }: AdminKeyFormProps) {
  const [value, setValue] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <div className="pt-2 sm:pt-4">
      <EmptyStateSurface
        eyebrow="Operator Access"
        title="Public status route, private control plane."
        description="This page exposes the existence of the status surface, but the telemetry, cron controls, and incident tooling stay behind an admin key."
        steps={[
          {
            title: "Monitor pipeline health",
            description:
              "Cron freshness, cache state, circuit breakers, and endpoint probes stay inside the gated view.",
          },
          {
            title: "Respond to incidents",
            description: "Operational actions and recovery controls remain restricted to Pharos operators.",
          },
          {
            title: "Leave without guessing",
            description: "If you do not have a key, use the return path below instead of poking at a dead end.",
          },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/"
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-border/60 bg-background/60 px-4 py-2 text-sm font-medium text-foreground hover:border-primary/45 hover:bg-primary/8"
            >
              Return to dashboard
            </Link>
          </div>
        }
        footnote={
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary/85" />
            <span>
              Need a current operator key or a fallback path during an outage? Reach out via{" "}
              <a
                href="https://x.com/PharosWatch"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4 transition-colors hover:text-sky-400"
              >
                @PharosWatch
              </a>
              .
            </span>
          </div>
        }
        preview={
          <Card className="border-border/70 bg-card/88 shadow-[0_16px_36px_oklch(0_0_0_/0.16)]">
            <CardHeader className="space-y-1">
              <p className="pharos-kicker">Secure Sign-In</p>
              <CardTitle>Pharos System Status</CardTitle>
              <p className="text-sm text-muted-foreground">
                Enter an admin key to continue into the operator dashboard.
              </p>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <Input
                  type="password"
                  aria-label="Admin key"
                  placeholder="Admin key"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoFocus
                />
                <Button type="submit" className="w-full" disabled={!value.trim()}>
                  Sign in
                </Button>
              </form>
            </CardContent>
          </Card>
        }
      />
    </div>
  );
}
