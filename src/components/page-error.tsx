"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export function PageError({
  title,
  error,
  reset,
}: {
  title: string;
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const message =
    process.env.NODE_ENV === "development"
      ? (error.message || "An unexpected error occurred.")
      : "Something went wrong while loading this page.";

  return (
    <div className="space-y-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Dashboard
      </Link>
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4">
        <h2 className="text-2xl font-bold font-mono">{title}</h2>
        <p className="text-muted-foreground text-sm">{message}</p>
        <button
          onClick={reset}
          className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
