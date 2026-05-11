import {
  EXTRA_COLORS,
  PROTOCOL_COLORS,
} from "@/lib/dex-display-constants";

const MAX_PROTOCOL_LEGEND_ITEMS = 10;
const MAX_VISIBLE_PROTOCOLS = MAX_PROTOCOL_LEGEND_ITEMS - 1;

export function buildProtocolBreakdown(protocolTvl: Record<string, number>) {
  const sortedEntries = Object.entries(protocolTvl).sort((a, b) => b[1] - a[1]) as [string, number][];
  const total = sortedEntries.reduce((sum, [, value]) => sum + value, 0);
  const visibleEntries = sortedEntries.slice(0, MAX_VISIBLE_PROTOCOLS);
  const groupedRemainder = sortedEntries.slice(MAX_VISIBLE_PROTOCOLS).reduce((sum, [, value]) => sum + value, 0);
  const entries = visibleEntries.map(([key, value], index) => ({
    key,
    value,
    colorClass: PROTOCOL_COLORS[key] ?? EXTRA_COLORS[index % EXTRA_COLORS.length],
  }));

  if (groupedRemainder > 0) {
    entries.push({
      key: "_other",
      value: groupedRemainder,
      colorClass: "bg-muted-foreground",
    });
  }

  const displayEntries = entries.map((entry) => [entry.key, entry.value] as [string, number]);
  const colorMap = Object.fromEntries(entries.map((entry) => [entry.key, entry.colorClass]));

  return { displayEntries, colorMap, total };
}
