import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { hasStaticYieldWorkbench } from "@shared/lib/yield-auto-lending";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { YIELD_SOURCE_FACT_LABELS } from "@/lib/yield-presentation";

/** Source selection applies only to an exported workbench, never its leaderboard fallback. */
export function getYieldWorkbenchLink(id: string, sourceKey?: string | null) {
  const coin = CLIENT_TRACKED_META_BY_ID.get(id);
  const isWorkbench = coin != null && hasStaticYieldWorkbench(coin);
  const search = sourceKey ? `?${new URLSearchParams({ sources: sourceKey })}` : "";
  return {
    isWorkbench,
    href: isWorkbench
      ? buildStablecoinUrl(id, `yield/${search}`)
      : `/yield/?workbenchFallback=${encodeURIComponent(id)}`,
    label: isWorkbench ? "View full yield analysis" : YIELD_SOURCE_FACT_LABELS.fallbackLink,
  };
}
