type RedemptionRouteId = `redemption:${string}:${string}`;

export function redemptionRouteId(stablecoinId: string, routeFamily: string | undefined): RedemptionRouteId {
  return `redemption:${stablecoinId}:${routeFamily}`;
}
