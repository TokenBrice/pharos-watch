"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

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
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <p className="max-w-md text-center text-sm text-muted-foreground">
        Restricted route for Pharos operators. Enter an admin key to access cron telemetry, endpoint probes, and
        recovery controls.
      </p>
      <Link
        href="/"
        className="text-sm text-foreground underline underline-offset-4 transition-colors hover:text-sky-500"
      >
        Return to dashboard
      </Link>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Pharos System Status</CardTitle>
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
    </div>
  );
}
