"use client";

import { PageError } from "@/components/page-error";

export default function MethodologyError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load methodology page" error={error} reset={reset} />;
}
