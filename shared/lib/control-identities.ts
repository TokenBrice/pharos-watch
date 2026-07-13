import { resolveChainId } from "./chains";
import type { StablecoinMeta } from "../types/core";

export interface CriticalControlIdentityOccurrence {
  key: string;
  path: "mint" | "upgrade" | "bridge" | "oracle";
  label: string;
}

function canonicalChain(chain: string): string {
  return resolveChainId(chain) ?? chain.trim().toLowerCase();
}

function canonicalAddress(address: string): string {
  const trimmed = address.trim();
  return /^0x[0-9a-f]+$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** Address identities stay chain-scoped because the same bytes can name unrelated controllers. */
export function criticalControllerKey(chain: string, address: string): string {
  return `address:${canonicalChain(chain)}:${canonicalAddress(address)}`;
}

function appendReviewedKeys(
  rows: CriticalControlIdentityOccurrence[],
  keys: readonly string[] | undefined,
  path: CriticalControlIdentityOccurrence["path"],
  label: string,
): void {
  for (const key of keys ?? []) rows.push({ key: `reviewed:${key}`, path, label });
}

export function collectCriticalControlIdentities(meta: StablecoinMeta): CriticalControlIdentityOccurrence[] {
  const rows: CriticalControlIdentityOccurrence[] = [];

  for (const control of meta.mintAuthority?.controls ?? []) {
    if (control.chain && control.address) {
      rows.push({ key: criticalControllerKey(control.chain, control.address), path: "mint", label: control.label });
    }
    appendReviewedKeys(rows, control.failureDomainKeys, "mint", control.label);
  }

  const upgrade = meta.mintAuthority?.upgradeability;
  if (upgrade?.controlRef) {
    const control = meta.mintAuthority?.controls?.find((candidate) => candidate.label === upgrade.controlRef);
    if (control?.chain && control.address) {
      rows.push({
        key: criticalControllerKey(control.chain, control.address),
        path: "upgrade",
        label: upgrade.controlRef,
      });
    }
    appendReviewedKeys(rows, control?.failureDomainKeys, "upgrade", upgrade.controlRef);
  }

  for (const route of meta.bridgeRouteRisk?.routes ?? []) {
    if (route.controllerChain && route.controllerAddress) {
      rows.push({
        key: criticalControllerKey(route.controllerChain, route.controllerAddress),
        path: "bridge",
        label: route.id,
      });
    }
    appendReviewedKeys(rows, route.failureDomainKeys, "bridge", route.id);
  }

  for (const branch of meta.oracleRisk?.branches ?? []) {
    appendReviewedKeys(rows, branch.failureDomainKeys, "oracle", branch.label);
    for (const feed of branch.feeds ?? []) {
      if (feed.address) {
        rows.push({
          key: criticalControllerKey(feed.chain, feed.address),
          path: "oracle",
          label: `${branch.label}: ${feed.provider}`,
        });
      }
      appendReviewedKeys(rows, feed.failureDomainKeys, "oracle", `${branch.label}: ${feed.provider}`);
    }
  }

  const unique = new Map<string, CriticalControlIdentityOccurrence>();
  for (const row of rows) unique.set(`${row.key}:${row.path}:${row.label}`, row);
  return [...unique.values()].sort(
    (left, right) =>
      left.key.localeCompare(right.key) || left.path.localeCompare(right.path) || left.label.localeCompare(right.label),
  );
}

export function findCommonCriticalControls(meta: StablecoinMeta): Array<{
  key: string;
  paths: CriticalControlIdentityOccurrence["path"][];
  labels: string[];
}> {
  const byKey = new Map<string, CriticalControlIdentityOccurrence[]>();
  for (const occurrence of collectCriticalControlIdentities(meta)) {
    byKey.set(occurrence.key, [...(byKey.get(occurrence.key) ?? []), occurrence]);
  }

  return [...byKey.entries()]
    .map(([key, occurrences]) => ({
      key,
      paths: [...new Set(occurrences.map((occurrence) => occurrence.path))].sort(),
      labels: [...new Set(occurrences.map((occurrence) => occurrence.label))].sort(),
    }))
    .filter((row) => row.paths.length > 1)
    .sort((left, right) => left.key.localeCompare(right.key));
}
