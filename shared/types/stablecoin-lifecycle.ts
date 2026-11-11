export const COIN_NOTICE_TYPE_VALUES = ["danger", "warning", "info"] as const;

/**
 * `launched` = publicly issued on-chain while Pharos has no admitted price or
 * supply lane yet; allowed only on `status: "pre-launch"` rows. The others are
 * the upcoming phases.
 */
export const LAUNCH_PHASE_VALUES = ["announced", "testnet", "auditing", "beta", "launching-soon", "launched"] as const;
export type LaunchPhase = (typeof LAUNCH_PHASE_VALUES)[number];
export type UpcomingLaunchPhase = Exclude<LaunchPhase, "launched">;
export const UPCOMING_LAUNCH_PHASE_VALUES = LAUNCH_PHASE_VALUES.filter(
  (phase): phase is UpcomingLaunchPhase => phase !== "launched",
);

export const LAUNCH_MILESTONE_TYPE_VALUES = [
  "announcement",
  "milestone",
  "delay",
  "partnership",
  "regulatory",
  "audit",
  "testnet",
] as const;
export type LaunchMilestoneType = (typeof LAUNCH_MILESTONE_TYPE_VALUES)[number];

export const FEATURED_CONTENT_TYPE_VALUES = ["tweet", "blog", "video", "article"] as const;

export const MARKET_AVAILABILITY_VALUES = [
  "market-traded",
  "limited-trading",
  "non-traded-utility",
  "legacy-or-wind-down",
] as const;
