"use client";

import { PageError } from "@/components/page-error";

export default function LiquidityError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <PageError title="Failed to load liquidity data" error={error} reset={reset} />;
}
