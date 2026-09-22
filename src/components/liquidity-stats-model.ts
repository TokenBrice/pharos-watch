import { buildBreakdownEntries } from "@/components/liquidity-breakdown";
import { EXTRA_COLORS, PROTOCOL_COLORS } from "@/lib/dex-display-constants";

const MAX_PROTOCOL_LEGEND_ITEMS = 10;
const MAX_VISIBLE_PROTOCOLS = MAX_PROTOCOL_LEGEND_ITEMS - 1;

export function buildProtocolBreakdown(protocolTvl: Record<string, number>) {
  const { entries, total } = buildBreakdownEntries(protocolTvl, {
    labelForKey: (key) => key,
    colorForKey: (key, index) => PROTOCOL_COLORS[key] ?? EXTRA_COLORS[index % EXTRA_COLORS.length],
    maxVisibleItems: MAX_VISIBLE_PROTOCOLS,
  });
  const displayEntries = entries.map((entry) => [entry.key, entry.value] as [string, number]);
  const colorMap = Object.fromEntries(entries.map((entry) => [entry.key, entry.colorClass]));
  return { displayEntries, colorMap, total };
}
