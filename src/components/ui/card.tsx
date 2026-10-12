import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * `variant="shell"` emits the `.pharos-card-shell` treatment (shared card
 * background, border, and elevation tokens): the default framed analytics
 * surface. `default` stays the plain structural primitive.
 */
function Card({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { variant?: "default" | "shell" }) {
  return (
    <div
      data-slot="card"
      data-variant={variant === "shell" ? "shell" : undefined}
      className={cn(
        variant === "shell"
          ? "pharos-card-shell text-card-foreground flex flex-col gap-4 py-4"
          : "bg-card text-card-foreground flex flex-col gap-4 rounded-xl border py-4",
        className
      )}
      {...props}
    />
  )
}

interface CardHeaderStandardProps {
  /** Optional category eyebrow above the heading (`.pharos-label`). */
  kicker?: React.ReactNode
  /** Panel heading at the one fixed card-title size (`.pharos-section-title`). */
  heading?: React.ReactNode
  headingAs?: "h2" | "h3" | "h4"
  /** One supporting line under the heading. */
  description?: React.ReactNode
  /** Right slot: actions or meta (expand link, toggle, share). */
  actions?: React.ReactNode
  /** Freshness line ("Updated every 30 min", "as of …"): always top-right, under actions. */
  freshness?: React.ReactNode
}

/**
 * Two modes. Pass `heading` for the standard card-header grammar: optional
 * kicker, fixed-size heading and optional description on the left; actions and
 * freshness stacked top-right. Without `heading` it is the legacy shadcn grid
 * composed from `CardTitle` / `CardDescription` / `CardAction` children.
 */
function CardHeader({
  className,
  kicker,
  heading,
  headingAs: Heading = "h2",
  description,
  actions,
  freshness,
  children,
  ...props
}: React.ComponentProps<"div"> & CardHeaderStandardProps) {
  if (heading != null) {
    return (
      <div
        data-slot="card-header"
        className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4", className)}
        {...props}
      >
        <div className="min-w-0 space-y-1">
          {kicker != null ? <p className="pharos-label">{kicker}</p> : null}
          <Heading className="pharos-section-title">{heading}</Heading>
          {description != null ? <p className="pharos-meta">{description}</p> : null}
        </div>
        {actions != null || freshness != null ? (
          <div className="flex shrink-0 flex-col items-end gap-1 text-right">
            {actions}
            {freshness != null ? <p className="pharos-meta">{freshness}</p> : null}
          </div>
        ) : null}
        {children}
      </div>
    )
  }

  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function CardTitle({
  className,
  as: Comp = "div",
  ...props
}: React.ComponentProps<"div"> & { as?: "h1" | "h2" | "h3" | "h4" | "div" }) {
  return (
    <Comp
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 min-w-0 max-w-full self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-4 [.border-t]:pt-4", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
