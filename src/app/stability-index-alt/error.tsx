"use client";

import { PageError } from "@/components/page-error";

export default function StabilityIndexAltError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load stability index" error={error} reset={reset} />;
}
