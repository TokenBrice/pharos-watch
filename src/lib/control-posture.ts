import { CONTROL_POSTURE_STYLES, GOVERNANCE_LABELS } from "@shared/lib/classification";
import type { GovernanceQuality, StablecoinMeta } from "@shared/types";

type ControlPostureCoin = Pick<
  StablecoinMeta,
  "name" | "symbol" | "flags" | "governanceQuality" | "variantOf"
>;

type ControlPostureParent = Pick<StablecoinMeta, "id" | "name" | "symbol">;

export type ControlPostureScope = "LOCAL" | "INHERITED" | "WRAPPER";

export interface ControlPostureFact {
  key: string;
  label: string;
  value: string;
}

export interface ControlPostureView {
  key: GovernanceQuality;
  label: string;
  shortLabel: string;
  badgeClassName: string;
  summary: string;
  facts: ControlPostureFact[];
  details: string[];
  scope: ControlPostureScope;
}

const POSTURE_EXPLANATIONS: Record<GovernanceQuality, string> = {
  "immutable-code":
    "The token's core control path is classified as fixed in deployed code, without an ordinary administrator or upgrade path.",
  "dao-governance":
    "Material control is classified as exercised through an onchain governance process rather than one operator or signer group.",
  multisig:
    "Material control is classified as requiring approval from a defined group of signers through a multisignature account.",
  "regulated-entity":
    "Material control is classified as exercised by an identified entity operating within a regulated issuer or custodian structure.",
  "single-entity":
    "Material control is classified as concentrated in one issuer, protocol team, or operating entity.",
  wrapper:
    "The token is classified primarily as a wrapper whose control posture depends on an underlying asset or parent system.",
};

function deriveScope(key: GovernanceQuality, variantOf?: string): ControlPostureScope {
  if (key === "wrapper") return variantOf ? "INHERITED" : "WRAPPER";
  return "LOCAL";
}

const SCOPE_LABELS: Record<ControlPostureScope, string> = {
  LOCAL: "Local",
  INHERITED: "Inherited",
  WRAPPER: "Wrapper",
};

function buildVariantDetail(
  coin: ControlPostureCoin,
  parent: ControlPostureParent | null | undefined,
  scope: ControlPostureScope,
): string | null {
  if (!coin.variantOf) {
    return scope === "WRAPPER"
      ? "This record is classified as a wrapper, but it does not name a tracked parent asset."
      : null;
  }

  const parentLabel = parent ? `${parent.name} (${parent.symbol})` : "its parent asset";
  if (scope === "INHERITED") {
    return `${coin.symbol} is a tracked variant of ${parentLabel}; this posture describes wrapper-level control inherited from that parent.`;
  }
  return `${coin.symbol} is a tracked variant of ${parentLabel}, but its posture is reviewed as its own local control rather than inherited.`;
}

export function buildControlPostureView(
  coin: ControlPostureCoin,
  parent?: ControlPostureParent | null,
): ControlPostureView | null {
  const key = coin.governanceQuality;
  if (!key) return null;

  const style = CONTROL_POSTURE_STYLES[key];
  const scope = deriveScope(key, coin.variantOf);
  const taxonomy = GOVERNANCE_LABELS[coin.flags.governance];
  const variantDetail = buildVariantDetail(coin, parent, scope);

  return {
    key,
    label: style.label,
    shortLabel: style.shortLabel,
    badgeClassName: style.badgeClassName,
    scope,
    summary: `${coin.symbol} control posture: ${style.label}. Descriptive only; the Economic Control score comes from mint, oracle and bridge evidence.`,
    facts: [
      { key: "posture", label: "Posture", value: style.label },
      { key: "taxonomy", label: "Governance", value: taxonomy },
      { key: "scope", label: "Scope", value: SCOPE_LABELS[scope] },
      { key: "scoring-role", label: "Scoring role", value: "Descriptive" },
    ],
    details: [
      POSTURE_EXPLANATIONS[key],
      `${taxonomy} is the broader governance classification. Control posture describes more precisely where operational authority sits.`,
      "Control posture is not a Safety Score input. Economic Control is scored from the reviewed mint authority, oracle and bridge evidence.",
      ...(variantDetail ? [variantDetail] : []),
    ],
  };
}
