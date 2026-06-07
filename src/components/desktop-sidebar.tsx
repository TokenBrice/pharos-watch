"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const Sidebar = dynamic(() => import("@/components/sidebar").then((mod) => mod.Sidebar), {
  ssr: false,
});

function useDesktopViewport() {
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const sync = () => setDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return desktop;
}

export function DesktopSidebar() {
  return useDesktopViewport() ? <Sidebar /> : null;
}
