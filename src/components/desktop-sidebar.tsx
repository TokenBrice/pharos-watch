"use client";

import dynamic from "next/dynamic";
import { useIsMobile } from "@/hooks/use-is-mobile";

const Sidebar = dynamic(() => import("@/components/sidebar").then((mod) => mod.Sidebar), {
  ssr: false,
});

export function DesktopSidebar() {
  return useIsMobile(1024) ? null : <Sidebar />;
}
