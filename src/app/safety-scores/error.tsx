"use client";

import { PageError } from "@/components/page-error";

export default function SafetyScoresError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load safety scores" error={error} reset={reset} />;
}
