"use client";

import { PageError } from "@/components/page-error";

export default function FlowsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load flow data" error={error} reset={reset} />;
}
