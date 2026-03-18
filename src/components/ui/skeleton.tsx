import { cn } from "@/lib/utils"

interface SkeletonProps extends React.ComponentProps<"div"> {
  variant?: "default" | "shimmer"
}

function Skeleton({ className, variant = "default", ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "rounded-md",
        variant === "shimmer" ? "skeleton-shimmer" : "bg-accent animate-pulse",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
