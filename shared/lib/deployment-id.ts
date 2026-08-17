import { canonicalExitRouteScopedKey } from "./exit-route-identity";

const DEPLOYMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*:\S+$/;

/** Normalize the shared `chain:contractAddress` identity used by deployment-scoped reviews. */
export function normalizeDeploymentId(value: string): string {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) return "";

  return canonicalExitRouteScopedKey(trimmed.slice(0, separatorIndex), trimmed.slice(separatorIndex + 1));
}

/** Whether a deployment ID is both structurally valid and already normalized. */
export function isWellFormedDeploymentId(value: string): boolean {
  return DEPLOYMENT_ID_PATTERN.test(value) && normalizeDeploymentId(value) === value;
}
