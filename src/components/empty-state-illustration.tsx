"use client";

import { Search, BarChart3, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateIllustrationProps {
  variant?: "search" | "data" | "error";
  title?: string;
  description?: string;
  className?: string;
}

const icons = {
  search: Search,
  data: BarChart3,
  error: AlertCircle,
};

const defaults = {
  search: {
    title: "No results found",
    description: "Try adjusting your search terms or clearing filters to see more stablecoins.",
  },
  data: {
    title: "No data available",
    description: "We're still gathering data for this section. Check back soon for updates.",
  },
  error: {
    title: "Failed to load data",
    description: "Something went wrong while fetching the data. Please try refreshing the page.",
  },
};

/**
 * Pharos-branded empty state illustration.
 * Uses frost-blue accent to align with brand identity.
 */
export function EmptyStateIllustration({
  variant = "search",
  title,
  description,
  className,
}: EmptyStateIllustrationProps) {
  const Icon = icons[variant];
  const defaultContent = defaults[variant];

  return (
    <div className={cn("flex flex-col items-center justify-center py-10 text-center", className)}>
      {/* Icon container with frost-blue accent */}
      <div className="relative mb-4">
        {/* Background glow */}
        <div 
          className="absolute inset-0 rounded-full blur-xl opacity-30"
          style={{ 
            background: 'radial-gradient(circle at center, var(--brand-accent), transparent 70%)',
            transform: 'scale(1.5)'
          }}
        />
        {/* Icon container */}
        <div className="relative rounded-full border border-[var(--brand-accent)]/20 bg-[var(--brand-accent)]/5 p-4">
          <Icon 
            className="h-8 w-8 text-[var(--brand-accent)]" 
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Text content */}
      <h3 className="text-base font-semibold text-foreground">
        {title || defaultContent.title}
      </h3>
      <p className="mt-1.5 max-w-[280px] text-sm text-muted-foreground leading-relaxed">
        {description || defaultContent.description}
      </p>
    </div>
  );
}
