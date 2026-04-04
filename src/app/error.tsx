"use client";

import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const message =
    process.env.NODE_ENV === "development"
      ? (error.message || "An unexpected error occurred.")
      : "Something went wrong while loading this page.";

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6">
      <div className="text-center space-y-2">
        <h1 className="text-4xl font-bold font-mono tracking-tight">Something went wrong</h1>
        <p className="text-muted-foreground text-sm max-w-md">
          {message}
        </p>
      </div>
      <div className="flex gap-4">
        <button
          onClick={reset}
          className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
