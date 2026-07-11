"use client";

import type { KeyboardEventHandler, MouseEventHandler, ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import { cn } from "@/lib/utils";

export interface TableSourceLinkProps {
  href?: string | null;
  children: ReactNode;
  className?: string;
  iconClassName?: string;
  title?: string;
  stopPropagation?: boolean;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}

export function TableSourceLink({
  href,
  children,
  className,
  iconClassName,
  title,
  stopPropagation = false,
  onClick,
}: TableSourceLinkProps) {
  if (!href) {
    return <span className={className}>{children}</span>;
  }

  const handleClick: MouseEventHandler<HTMLAnchorElement> | undefined = stopPropagation
    ? (event) => {
        event.stopPropagation();
        onClick?.(event);
      }
    : onClick;
  const handleKeyDown: KeyboardEventHandler<HTMLAnchorElement> | undefined = stopPropagation
    ? (event) => event.stopPropagation()
    : undefined;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "pharos-focus-ring inline-flex min-w-0 items-center gap-1 rounded-sm text-inherit transition-colors hover:text-foreground hover:underline underline-offset-4",
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      <ExternalLink className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", iconClassName)} aria-hidden="true" />
    </a>
  );
}
