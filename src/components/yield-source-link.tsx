import type { KeyboardEventHandler, MouseEventHandler, ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

interface YieldSourceLinkProps {
  href?: string | null;
  children: ReactNode;
  className?: string;
  iconClassName?: string;
  stopPropagation?: boolean;
}

export function YieldSourceLink({
  href,
  children,
  className,
  iconClassName,
  stopPropagation = false,
}: YieldSourceLinkProps) {
  if (!href) {
    return <span className={className}>{children}</span>;
  }

  const handleClick: MouseEventHandler<HTMLAnchorElement> | undefined = stopPropagation
    ? (event) => event.stopPropagation()
    : undefined;
  const handleKeyDown: KeyboardEventHandler<HTMLAnchorElement> | undefined = stopPropagation
    ? (event) => event.stopPropagation()
    : undefined;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "pharos-focus-ring inline-flex min-w-0 items-center gap-1 text-inherit transition-colors hover:text-foreground hover:underline underline-offset-4",
        className,
      )}
    >
      <span className="truncate">{children}</span>
      <ExternalLink className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", iconClassName)} />
    </a>
  );
}
