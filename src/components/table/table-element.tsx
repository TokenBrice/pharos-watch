import * as React from "react";

import { cn } from "@/lib/utils";

import type { TableRowIntent } from "./types";

export function TableElement({
  className,
  ...props
}: React.ComponentProps<"table">) {
  return (
    <table
      {...props}
      data-slot="table"
      className={cn("w-full caption-bottom text-sm", className)}
    />
  );
}

export function TableHeader({
  className,
  ...props
}: React.ComponentProps<"thead">) {
  return (
    <thead
      {...props}
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
    />
  );
}

export function TableBody({
  className,
  ...props
}: React.ComponentProps<"tbody">) {
  return (
    <tbody
      {...props}
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
    />
  );
}

export interface TableRowProps extends React.ComponentProps<"tr"> {
  rowIntent?: TableRowIntent;
  /** Skip the shared row utilities when the owning table already styles its rows. */
  lean?: boolean;
}

export function TableRow({
  className,
  rowIntent = "interactive",
  lean = false,
  ...props
}: TableRowProps) {
  return (
    <tr
      {...props}
      data-slot="table-row"
      data-row-intent={rowIntent}
      className={lean ? className : cn(
        "border-b transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted",
        className,
      )}
    />
  );
}

export interface TableHeadProps extends React.ComponentProps<"th"> {
  /** Skip the shared cell utilities when the owning table already styles its cells. */
  lean?: boolean;
}

export function TableHead({
  className,
  lean = false,
  ...props
}: TableHeadProps) {
  return (
    <th
      {...props}
      data-slot="table-head"
      className={lean ? className : cn(
        "h-10 whitespace-nowrap px-3 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
    />
  );
}

export interface TableCellProps extends React.ComponentProps<"td"> {
  /** Skip the shared cell utilities when the owning table already styles its cells. */
  lean?: boolean;
}

export function TableCell({
  className,
  lean = false,
  ...props
}: TableCellProps) {
  return (
    <td
      {...props}
      data-slot="table-cell"
      className={lean ? className : cn(
        "whitespace-nowrap px-3 py-2 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
    />
  );
}

export function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      {...props}
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
    />
  );
}

TableCaption.displayName = "TableCaption";
