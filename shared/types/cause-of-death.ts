export const CAUSE_OF_DEATH_VALUES = [
  "algorithmic-failure",
  "counterparty-failure",
  "liquidity-drain",
  "regulatory",
  "abandoned",
] as const;

export type CauseOfDeath = (typeof CAUSE_OF_DEATH_VALUES)[number];
