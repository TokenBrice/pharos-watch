"use client";

import { useState, type ComponentProps } from "react";
import Link from "next/link";

type IntentLinkProps = Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & { href: string };

/** Secondary routes prefetch only after pointer or keyboard intent; hash jumps never do. */
export function IntentLink({ href, onMouseEnter, onFocus, ...props }: IntentLinkProps) {
  const [hasIntent, setHasIntent] = useState(false);
  return (
    <Link
      {...props}
      href={href}
      prefetch={hasIntent && !href.startsWith("#") ? null : false}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        if (!event.defaultPrevented) setHasIntent(true);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) setHasIntent(true);
      }}
    />
  );
}
