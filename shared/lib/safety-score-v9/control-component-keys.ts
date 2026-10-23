import { CHAIN_META, normalizeChainId } from "../../types/chain-identity";

/**
 * Economic Control component-key grammar. The scorer builds deployment-level
 * keys here and readers parse them here, so no consumer infers deployment
 * identity from its own prefix test. Control keys and deployment ids both
 * contain colons (Sui coin types contain `::`), so a key is never split on
 * colons: a bridge route is joined to its token-mint twin through the full
 * control key the two components share.
 */
const BRIDGE_ROUTE_PREFIX = "bridge:";
const BRIDGE_MINT_PREFIX = "mint:bridge:";
const DEPLOYMENT_MINT_PREFIX = "mint:deployment:";

/** The bridge-tier component of one bridged deployment. */
export function v9BridgeRouteComponentKey(deploymentKey: string, controlKey: string): string {
  return `${BRIDGE_ROUTE_PREFIX}${deploymentKey}:${controlKey}`;
}

/** The authority that mints a bridged deployment's token: the route's twin, scored on the authority ladder. */
export function v9BridgeMintComponentKey(controlKey: string): string {
  return `${BRIDGE_MINT_PREFIX}${controlKey}`;
}

/** A deployment-local native authority that is not the asset's worst mint path. */
export function v9DeploymentMintComponentKey(controlKeys: readonly string[]): string {
  return `${DEPLOYMENT_MINT_PREFIX}${controlKeys.join("+")}`;
}

/** The control key of a bridged-token mint component, or null for any other key. */
export function v9BridgeMintControlKey(componentKey: string): string | null {
  return componentKey.startsWith(BRIDGE_MINT_PREFIX) ? componentKey.slice(BRIDGE_MINT_PREFIX.length) : null;
}

/** True when `componentKey` is the bridge route built from this control key. */
export function isV9BridgeRouteComponentFor(componentKey: string, controlKey: string): boolean {
  return componentKey.startsWith(BRIDGE_ROUTE_PREFIX) &&
    componentKey.length > BRIDGE_ROUTE_PREFIX.length + controlKey.length + 1 &&
    componentKey.endsWith(`:${controlKey}`);
}

/** The deployment a bridge route covers, read through the control key it was built from. */
export function v9BridgeRouteDeploymentKey(componentKey: string, controlKey: string): string | null {
  return isV9BridgeRouteComponentFor(componentKey, controlKey)
    ? componentKey.slice(BRIDGE_ROUTE_PREFIX.length, -(controlKey.length + 1))
    : null;
}

/**
 * Bridge routes, bridged-token mints and deployment-local mints each describe
 * one deployment rather than the whole asset. `bridge:native` and
 * `bridge:unverified` are asset-level and stay outside this family.
 */
export function isV9DeploymentControlComponentKey(componentKey: string): boolean {
  if (componentKey.startsWith(BRIDGE_MINT_PREFIX) || componentKey.startsWith(DEPLOYMENT_MINT_PREFIX)) return true;
  return componentKey.startsWith(BRIDGE_ROUTE_PREFIX) && componentKey.indexOf(":", BRIDGE_ROUTE_PREFIX.length) > 0;
}

/**
 * Reader chain name for a `<chain>:<…>` deployment or authority key, or null.
 * Keys can lead with a non-chain namespace (`asset`, `issuer-backend`, `safe`,
 * `ambiguous-chain`, `representation-group`), so only a registered chain
 * names one; a title-cased namespace would read as a chain that is not there.
 */
export function v9ControlChainLabel(key: string): string | null {
  const separator = key.indexOf(":");
  if (separator <= 0) return null;
  const chainId = normalizeChainId(key.slice(0, separator));
  return chainId === null ? null : CHAIN_META[chainId]?.name ?? null;
}
