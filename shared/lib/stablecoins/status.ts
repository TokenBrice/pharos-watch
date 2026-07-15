import type { StablecoinMeta } from "../../types";

export function isActiveStablecoinMeta(meta: Pick<StablecoinMeta, "status">): boolean {
  return meta.status == null || meta.status === "active";
}

export function isPreLaunchStablecoinMeta(meta: Pick<StablecoinMeta, "status">): boolean {
  return meta.status === "pre-launch";
}

export function isFrozenStablecoinMeta(meta: Pick<StablecoinMeta, "status">): boolean {
  return meta.status === "frozen";
}

export function isQuarantinedStablecoinMeta(meta: Pick<StablecoinMeta, "status">): boolean {
  return meta.status === "quarantined";
}

export function isDelistedStablecoinMeta(meta: Pick<StablecoinMeta, "status">): boolean {
  return meta.status === "delisted";
}

export function isReadableStablecoinMeta(meta: Pick<StablecoinMeta, "status">): boolean {
  return !isPreLaunchStablecoinMeta(meta);
}
