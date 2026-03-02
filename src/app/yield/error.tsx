"use client";

import { PageError } from "@/components/page-error";

export default function YieldError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load yield data" error={error} reset={reset} />;
}
