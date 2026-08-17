import type {
  BridgeRouteControl,
  BridgeRouteControlCapability,
  BridgeRouteDeployment,
  MintAuthorityControl,
  StablecoinMeta,
} from "../../types";
import { criticalControllerKey } from "../control-identities";
import { isWellFormedDeploymentId, normalizeDeploymentId } from "../deployment-id";
import { isActiveStablecoinMeta } from "./status";

export type MintBridgeOwnershipMeta = Pick<
  StablecoinMeta,
  "id" | "status" | "contracts" | "mintAuthority" | "bridgeRouteRisk"
>;

export type MintBridgeOwnershipViolationCode =
  | "unknown-deployment-ref"
  | "duplicate-deployment-ref"
  | "non-normalized-deployment-ref"
  | "mint-ref-not-native"
  | "bridge-control-unknown-route"
  | "bridge-capability-in-mint"
  | "missing-mint-deployment-refs"
  | "missing-native-deployment"
  | "invalid-no-local-issuance-exception"
  | "duplicate-cross-domain-capability";

export interface MintBridgeOwnershipViolation {
  assetId: string;
  code: MintBridgeOwnershipViolationCode;
  path: string;
  message: string;
  severity: "error" | "warning";
}

interface RouteEntry {
  index: number;
  route: BridgeRouteDeployment;
}

interface ResolvedReference {
  index: number;
  normalized: string;
  path: string;
  route: RouteEntry | undefined;
}

type Severity = MintBridgeOwnershipViolation["severity"];

function migrationSeverity(enforce: boolean): Severity {
  return enforce ? "error" : "warning";
}

function isReviewedNativeRoute(route: BridgeRouteDeployment | undefined): boolean {
  return route?.reviewDisposition === "reviewed" && route.issuanceModel === "native-issuance";
}

function controllerIdentity(chain: string | undefined, address: string | undefined): string | null {
  if (!chain || !address) return null;
  return criticalControllerKey(chain, address);
}

function hasReviewedNoLocalIssuanceException(meta: MintBridgeOwnershipMeta): boolean {
  const mintAuthority = meta.mintAuthority;
  if (!mintAuthority) return false;

  const exception = mintAuthority.review.noLocalIssuance;
  if (!exception) return false;
  if (
    typeof exception.reviewedAt !== "string" ||
    exception.reviewedAt.trim().length === 0 ||
    typeof exception.reviewer !== "string" ||
    exception.reviewer.trim().length === 0 ||
    typeof exception.rationale !== "string" ||
    exception.rationale.trim().length === 0
  ) {
    return false;
  }

  // A "no local issuance" claim is contradicted by any reviewed native-issuance route, whatever the kind.
  if ((meta.bridgeRouteRisk?.routes ?? []).some(isReviewedNativeRoute)) return false;

  if (exception.kind === "inherited-parent-issuance") {
    return (
      mintAuthority.mintPath === "wrapped-or-variant-inherited" &&
      typeof mintAuthority.inheritedFrom === "string" &&
      mintAuthority.inheritedFrom.trim().length > 0
    );
  }
  if (exception.kind === "external-only-representation") {
    // Every authored deployment must be covered by a reviewed non-native route, so the absent
    // canonical surface is an explicit reviewed fact rather than missing route coverage.
    const routes = meta.bridgeRouteRisk?.routes ?? [];
    if (routes.length === 0) return false;
    if (!routes.every((route) => route.reviewDisposition === "reviewed")) return false;
    const reviewedRouteIds = new Set(routes.map((route) => normalizeDeploymentId(route.id)).filter(Boolean));
    const authoredIds = (meta.contracts ?? [])
      .map((contract) => normalizeDeploymentId(`${contract.chain}:${contract.address}`))
      .filter(Boolean);
    if (authoredIds.length === 0) return false;
    return authoredIds.every((id) => reviewedRouteIds.has(id));
  }

  return false;
}

function addViolation(
  violations: MintBridgeOwnershipViolation[],
  seen: Set<string>,
  meta: MintBridgeOwnershipMeta,
  code: MintBridgeOwnershipViolationCode,
  path: string,
  message: string,
  severity: Severity,
): void {
  const key = `${code}|${path}|${message}|${severity}`;
  if (seen.has(key)) return;
  seen.add(key);
  violations.push({ assetId: meta.id, code, path, message, severity });
}

function collectAuthoredDeploymentIds(meta: MintBridgeOwnershipMeta, routes: readonly BridgeRouteDeployment[]): Set<string> {
  const ids = new Set<string>();

  for (const contract of meta.contracts ?? []) {
    const id = normalizeDeploymentId(`${contract.chain}:${contract.address}`);
    if (id) ids.add(id);
  }
  for (const route of routes) {
    const id = normalizeDeploymentId(route.id);
    if (id) ids.add(id);
  }

  return ids;
}

function collectAuthoredContractIds(meta: MintBridgeOwnershipMeta): Set<string> {
  const ids = new Set<string>();
  for (const contract of meta.contracts ?? []) {
    const id = normalizeDeploymentId(`${contract.chain}:${contract.address}`);
    if (id) ids.add(id);
  }
  return ids;
}

function validateReferenceList({
  refs,
  pathPrefix,
  routeById,
  unknownCode,
  meta,
  violations,
  seen,
}: {
  refs: readonly string[] | undefined;
  pathPrefix: string;
  routeById: ReadonlyMap<string, RouteEntry>;
  unknownCode: "unknown-deployment-ref" | "bridge-control-unknown-route";
  meta: MintBridgeOwnershipMeta;
  violations: MintBridgeOwnershipViolation[];
  seen: Set<string>;
}): ResolvedReference[] {
  if (!refs) return [];

  const resolved: ResolvedReference[] = [];
  const seenRefs = new Set<string>();
  for (let index = 0; index < refs.length; index += 1) {
    const value = refs[index]!;
    const path = `${pathPrefix}[${index}]`;
    const normalized = normalizeDeploymentId(value);
    if (!isWellFormedDeploymentId(value)) {
      addViolation(
        violations,
        seen,
        meta,
        "non-normalized-deployment-ref",
        path,
        `deployment reference "${value}" must be a normalized chain:contractAddress ID; normalized value is "${normalized || "<invalid>"}"`,
        "error",
      );
      continue;
    }

    if (seenRefs.has(normalized)) {
      addViolation(
        violations,
        seen,
        meta,
        "duplicate-deployment-ref",
        path,
        `deployment reference "${value}" duplicates normalized reference "${normalized}"`,
        "error",
      );
    }
    seenRefs.add(normalized);

    const route = routeById.get(normalized);
    // A mint ref may also name an authored contract deployment when the asset has no reviewed route
    // inventory at all; unrouted single-chain assets have no route row to point at. Bridge control
    // refs always require a reviewed route, and rule 2 still constrains refs once routes exist.
    const authoredWithoutRoutes =
      unknownCode === "unknown-deployment-ref" &&
      routeById.size === 0 &&
      collectAuthoredContractIds(meta).has(normalized);
    if (!route && !authoredWithoutRoutes) {
      addViolation(
        violations,
        seen,
        meta,
        unknownCode,
        path,
        `${unknownCode === "bridge-control-unknown-route" ? "bridge route reference" : "mint deployment reference"} "${value}" does not name an authored bridgeRouteRisk.routes[].id`,
        "error",
      );
    }
    resolved.push({ index, normalized, path, route });
  }

  return resolved;
}

function validateMintNativeTargets(
  refs: readonly ResolvedReference[],
  meta: MintBridgeOwnershipMeta,
  violations: MintBridgeOwnershipViolation[],
  seen: Set<string>,
): void {
  for (const ref of refs) {
    if (!ref.route || isReviewedNativeRoute(ref.route.route)) continue;

    addViolation(
      violations,
      seen,
      meta,
      "mint-ref-not-native",
      ref.path,
      `Mint Authority deployment reference "${ref.normalized}" resolves to issuanceModel="${ref.route.route.issuanceModel}" with reviewDisposition="${ref.route.route.reviewDisposition}"; it must resolve to a reviewed native-issuance route`,
      "error",
    );
  }
}

function getImplicitSingleRoute(routes: readonly BridgeRouteDeployment[], routeById: ReadonlyMap<string, RouteEntry>): RouteEntry | null {
  if (routes.length !== 1) return null;
  const id = normalizeDeploymentId(routes[0]!.id);
  return id ? routeById.get(id) ?? null : null;
}

function getMintBridgeCapabilities(
  control: MintAuthorityControl,
  mintPathIsBridgeSynthetic: boolean,
): Set<string> {
  const capabilities = new Set<string>();
  if (control.role === "bridge-admin") capabilities.add("admin");
  if (control.authorityType === "bridge") capabilities.add("*");
  if (control.routeChecks != null) capabilities.add("*");
  if (mintPathIsBridgeSynthetic) capabilities.add("bridge-mint");
  return capabilities;
}

function getMintRouteScope(
  control: MintAuthorityControl,
  routes: readonly BridgeRouteDeployment[],
  routeById: ReadonlyMap<string, RouteEntry>,
  bridgeLike: boolean,
): Set<string> {
  if (control.deploymentRefs != null && control.deploymentRefs.length > 0) {
    return new Set(
      control.deploymentRefs
        .map((ref) => normalizeDeploymentId(ref))
        .filter((ref): ref is string => Boolean(ref) && routeById.has(ref)),
    );
  }

  if (!bridgeLike) {
    const implicitRoute = getImplicitSingleRoute(routes, routeById);
    return implicitRoute ? new Set([normalizeDeploymentId(implicitRoute.route.id)]) : new Set();
  }

  return new Set(
    routes
      .map((route) => normalizeDeploymentId(route.id))
      .filter((route): route is string => Boolean(route) && routeById.has(route)),
  );
}

function validateDuplicateCrossDomainCapabilities(
  meta: MintBridgeOwnershipMeta,
  routes: readonly BridgeRouteDeployment[],
  routeById: ReadonlyMap<string, RouteEntry>,
  violations: MintBridgeOwnershipViolation[],
  seen: Set<string>,
): void {
  const mintControls = meta.mintAuthority?.controls ?? [];
  const bridgeControls = meta.bridgeRouteRisk?.controls ?? [];
  const mintPathIsBridgeSynthetic = meta.mintAuthority?.mintPath === "bridge-or-oft-synthetic";

  for (let mintIndex = 0; mintIndex < mintControls.length; mintIndex += 1) {
    const mintControl = mintControls[mintIndex]!;
    const mintIdentity = controllerIdentity(mintControl.chain, mintControl.address);
    if (!mintIdentity) continue;

    const mintCapabilities = getMintBridgeCapabilities(mintControl, mintPathIsBridgeSynthetic);
    if (mintCapabilities.size === 0) continue;

    const mintRouteScope = getMintRouteScope(
      mintControl,
      routes,
      routeById,
      true,
    );
    if (mintRouteScope.size === 0) continue;

    for (let bridgeIndex = 0; bridgeIndex < bridgeControls.length; bridgeIndex += 1) {
      const bridgeControl = bridgeControls[bridgeIndex]!;
      const bridgeIdentity = controllerIdentity(bridgeControl.controllerChain, bridgeControl.controllerAddress);
      if (bridgeIdentity !== mintIdentity) continue;

      const bridgeCapabilities = new Set(bridgeControl.capabilities ?? []);
      for (const bridgeRef of bridgeControl.routeRefs ?? []) {
        const routeId = normalizeDeploymentId(bridgeRef);
        if (!routeId || !mintRouteScope.has(routeId)) continue;

        const matchingCapabilities = [...mintCapabilities].filter(
          (capability) =>
            capability === "*" || bridgeCapabilities.has(capability as BridgeRouteControlCapability),
        );
        for (const capability of matchingCapabilities) {
          const mintPath = capability === "*"
            ? `mintAuthority.controls[${mintIndex}].routeChecks`
            : `mintAuthority.controls[${mintIndex}].role`;
          addViolation(
            violations,
            seen,
            meta,
            "duplicate-cross-domain-capability",
            mintPath,
            `bridge capability "${capability === "*" ? "legacy bridge capability" : capability}" for controller "${mintIdentity}" and route "${routeId}" is authored in both Mint Authority control "${mintControl.label}" and bridgeRouteRisk control "${bridgeControl.id}"`,
            "error",
          );
        }
      }
    }
  }
}

export function validateMintBridgeOwnership(
  meta: MintBridgeOwnershipMeta,
  options?: { enforce?: boolean },
): MintBridgeOwnershipViolation[] {
  const violations: MintBridgeOwnershipViolation[] = [];
  const seen = new Set<string>();
  const enforce = options?.enforce === true;
  const routes = meta.bridgeRouteRisk?.routes ?? [];
  const routeById = new Map<string, RouteEntry>();
  const seenRouteIds = new Set<string>();

  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index]!;
    const value = route.id;
    const normalized = normalizeDeploymentId(value);
    const routeIdentity = normalized || value;
    if (!isWellFormedDeploymentId(value)) {
      addViolation(
        violations,
        seen,
        meta,
        "non-normalized-deployment-ref",
        `bridgeRouteRisk.routes[${index}].id`,
        `bridge route ID "${value}" must be a normalized chain:contractAddress ID; normalized value is "${normalized || "<invalid>"}"`,
        "error",
      );
    }
    if (seenRouteIds.has(routeIdentity)) {
      addViolation(
        violations,
        seen,
        meta,
        "duplicate-deployment-ref",
        `bridgeRouteRisk.routes[${index}].id`,
        `bridge route ID "${value}" duplicates an earlier route ID after normalization as "${routeIdentity}"`,
        "error",
      );
    }
    seenRouteIds.add(routeIdentity);
    if (isWellFormedDeploymentId(value)) routeById.set(normalized, { index, route });
  }

  // An explicit reviewed no-local-issuance exception means refless Mint Authority controls describe
  // untracked native issuance; they must not be read as implicitly targeting the sole bridge route.
  const noLocalIssuanceExceptionApplies = hasReviewedNoLocalIssuanceException(meta);

  const mintAuthority = meta.mintAuthority;
  const mintControls = mintAuthority?.controls ?? [];
  for (let index = 0; index < mintControls.length; index += 1) {
    const control = mintControls[index]!;
    const prefix = `mintAuthority.controls[${index}]`;
    const refs = validateReferenceList({
      refs: control.deploymentRefs,
      pathPrefix: `${prefix}.deploymentRefs`,
      routeById,
      unknownCode: "unknown-deployment-ref",
      meta,
      violations,
      seen,
    });
    validateMintNativeTargets(refs, meta, violations, seen);

    const implicitRoute = getImplicitSingleRoute(routes, routeById);
    if (
      !noLocalIssuanceExceptionApplies &&
      (control.deploymentRefs == null || control.deploymentRefs.length === 0) &&
      implicitRoute != null &&
      !isReviewedNativeRoute(implicitRoute.route)
    ) {
      addViolation(
        violations,
        seen,
        meta,
        "mint-ref-not-native",
        `${prefix}.deploymentRefs`,
        `Mint Authority control "${control.label}" omits deploymentRefs and would target sole route "${implicitRoute.route.id}", which is not a reviewed native-issuance route`,
        "error",
      );
    }
  }

  const upgradeability = mintAuthority?.upgradeability;
  if (upgradeability) {
    const refs = validateReferenceList({
      refs: upgradeability.deploymentRefs,
      pathPrefix: "mintAuthority.upgradeability.deploymentRefs",
      routeById,
      unknownCode: "unknown-deployment-ref",
      meta,
      violations,
      seen,
    });
    validateMintNativeTargets(refs, meta, violations, seen);

    const implicitRoute = getImplicitSingleRoute(routes, routeById);
    if (
      !noLocalIssuanceExceptionApplies &&
      (upgradeability.deploymentRefs == null || upgradeability.deploymentRefs.length === 0) &&
      implicitRoute != null &&
      !isReviewedNativeRoute(implicitRoute.route)
    ) {
      addViolation(
        violations,
        seen,
        meta,
        "mint-ref-not-native",
        "mintAuthority.upgradeability.deploymentRefs",
        `Mint Authority upgradeability omits deploymentRefs and would target sole route "${implicitRoute.route.id}", which is not a reviewed native-issuance route`,
        "error",
      );
    }
  }

  const bridgeControls = meta.bridgeRouteRisk?.controls ?? [];
  for (let index = 0; index < bridgeControls.length; index += 1) {
    const control = bridgeControls[index]!;
    validateReferenceList({
      refs: control.routeRefs,
      pathPrefix: `bridgeRouteRisk.controls[${index}].routeRefs`,
      routeById,
      unknownCode: "bridge-control-unknown-route",
      meta,
      violations,
      seen,
    });
  }

  const active = isActiveStablecoinMeta(meta);
  if (active && mintAuthority) {
    const migrationSeverityValue = migrationSeverity(enforce);
    if (mintAuthority.mintPath === "bridge-or-oft-synthetic") {
      addViolation(
        violations,
        seen,
        meta,
        "bridge-capability-in-mint",
        "mintAuthority.mintPath",
        `Mint Authority mintPath "${mintAuthority.mintPath}" represents bridge or OFT synthetic issuance and belongs in Bridge Risk`,
        migrationSeverityValue,
      );
    }
    for (let index = 0; index < mintControls.length; index += 1) {
      const control = mintControls[index]!;
      if (control.role === "bridge-admin") {
        addViolation(
          violations,
          seen,
          meta,
          "bridge-capability-in-mint",
          `mintAuthority.controls[${index}].role`,
          `Mint Authority control role "${control.role}" represents bridge administration and belongs in Bridge Risk`,
          migrationSeverityValue,
        );
      }
      if (control.authorityType === "bridge") {
        addViolation(
          violations,
          seen,
          meta,
          "bridge-capability-in-mint",
          `mintAuthority.controls[${index}].authorityType`,
          `Mint Authority control authorityType "${control.authorityType}" represents bridge administration and belongs in Bridge Risk`,
          migrationSeverityValue,
        );
      }
      if (control.routeChecks != null) {
        addViolation(
          violations,
          seen,
          meta,
          "bridge-capability-in-mint",
          `mintAuthority.controls[${index}].routeChecks`,
          "Mint Authority control contains routeChecks, which are bridge-route machinery and belong in Bridge Risk",
          migrationSeverityValue,
        );
      }
    }
  }

  const authoredDeploymentIds = collectAuthoredDeploymentIds(meta, routes);
  const isMultiDeployment =
    (meta.contracts?.length ?? 0) > 1 || routes.length > 1 || authoredDeploymentIds.size > 1;
  const resolvedNativeRoutes = routes.filter((route) => isReviewedNativeRoute(route));
  const reviewedNoLocalIssuanceException = hasReviewedNoLocalIssuanceException(meta);
  if (mintAuthority?.review.noLocalIssuance != null && !reviewedNoLocalIssuanceException) {
    addViolation(
      violations,
      seen,
      meta,
      "invalid-no-local-issuance-exception",
      "mintAuthority.review.noLocalIssuance",
      `Mint Authority noLocalIssuance exception kind "${mintAuthority.review.noLocalIssuance.kind}" is inconsistent with the authored profile; no reviewed native-issuance route may exist, inherited-parent-issuance requires mintPath "wrapped-or-variant-inherited" plus inheritedFrom, and external-only-representation requires every authored deployment to be covered by a reviewed route`,
      "error",
    );
  }
  if (active && isMultiDeployment && mintAuthority) {
    const migrationSeverityValue = migrationSeverity(enforce);
    const exceptionApplies = resolvedNativeRoutes.length === 0 && reviewedNoLocalIssuanceException;
    for (let index = 0; index < mintControls.length; index += 1) {
      const control = mintControls[index]!;
      if (control.deploymentRefs != null && control.deploymentRefs.length > 0) continue;
      if (exceptionApplies) continue;
      addViolation(
        violations,
        seen,
        meta,
        "missing-mint-deployment-refs",
        `mintAuthority.controls[${index}].deploymentRefs`,
        `active multi-deployment asset control "${control.label}" has deploymentRefs=${control.deploymentRefs == null ? "<missing>" : "[]"}; every Mint Authority control must name its affected deployment(s)`,
        migrationSeverityValue,
      );
    }
    if (
      upgradeability?.canChangeMintLogic === true &&
      (upgradeability.deploymentRefs == null || upgradeability.deploymentRefs.length === 0) &&
      !exceptionApplies
    ) {
      addViolation(
        violations,
        seen,
        meta,
        "missing-mint-deployment-refs",
        "mintAuthority.upgradeability.deploymentRefs",
        `active multi-deployment mutable Mint Authority upgradeability has deploymentRefs=${upgradeability.deploymentRefs == null ? "<missing>" : "[]"}; the upgrade path must name every native deployment whose mint logic it can replace`,
        migrationSeverityValue,
      );
    }
  }

  // Only meaningful once a Mint Authority review exists; unreviewed assets are owned by the
  // mint-authority and bridge-route coverage audits, not by this cross-domain ownership rule.
  if (active && mintAuthority && isMultiDeployment && resolvedNativeRoutes.length === 0 && !reviewedNoLocalIssuanceException) {
    addViolation(
      violations,
      seen,
      meta,
      "missing-native-deployment",
      "bridgeRouteRisk.routes",
      `active multi-deployment asset has no reviewed native-issuance deployment among ${routes.length} authored route(s); add the canonical route or an explicit reviewed inherited/external-only Mint Authority exception`,
      migrationSeverity(enforce),
    );
  }

  validateDuplicateCrossDomainCapabilities(meta, routes, routeById, violations, seen);
  return violations;
}
