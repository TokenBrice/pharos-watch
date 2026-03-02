"use client";

import { PageError } from "@/components/page-error";

export default function PortfolioError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load portfolio" error={error} reset={reset} />;
}
