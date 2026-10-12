"use client";

import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const { copied, copy } = useCopyToClipboard(2000);

  const Icon = copied ? Check : Copy;

  return (
    <button
      type="button"
      onClick={() => void copy(text)}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className={cn(
        "pharos-focus-ring inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        copied && "text-state-positive hover:text-state-positive",
        className,
      )}
    >
      <Icon className="size-3.5" />
    </button>
  );
}
