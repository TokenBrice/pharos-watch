"use client";

import { PageError } from "@/components/page-error";

export default function CemeteryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load cemetery" error={error} reset={reset} />;
}
