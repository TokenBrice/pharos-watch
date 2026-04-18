"use client";

import Link from "next/link";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

/**
 * Small shared breadcrumb for deep routes. Each item renders as a link when
 * `href` is present; the last item is the current page and renders as plain
 * text with aria-current="page". Separator is a literal "/" to stay light.
 */
export function Breadcrumb({ items, className }: BreadcrumbProps) {
  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className={`flex items-center gap-1.5 text-xs text-muted-foreground sm:text-sm${className ? ` ${className}` : ""}`}
    >
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, idx) => {
          const isLast = idx === items.length - 1;
          const separator = idx > 0 ? <span className="text-muted-foreground/60" aria-hidden="true">/</span> : null;
          const content = isLast ? (
            <span className="text-foreground" aria-current="page">
              {item.label}
            </span>
          ) : item.href ? (
            <Link
              href={item.href}
              className="pharos-focus-ring rounded-sm transition-colors hover:text-foreground"
            >
              {item.label}
            </Link>
          ) : (
            <span>{item.label}</span>
          );

          return (
            <li key={`${item.label}-${idx}`} className="flex items-center gap-1.5">
              {separator}
              {content}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
