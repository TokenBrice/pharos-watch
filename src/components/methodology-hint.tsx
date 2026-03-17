"use client";

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode, type SyntheticEvent } from "react";
import Link from "next/link";
import { CircleHelp } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { METHODOLOGY_CONTEXT, type MethodologyContextKey } from "@/lib/methodology-context";

interface MethodologyHintProps {
  topic: MethodologyContextKey;
  className?: string;
  buttonClassName?: string;
  contentClassName?: string;
}

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

function HintBody({
  topic,
  className,
}: {
  topic: MethodologyContextKey;
  className?: string;
}) {
  const item = METHODOLOGY_CONTEXT[topic];

  return (
    <div className={cn("space-y-2", className)}>
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{item.title}</p>
        <p className="text-xs leading-relaxed text-foreground">{item.summary}</p>
        {item.detail ? <p className="text-[11px] leading-relaxed text-muted-foreground">{item.detail}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {item.versionLabel ? <span>Methodology {item.versionLabel}</span> : null}
        <Link
          href={item.methodologyPath}
          className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
        >
          View methodology
        </Link>
        {item.changelogPath ? (
          <Link
            href={item.changelogPath}
            className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
          >
            Version history &rarr;
          </Link>
        ) : null}
      </div>
    </div>
  );
}

const HintButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { topic: MethodologyContextKey }
>(function HintButton({ topic, className, onClick, onKeyDown, type = "button", ...props }, ref) {
  const item = METHODOLOGY_CONTEXT[topic];

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={`Explain ${item.title}`}
      onClick={(event) => {
        stopPropagation(event);
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        stopPropagation(event);
        onKeyDown?.(event);
      }}
      className={cn(
        "pharos-focus-ring inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-frost-blue/25 bg-frost-blue/10 text-sky-700 transition-colors hover:border-frost-blue/45 hover:bg-frost-blue/14 hover:text-foreground dark:text-frost-blue",
        className,
      )}
    >
      <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
});

export function MethodologyHint({
  topic,
  className,
  buttonClassName,
  contentClassName,
}: MethodologyHintProps) {
  const item = METHODOLOGY_CONTEXT[topic];

  return (
    <span className={cn("inline-flex shrink-0 items-center", className)}>
      <span className="md:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <HintButton topic={topic} className={buttonClassName} />
          </SheetTrigger>
          <SheetContent side="bottom" className="rounded-t-3xl border-border/70 bg-background/98 pb-6" showCloseButton>
            <SheetHeader className="space-y-2 border-b border-border/60 pb-4">
              <p className="pharos-kicker">Methodology Context</p>
              <SheetTitle>{item.title}</SheetTitle>
              <SheetDescription>How this metric is computed and how to read it.</SheetDescription>
            </SheetHeader>
            <div className="px-4 pt-4">
              <HintBody topic={topic} className={contentClassName} />
            </div>
          </SheetContent>
        </Sheet>
      </span>
      <span className="hidden md:inline-flex">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <HintButton topic={topic} className={buttonClassName} />
            </TooltipTrigger>
            <TooltipContent className={cn("max-w-[280px] border border-border/70 bg-popover px-3 py-3 text-popover-foreground shadow-xl", contentClassName)}>
              <HintBody topic={topic} />
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
    </span>
  );
}

export function MethodologyLabel({
  topic,
  children,
  className,
}: {
  topic: MethodologyContextKey;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span>{children}</span>
      <MethodologyHint topic={topic} />
    </span>
  );
}

export function MethodologyCardActions({
  topic,
  className,
  showVersion = true,
}: {
  topic: MethodologyContextKey;
  className?: string;
  showVersion?: boolean;
}) {
  const item = METHODOLOGY_CONTEXT[topic];

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 pt-3 text-xs text-muted-foreground", className)}>
      {showVersion && item.versionLabel ? <span>Methodology {item.versionLabel}</span> : null}
      <Link
        href={item.methodologyPath}
        className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
      >
        View methodology
      </Link>
      {item.changelogPath ? (
        <Link
          href={item.changelogPath}
          className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
        >
          Version history &rarr;
        </Link>
      ) : null}
    </div>
  );
}
