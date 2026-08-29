export type CommandPaletteStablecoinSearchItem = readonly [
  id: string,
  name: string,
  symbol: string,
  status?: "pre-launch" | "quarantined" | "delisted" | "frozen",
  frozenAt?: string,
];

// Stable import path for the independently chunked, build-generated search projection.
export { COMMAND_PALETTE_STABLECOINS } from "@/generated/command-palette-search-data";
