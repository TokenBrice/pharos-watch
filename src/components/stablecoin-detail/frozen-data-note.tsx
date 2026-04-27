import { Snowflake } from "lucide-react";

interface FrozenDataNoteProps {
  frozenAt: string;
}

export function FrozenDataNote({ frozenAt }: FrozenDataNoteProps) {
  return (
    <div className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-0.5 text-xs text-muted-foreground">
      <Snowflake className="h-3 w-3" aria-hidden="true" />
      Data frozen on {frozenAt}. Pharos no longer collects new metrics for this asset.
    </div>
  );
}
