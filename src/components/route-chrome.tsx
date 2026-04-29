"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

function isPharosVillePath(pathname: string | null) {
  return pathname === "/pharosville" || pathname?.startsWith("/pharosville/") === true;
}

export function RouteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isPharosVillePath(pathname)) return null;
  return children;
}
