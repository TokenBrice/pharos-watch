"use client";

import { PageError } from "@/components/page-error";

export default function MintError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load mint/burn data" error={error} reset={reset} />;
}
