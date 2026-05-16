"use client";

import { useQueryClient } from "@tanstack/react-query";

interface TrustStripFreshnessProps {
  queryKey: readonly unknown[];
}

function relativeTime(updatedAt: number): string {
  const diffMs = Date.now() - updatedAt;
  if (diffMs < 60_000) return "just now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return `${Math.floor(diffHr / 24)} d ago`;
}

export function TrustStripFreshness({ queryKey }: TrustStripFreshnessProps) {
  const queryClient = useQueryClient();
  const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt;
  if (!updatedAt) return null;
  return (
    <span aria-live="polite" className="text-xs text-muted-foreground">
      Data refresh · {relativeTime(updatedAt)}
    </span>
  );
}
