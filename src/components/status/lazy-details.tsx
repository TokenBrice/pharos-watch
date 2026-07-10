"use client";

import { useState, type DetailsHTMLAttributes, type ReactNode } from "react";

interface LazyDetailsProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "open"> {
  summary: ReactNode;
  children: ReactNode;
}

/**
 * Native `<details>` disclosure that mounts its content only while open, so
 * collapsed sections do not keep large hidden subtrees in the DOM. Use for
 * deep evidence (healthy tables, metadata dumps) that most operators never
 * expand.
 */
export function LazyDetails({ summary, children, onToggle, ...detailsProps }: LazyDetailsProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <details
      {...detailsProps}
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open);
        onToggle?.(event);
      }}
    >
      {summary}
      {isOpen ? children : null}
    </details>
  );
}
