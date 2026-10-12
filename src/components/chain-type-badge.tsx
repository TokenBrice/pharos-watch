import { CHAIN_VM_BADGE_CLASSES } from "@shared/lib/classification";
import { cn } from "@/lib/utils";

const CHAIN_TYPE_STYLES: Record<string, string> = {
  evm: CHAIN_VM_BADGE_CLASSES.evm,
  tron: CHAIN_VM_BADGE_CLASSES.tron,
  other: "bg-muted text-muted-foreground border-border/60",
};

export function ChainTypeBadge({ type }: { type: string }) {
  const style = CHAIN_TYPE_STYLES[type] ?? CHAIN_TYPE_STYLES.other;
  return (
    <span className={cn("rounded-sm border px-1.5 py-0.5 text-xs font-medium uppercase", style)}>
      {type}
    </span>
  );
}
