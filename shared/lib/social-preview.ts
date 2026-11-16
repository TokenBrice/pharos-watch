/** Canonical dimensions and identity for evergreen and retained social previews. */
export const SOCIAL_PREVIEW_WIDTH = 1200;
export const SOCIAL_PREVIEW_HEIGHT = 630;
export const SOCIAL_PREVIEW_REVISION = "2";

export interface SocialPreviewImage {
  title: string;
  description: string;
  url: string;
  alt: string;
  width: typeof SOCIAL_PREVIEW_WIDTH;
  height: typeof SOCIAL_PREVIEW_HEIGHT;
  type: "image/png";
}

export type SocialPreviewGrammar = "signal" | "dossier" | "briefing";

/** Structural and identity-led art never substitutes for observed data or a quantitative chart. */
export type SocialPreviewVisual =
  | { kind: "lighthouse" | "peg" | "reserves" | "network" | "chain" | "control" | "flows" | "liquidity" | "yield" | "filter" | "portfolio" | "code"; labels: readonly [string, string] }
  | { kind: "identity"; symbol: string; name: string; logoPath?: string; facets: readonly [string, string] }
  | { kind: "contrast"; left: { symbol: string; label: string; logoPath?: string }; right: { symbol: string; label: string; logoPath?: string } }
  | { kind: "document"; labels: readonly [string, string] }
  | { kind: "edition"; date: string; label: string };

/** A destination's editorial promise, not a frozen copy of its changing dashboard. */
export interface SocialPreviewSpec {
  path: string;
  grammar: SocialPreviewGrammar;
  eyebrow: string;
  subject: string;
  hook: string;
  facts: readonly [] | readonly [string] | readonly [string, string];
  visual: SocialPreviewVisual;
}

function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

export function socialPreviewDescription(spec: SocialPreviewSpec): string {
  return `${sentence(spec.hook)}${spec.facts.length ? ` ${spec.facts.join(" · ")}.` : ""}`;
}

export function socialPreviewAlt(spec: SocialPreviewSpec): string {
  return `${sentence(spec.subject)} ${socialPreviewDescription(spec)} Pharos.`;
}
