"use client";

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode, type SyntheticEvent } from "react";
import Link from "next/link";
import { CircleHelp } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { METHODOLOGY_CONTEXT, type MethodologyContextKey } from "@/lib/methodology-context";
import { ShowYourWorkToggle } from "@/components/show-your-work-toggle";

interface MethodologyHintProps {
  topic: MethodologyContextKey;
  className?: string;
  buttonClassName?: string;
  contentClassName?: string;
  children?: ReactNode;
  /**
   * When true, pass `children` directly to Sheet/Popover triggers via `asChild`
   * without wrapping them in the dotted-underline default trigger. Use this
   * for non-text triggers such as score badges where adding an extra `<button>`
   * around an already-styled element would cause visual conflicts or nested
   * interactive elements.
   */
  asChild?: boolean;
}

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

type MethodologyContextItem = (typeof METHODOLOGY_CONTEXT)[MethodologyContextKey];
type MethodologyTriggerButtonProps = ComponentPropsWithoutRef<"button"> & {
  topic: MethodologyContextKey;
};

function MethodologyLinks({ item, showVersion = true }: { item: MethodologyContextItem; showVersion?: boolean }) {
  return (
    <>
      {showVersion && item.versionLabel ? <span>Methodology {item.versionLabel}</span> : null}
      <Link
        href={item.methodologyPath}
        className="pharos-focus-ring rounded-sm hover:underline hover:underline-offset-4 hover:text-foreground"
      >
        View methodology
      </Link>
      {item.changelogPath ? (
        <Link
          href={item.changelogPath}
          className="pharos-focus-ring rounded-sm hover:underline hover:underline-offset-4 hover:text-foreground"
        >
          Version history &rarr;
        </Link>
      ) : null}
    </>
  );
}

export const MethodologyTriggerButton = forwardRef<HTMLButtonElement, MethodologyTriggerButtonProps>(
  function MethodologyTriggerButton(
    { topic, className, onClick, onKeyDown, type = "button", children, "aria-label": ariaLabel, ...props },
    ref,
  ) {
    const item = METHODOLOGY_CONTEXT[topic];

    return (
      <button
        {...props}
        ref={ref}
        type={type}
        aria-label={ariaLabel ?? `Explain ${item.title}`}
        onClick={(event) => {
          stopPropagation(event);
          onClick?.(event);
        }}
        onKeyDown={(event) => {
          stopPropagation(event);
          onKeyDown?.(event);
        }}
        className={className}
      >
        {children}
      </button>
    );
  },
);

function HintBody({ topic, className }: { topic: MethodologyContextKey; className?: string }) {
  const item = METHODOLOGY_CONTEXT[topic];

  return (
    <div className={cn("space-y-2", className)}>
      <div className="space-y-1">
        <p className="pharos-label">{item.title}</p>
        <p className="text-xs leading-relaxed text-foreground">{item.summary}</p>
        {item.detail ? <p className="text-2xs leading-relaxed text-muted-foreground">{item.detail}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <MethodologyLinks item={item} />
      </div>
    </div>
  );
}

export function MethodologyHint({
  topic,
  className,
  buttonClassName,
  contentClassName,
  children,
  asChild = false,
}: MethodologyHintProps) {
  const item = METHODOLOGY_CONTEXT[topic];
  const hasInlineTrigger = children !== undefined;

  // For `asChild`, children are passed verbatim to Sheet/Popover triggers via
  // Radix Slot — caller must supply a single ReactElement.
  const renderTrigger = (): ReactNode => {
    if (!hasInlineTrigger) {
      return (
        // The visual circle stays 24px at every width; the transparent `after`
        // overlay extends the touch target to 44px without enlarging the icon.
        <MethodologyTriggerButton
          topic={topic}
          className={cn(
            "pharos-focus-ring relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-frost-blue/25 bg-frost-blue/10 text-brand-accent-text transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:border-frost-blue/45 hover:bg-frost-blue/14 hover:text-foreground md:after:hidden",
            buttonClassName,
          )}
        >
          <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
        </MethodologyTriggerButton>
      );
    }
    if (asChild) {
      return children;
    }
    return (
      <MethodologyTriggerButton
        topic={topic}
        className={cn(
          "pharos-focus-ring inline leading-6 underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 transition-colors hover:decoration-foreground data-[state=open]:decoration-foreground",
          buttonClassName,
        )}
      >
        {children}
      </MethodologyTriggerButton>
    );
  };

  return (
    <span className={cn(hasInlineTrigger ? "inline" : "inline-flex shrink-0 items-center", className)}>
      <span className={hasInlineTrigger ? "inline md:hidden" : "md:hidden"}>
        <Sheet>
          <SheetTrigger asChild>{renderTrigger()}</SheetTrigger>
          <SheetContent side="bottom" className="rounded-t-3xl border-border/70 bg-background/98 pb-6" showCloseButton>
            <SheetHeader className="space-y-2 border-b border-border/60 pb-4">
              <p className="pharos-label">Methodology context</p>
              <SheetTitle>{item.title}</SheetTitle>
              <SheetDescription>How this metric is computed and how to read it.</SheetDescription>
            </SheetHeader>
            <div className="px-4 pt-4">
              <HintBody topic={topic} className={contentClassName} />
            </div>
          </SheetContent>
        </Sheet>
      </span>
      <span className={hasInlineTrigger ? "hidden md:inline" : "hidden md:inline-flex"}>
        {/* Click-to-open Popover, not a Tooltip: the body carries links, and a
            tooltip closes on trigger blur, so Tab could never reach them
            (WCAG 2.1.1). Popover keeps focus inside and dismisses on Esc. */}
        <Popover>
          <PopoverTrigger asChild>{renderTrigger()}</PopoverTrigger>
          <PopoverContent
            className={cn(
              "w-auto max-w-[280px] border border-border/70 bg-popover px-3 py-3 text-popover-foreground shadow-xl",
              contentClassName,
            )}
          >
            <HintBody topic={topic} />
          </PopoverContent>
        </Popover>
      </span>
    </span>
  );
}

export function MethodologyLabel({
  topic,
  children,
  className,
  compact = false,
}: {
  topic: MethodologyContextKey;
  children: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span>{children}</span>
      <MethodologyHint
        topic={topic}
        buttonClassName={
          compact
            ? "border-frost-blue/35 bg-frost-blue/12 text-frost-blue"
            : undefined
        }
      />
    </span>
  );
}

export function MethodologyCardActions({
  topic,
  className,
  showVersion = true,
  showWorkToggle = false,
  trailing,
}: {
  topic: MethodologyContextKey;
  className?: string;
  showVersion?: boolean;
  /**
   * When true, renders <ShowYourWorkToggle /> next to the methodology link.
   * Use on cards that embed a <ShowYourWorkPanel> so users can discover the
   * "show inputs" capability without knowing the `?show-work=1` URL trick.
   */
  showWorkToggle?: boolean;
  trailing?: ReactNode;
}) {
  const item = METHODOLOGY_CONTEXT[topic];

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 pt-3 text-xs text-muted-foreground",
        className,
      )}
    >
      <MethodologyLinks item={item} showVersion={showVersion} />
      {showWorkToggle ? <ShowYourWorkToggle /> : null}
      {trailing ? <span className="ml-auto">{trailing}</span> : null}
    </div>
  );
}
