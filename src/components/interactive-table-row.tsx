"use client";

import { TableRow } from "@/components/table";

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
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const control = event.target instanceof Element
          ? event.target.closest('a,button,input,select,textarea,summary,[role="button"],[role="link"],[contenteditable]:not([contenteditable="false"]),[tabindex]')
          : null;
        if (control && event.currentTarget.contains(control)) return;
        onActivate();
      }}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      {children}
    </TableRow>
  );
}
