import * as React from "react";

import { cn } from "@/lib/utils";

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

export function TableRow({
  className,
  ...props
}: React.ComponentProps<"tr">) {
  return (
    <tr
      {...props}
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted",
        className,
      )}
    />
  );
}

export function TableHead({
  className,
  ...props
}: React.ComponentProps<"th">) {
  return (
    <th
      {...props}
      data-slot="table-head"
      className={cn(
        "h-10 whitespace-nowrap px-3 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
    />
  );
}

export function TableCell({
  className,
  ...props
}: React.ComponentProps<"td">) {
  return (
    <td
      {...props}
      data-slot="table-cell"
      className={cn(
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
