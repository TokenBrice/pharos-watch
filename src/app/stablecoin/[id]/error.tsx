"use client";

import { PageError } from "@/components/page-error";

export default function StablecoinError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load stablecoin" error={error} reset={reset} />;
}
