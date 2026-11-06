"use client";

import { TableRow } from "@/components/table";
import { isRowActivation } from "@/lib/row-activation";

interface InteractiveTableRowProps {
  id?: string;
  onActivate: () => void;
  onHover?: () => void;
  className?: string;
  children: React.ReactNode;
}

export function InteractiveTableRow({
  id,
  onActivate,
  onHover,
  className = "",
  children,
}: InteractiveTableRowProps) {
  return (
    <TableRow
      id={id}
      className={`cursor-pointer ${className}`}
      onClick={(event) => {
        if (isRowActivation(event)) onActivate();
      }}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      {children}
    </TableRow>
  );
}
