"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

interface CopyableCellProps {
  value: string;
  children: React.ReactNode;
  className?: string;
  label?: string;
  onCopy?: (value: string) => void;
}

export function CopyableCell({
  value,
  children,
  className,
  label,
  onCopy,
}: CopyableCellProps) {
  const [showCopy, setShowCopy] = useState(false);
  const { copy, copied } = useCopyToClipboard({
    timeout: 1500,
    onSuccess: onCopy,
  });

  return (
    <div
      className={cn(
        "group/copy relative inline-flex items-center gap-2 cursor-pointer",
        className
      )}
      onMouseEnter={() => setShowCopy(true)}
      onMouseLeave={() => setShowCopy(false)}
      onClick={(e) => {
        e.stopPropagation();
        copy(value);
      }}
      title={label ? `Click to copy ${label}` : "Click to copy"}
    >
      {children}
      <span
        className={cn(
          "inline-flex items-center justify-center rounded p-0.5 transition-all duration-200",
          "opacity-0 group-hover/copy:opacity-100",
          "hover:bg-muted",
          copied && "opacity-100 bg-green-500/10"
        )}
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
        ) : (
          <Copy className="h-3 w-3 text-muted-foreground" />
        )}
      </span>
    </div>
  );
}
