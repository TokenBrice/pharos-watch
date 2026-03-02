"use client";

import { PageError } from "@/components/page-error";

export default function StablecoinsPegError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load stablecoins" error={error} reset={reset} />;
}
