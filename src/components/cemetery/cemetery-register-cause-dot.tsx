import type { CauseOfDeath } from "@shared/lib/cause-of-death";
import { CAUSE_BG_CLASS, causeColorVars } from "@/lib/cemetery-cause-style";
import { cn } from "@/lib/utils";

/** Decorative cause colour mark; always paired with the visible cause label. */
export function CemeteryRegisterCauseDot({ cause }: { cause: CauseOfDeath }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", CAUSE_BG_CLASS)}
      style={causeColorVars(cause)}
    />
  );
}
