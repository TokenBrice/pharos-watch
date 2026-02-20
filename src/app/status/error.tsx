"use client";

import { PageError } from "@/components/page-error";

export default function StatusError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load status data" error={error} reset={reset} />;
}
