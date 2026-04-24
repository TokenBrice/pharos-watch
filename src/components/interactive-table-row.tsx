"use client";

import { TableRow } from "@/components/ui/table";

interface InteractiveTableRowProps {
  id?: string;
  onActivate: () => void;
  onHover?: () => void;
  className?: string;
  role?: React.AriaRole;
  ariaLabel?: string;
  children: React.ReactNode;
}

export function InteractiveTableRow({
  id,
  onActivate,
  onHover,
  className = "",
  role,
  ariaLabel,
  children,
}: InteractiveTableRowProps) {
  return (
    <TableRow
      id={id}
      className={`cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${className}`}
      onClick={onActivate}
      onMouseEnter={onHover}
      onFocus={onHover}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      tabIndex={0}
      role={role}
      aria-label={ariaLabel}
    >
      {children}
    </TableRow>
  );
}
