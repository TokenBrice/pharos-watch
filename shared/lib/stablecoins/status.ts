import type { StablecoinMeta } from "../../types";

export function isActiveStablecoinMeta(meta: Pick<StablecoinMeta, "status">): boolean {
  return meta.status !== "pre-launch" && meta.status !== "frozen";
}

export function isPreLaunchStablecoinMeta(meta: Pick<StablecoinMeta, "status">): boolean {
  return meta.status === "pre-launch";
}

export function isFrozenStablecoinMeta(meta: Pick<StablecoinMeta, "status">): boolean {
  return meta.status === "frozen";
}

export function isReadableStablecoinMeta(meta: Pick<StablecoinMeta, "status">): boolean {
  return !isPreLaunchStablecoinMeta(meta);
}
