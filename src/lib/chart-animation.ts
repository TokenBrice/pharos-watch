export const CHART_DRAW_IN = {
  isAnimationActive: true,
  animationDuration: 800,
  animationEasing: "ease-out" as const,
} as const;

export const CHART_NO_ANIM = { isAnimationActive: false } as const;
