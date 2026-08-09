import { CONTROL_POSTURE_STYLES, GOVERNANCE_LABELS_SHORT } from "@shared/lib/classification";
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

function buildVariantDetail(
  coin: ControlPostureCoin,
  parent: ControlPostureParent | null | undefined,
  scope: ControlPostureScope,
): string | null {
  if (!coin.variantOf) {
    return scope === "WRAPPER"
      ? "This record is classified as a wrapper, but it does not declare a tracked parent through variantOf."
      : null;
  }

  const parentLabel = parent ? `${parent.name} (${parent.symbol})` : coin.variantOf;
  if (scope === "INHERITED") {
    return `${coin.symbol} is a tracked variant of ${parentLabel}; this posture describes wrapper-level control inherited from that parent relationship.`;
  }
  return `${coin.symbol} is a tracked variant of ${parentLabel}, but its posture is authored as local control rather than the wrapper / inherited category.`;
}

export function buildControlPostureView(
  coin: ControlPostureCoin,
  parent?: ControlPostureParent | null,
): ControlPostureView | null {
  const key = coin.governanceQuality;
  if (!key) return null;

  const style = CONTROL_POSTURE_STYLES[key];
  const scope = deriveScope(key, coin.variantOf);
  const taxonomy = GOVERNANCE_LABELS_SHORT[coin.flags.governance].toUpperCase();
  const variantDetail = buildVariantDetail(coin, parent, scope);

  return {
    key,
    label: style.label,
    shortLabel: style.shortLabel,
    badgeClassName: style.badgeClassName,
    scope,
    summary: `${coin.symbol} control posture: ${style.label}. This classification is descriptive; V9 Economic Control is scored through mint, oracle, and bridge evidence.`,
    facts: [
      { key: "posture", label: "Posture", value: style.label },
      { key: "taxonomy", label: "Taxonomy", value: taxonomy },
      { key: "scope", label: "Scope", value: scope },
      { key: "scoring-role", label: "Scoring role", value: "DESCRIPTIVE" },
    ],
    details: [
      POSTURE_EXPLANATIONS[key],
      `The ${taxonomy} taxonomy is the broader protocol classification from flags.governance. Control posture is the finer description of where operational authority sits.`,
      "Control posture is not a Safety Score input. Mint Authority and the applicable oracle and bridge evidence provide the reviewed facts used by V9 Economic Control.",
      ...(variantDetail ? [variantDetail] : []),
    ],
  };
}
