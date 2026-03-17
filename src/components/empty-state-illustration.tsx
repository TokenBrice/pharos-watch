"use client";

import { cn } from "@/lib/utils";

interface EmptyStateIllustrationProps {
  variant?: "search" | "data" | "error";
  className?: string;
}

/**
 * Pharos-branded empty state illustration.
 * Uses a lighthouse beam motif that aligns with the brand identity.
 */
export function EmptyStateIllustration({ variant = "search", className }: EmptyStateIllustrationProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-8", className)}>
      <svg
        width="120"
        height="120"
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="mb-4"
        aria-hidden="true"
      >
        {/* Outer glow */}
        <circle cx="60" cy="60" r="50" className="fill-muted/30" />
        
        {/* Lighthouse base */}
        <path
          d="M52 95 L55 55 L65 55 L68 95 Z"
          className="fill-muted-foreground/40 stroke-muted-foreground/60"
          strokeWidth="1"
        />
        
        {/* Lighthouse top */}
        <ellipse
          cx="60"
          cy="55"
          rx="8"
          ry="4"
          className="fill-muted-foreground/30 stroke-muted-foreground/50"
          strokeWidth="1"
        />
        
        {/* Light beam - animated */}
        <path
          d="M60 55 L20 35 L25 45 L60 55"
          className="fill-primary/20"
        >
          <animate
            attributeName="opacity"
            values="0.3;0.6;0.3"
            dur="3s"
            repeatCount="indefinite"
          />
        </path>
        
        {/* Light source */}
        <circle cx="60" cy="55" r="3" className="fill-primary/60">
          <animate
            attributeName="opacity"
            values="0.6;1;0.6"
            dur="3s"
            repeatCount="indefinite"
          />
        </circle>
        
        {/* Water line */}
        <path
          d="M20 95 Q40 92 60 95 Q80 98 100 95"
          className="stroke-muted-foreground/30"
          strokeWidth="2"
          fill="none"
        />
        
        {/* Stars */}
        <circle cx="25" cy="25" r="1" className="fill-muted-foreground/40">
          <animate attributeName="opacity" values="0.3;1;0.3" dur="4s" repeatCount="indefinite" />
        </circle>
        <circle cx="85" cy="20" r="1" className="fill-muted-foreground/40">
          <animate attributeName="opacity" values="0.3;1;0.3" dur="5s" repeatCount="indefinite" />
        </circle>
        <circle cx="95" cy="40" r="0.8" className="fill-muted-foreground/40">
          <animate attributeName="opacity" values="0.3;1;0.3" dur="3.5s" repeatCount="indefinite" />
        </circle>
      </svg>
      
      {variant === "search" && (
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          No stablecoins match your search. Try different terms or clear filters.
        </p>
      )}
      {variant === "data" && (
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          No data available. Check back soon or try refreshing.
        </p>
      )}
      {variant === "error" && (
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          Something went wrong loading this data. Please try again.
        </p>
      )}
    </div>
  );
}
