"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { isHardReloadableRouteError } from "@/lib/route-error-recovery";

export function usePageErrorRetry({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const shouldHardReload = isHardReloadableRouteError(error);

  const handleRetry = () => {
    if (shouldHardReload && typeof window !== "undefined") {
      window.location.reload();
      return;
    }
    reset();
  };

  return {
    handleRetry,
    shouldHardReload,
    retryLabel: shouldHardReload ? "Reload page" : "Try again",
  };
}

export function PageErrorBackLink() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft className="h-4 w-4" />
      Dashboard
    </Link>
  );
}
