export const CAUSE_OF_DEATH_VALUES = [
  "algorithmic-failure",
  "counterparty-failure",
  "liquidity-drain",
  "regulatory",
  "abandoned",
] as const;

export type CauseOfDeath = (typeof CAUSE_OF_DEATH_VALUES)[number];

export const CAUSE_HEX: Record<CauseOfDeath, string> = {
  "algorithmic-failure": "#ef4444",
  "counterparty-failure": "#f59e0b",
  "liquidity-drain": "#f97316",
  regulatory: "#3b82f6",
  abandoned: "#71717a",
};

export const CAUSE_META: Record<CauseOfDeath, { label: string; textColor: string; borderColor: string }> = {
  "algorithmic-failure": { label: "Algorithmic Failure", textColor: "text-red-700 dark:text-red-400", borderColor: "border-red-500/30" },
  "counterparty-failure": { label: "Counterparty Failure", textColor: "text-amber-700 dark:text-amber-400", borderColor: "border-amber-500/30" },
  "liquidity-drain": { label: "Liquidity Drain", textColor: "text-orange-700 dark:text-orange-400", borderColor: "border-orange-500/30" },
  regulatory: { label: "Regulatory", textColor: "text-blue-700 dark:text-blue-400", borderColor: "border-blue-500/30" },
  abandoned: { label: "Abandoned", textColor: "text-zinc-700 dark:text-zinc-400", borderColor: "border-zinc-500/30" },
};

/**
 * Higher-intensity border classes (matching CAUSE_META's `borderColor` but
 * at /70 opacity) for prominent surfaces like the frozen-state banner.
 * Listed literally so Tailwind JIT picks them up.
 */
export const CAUSE_BORDER_INTENSE: Record<CauseOfDeath, string> = {
  "algorithmic-failure": "border-red-500/70",
  "counterparty-failure": "border-amber-500/70",
  "liquidity-drain": "border-orange-500/70",
  regulatory: "border-blue-500/70",
  abandoned: "border-zinc-500/70",
};
