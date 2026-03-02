"use client";

import { PageError } from "@/components/page-error";

export default function DepegError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load depeg data" error={error} reset={reset} />;
}
