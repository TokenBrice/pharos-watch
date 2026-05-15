import { eventClassSlug } from "@/lib/tape-collapse";

// Per-class background tint, shared by the homepage marquee and the
// /timeline/ event stream. Hues are distinct from the severity ramp
// (emerald/sky/amber/orange/red) so type and severity stay readable
// independently. Tailwind classes are static strings as required.
//
// The marquee uses denser cells (`/10`); the timeline uses full-width rows,
// where the lighter `/8` opacity reads as a hue tag rather than a fill.

export const TAPE_CLASS_BG_CHIP: Record<string, string> = {
  depeg: "bg-rose-500/10",
  freeze: "bg-cyan-500/10",
  score: "bg-indigo-500/10",
  dews: "bg-fuchsia-500/10",
  psi: "bg-sky-500/10",
  mint_burn: "bg-orange-500/10",
  reserve: "bg-emerald-500/10",
  redemption: "bg-teal-500/10",
  yield: "bg-lime-500/10",
  liquidity: "bg-blue-500/10",
  methodology: "bg-violet-500/10",
  lifecycle: "bg-amber-500/10",
  cemetery: "bg-zinc-500/10",
};

export const TAPE_CLASS_BG_ROW: Record<string, string> = {
  depeg: "bg-rose-500/[0.08]",
  freeze: "bg-cyan-500/[0.08]",
  score: "bg-indigo-500/[0.08]",
  dews: "bg-fuchsia-500/[0.08]",
  psi: "bg-sky-500/[0.08]",
  mint_burn: "bg-orange-500/[0.08]",
  reserve: "bg-emerald-500/[0.08]",
  redemption: "bg-teal-500/[0.08]",
  yield: "bg-lime-500/[0.08]",
  liquidity: "bg-blue-500/[0.08]",
  methodology: "bg-violet-500/[0.08]",
  lifecycle: "bg-amber-500/[0.08]",
  cemetery: "bg-zinc-500/[0.08]",
};

export const TAPE_CLASS_LABEL: Record<string, string> = {
  depeg: "Depegs",
  freeze: "Freezes",
  score: "Grade changes",
  dews: "DEWS bands",
  psi: "PSI bands",
  mint_burn: "Mint/burn",
  reserve: "Reserves",
  redemption: "Redemption",
  yield: "Yield",
  liquidity: "Liquidity",
  methodology: "Methodology",
  lifecycle: "Lifecycle",
  cemetery: "Cemetery",
};

export function tapeClassChipBg(type: string): string {
  return TAPE_CLASS_BG_CHIP[eventClassSlug(type)] ?? "";
}

export function tapeClassRowBg(type: string): string {
  return TAPE_CLASS_BG_ROW[eventClassSlug(type)] ?? "";
}

export function tapeClassLabel(type: string): string {
  const slug = eventClassSlug(type);
  return TAPE_CLASS_LABEL[slug] ?? slug;
}
