import * as React from "react";

import type { TableId } from "./types";

function labelizeTableId(tableId: TableId): string {
  return tableId
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function withFallbackTableAriaLabel<T extends Omit<React.ComponentProps<"table">, "children" | "className">>(
  tableId: TableId | undefined,
  tableProps: T | undefined,
  options: { hasCaption?: boolean } = {},
): T | undefined {
  if (!tableId) return tableProps;
  if (options.hasCaption) return tableProps;
  if (tableProps?.["aria-label"] || tableProps?.["aria-labelledby"]) return tableProps;
  return {
    ...tableProps,
    "aria-label": `${labelizeTableId(tableId)} table`,
  } as T;
}

export function resolveTableFrameProps<T extends Omit<React.ComponentProps<"table">, "children" | "className">>(
  tableId: TableId | undefined,
  tableProps: T | undefined,
  children: React.ReactNode,
): T | undefined {
  return withFallbackTableAriaLabel(tableId, tableProps, { hasCaption: hasTableCaptionChild(children) });
}

function hasTableCaptionChild(children: React.ReactNode): boolean {
  let found = false;

  function visit(child: React.ReactNode) {
    if (found || !React.isValidElement(child)) return;
    const type = child.type;
    if (type === "caption") {
      found = true;
      return;
    }
    // Rely solely on displayName (set explicitly on TableCaption); `type.name`
    // is mangled in minified production builds. Any HOC wrapping TableCaption
    // must forward `displayName = "TableCaption"` for caption detection to work.
    const displayName = typeof type === "function"
      ? (type as { displayName?: string }).displayName
      : undefined;
    if (displayName === "TableCaption") {
      found = true;
      return;
    }

    const props = child.props as { children?: React.ReactNode };
    if (props.children != null) {
      React.Children.forEach(props.children, visit);
    }
  }

  React.Children.forEach(children, visit);
  return found;
}
