"use client";

import { PageError } from "@/components/page-error";

export default function DependencyMapError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load dependency map" error={error} reset={reset} />;
}
