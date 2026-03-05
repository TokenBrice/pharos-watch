"use client";

import { TableRow } from "@/components/ui/table";

interface InteractiveTableRowProps {
  onActivate: () => void;
  onHover?: () => void;
  className?: string;
  role?: React.AriaRole;
  children: React.ReactNode;
}

export function InteractiveTableRow({
  onActivate,
  onHover,
  className = "",
  role,
  children,
}: InteractiveTableRowProps) {
  return (
    <TableRow
      className={`cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none ${className}`}
      onClick={onActivate}
      onMouseEnter={onHover}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      tabIndex={0}
      role={role}
    >
      {children}
    </TableRow>
  );
}
