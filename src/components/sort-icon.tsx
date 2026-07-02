"use client";

import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

interface SortIconProps {
  columnKey: string;
  sortKey: string;
  sortDirection: "asc" | "desc";
}

export function SortIcon({ columnKey, sortKey, sortDirection }: SortIconProps) {
  if (sortKey !== columnKey) return <ArrowUpDown className="ml-1 inline h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />;
  return sortDirection === "asc" ? (
    <ArrowUp className="ml-1 inline h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />
  ) : (
    <ArrowDown className="ml-1 inline h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />
  );
}
