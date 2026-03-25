import { cn } from "@/lib/utils";

const CHAIN_TYPE_STYLES: Record<string, string> = {
  evm: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  tron: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
  other: "bg-muted text-muted-foreground border-border/60",
};

export function ChainTypeBadge({ type }: { type: string }) {
  const style = CHAIN_TYPE_STYLES[type] ?? CHAIN_TYPE_STYLES.other;
  return (
    <span className={cn("rounded border px-1.5 py-0.5 text-xs font-medium uppercase", style)}>
      {type}
    </span>
  );
}
