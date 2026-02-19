"use client";

import { PageError } from "@/components/page-error";

export default function PegTrackerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load peg tracker" error={error} reset={reset} />;
}
