"use client";

import { usePathname } from "next/navigation";
import { HomepageTape } from "@/components/homepage-tape";
import { useSidebar } from "@/components/sidebar";

export function HomepageTopTape() {
  const pathname = usePathname();
  const { expanded } = useSidebar();

  if (pathname !== "/") return null;

  return (
    <div
      style={{
        ["--pharos-homepage-tape-offset" as string]: expanded
          ? "var(--sidebar-width-expanded)"
          : "var(--sidebar-width-collapsed)",
      }}
    >
      <HomepageTape placement="top" />
    </div>
  );
}
