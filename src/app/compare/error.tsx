"use client";

import { PageError } from "@/components/page-error";

export default function CompareError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load comparison data" error={error} reset={reset} />;
}
