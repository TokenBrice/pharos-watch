import { TAPE_CLASSES } from "@/components/tape/tape-classes";
import { eventClassSlug } from "@/lib/tape-collapse";

// Per-class background tint, shared by the homepage marquee and the
// /timeline/ event stream. Hues are distinct from the severity ramp
// (emerald/sky/amber/orange/red) so type and severity stay readable
// independently. Tailwind classes are static strings as required.
//
// The marquee uses denser cells (`/10`); the timeline uses full-width rows,
// where the lighter `/8` opacity reads as a hue tag rather than a fill.
//
// Keys track `TAPE_CLASSES` — one entry per class with a live projector.

const TAPE_CLASS_BG_CHIP: Record<string, string> = {
  depeg: "bg-rose-500/10",
  freeze: "bg-cyan-500/10",
  score: "bg-indigo-500/10",
  dews: "bg-fuchsia-500/10",
  psi: "bg-sky-500/10",
  mint_burn: "bg-orange-500/10",
  yield: "bg-lime-500/10",
  methodology: "bg-violet-500/10",
  lifecycle: "bg-amber-500/10",
  cemetery: "bg-zinc-500/10",
};

const TAPE_CLASS_BG_ROW: Record<string, string> = {
  depeg: "bg-rose-500/[0.08]",
  freeze: "bg-cyan-500/[0.08]",
  score: "bg-indigo-500/[0.08]",
  dews: "bg-fuchsia-500/[0.08]",
  psi: "bg-sky-500/[0.08]",
  mint_burn: "bg-orange-500/[0.08]",
  yield: "bg-lime-500/[0.08]",
  methodology: "bg-violet-500/[0.08]",
  lifecycle: "bg-amber-500/[0.08]",
  cemetery: "bg-zinc-500/[0.08]",
};

// Derived, never re-authored: the chip row, the JSON-LD ItemList and the class
// digest all read the same labels, so a rename lands everywhere at once.
const TAPE_CLASS_LABEL: Record<string, string> = Object.fromEntries(
  TAPE_CLASSES.map((cls) => [cls.slug, cls.label]),
);

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
