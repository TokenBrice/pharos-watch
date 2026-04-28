"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { DesktopOnlyFallback } from "./desktop-only-fallback";
import "./pharosville.css";

const DESKTOP_QUERY = "(min-width: 1280px) and (min-height: 760px)";

const PharosVilleDesktopData = dynamic(
  () => import("./pharosville-desktop-data").then((mod) => ({ default: mod.PharosVilleDesktopData })),
  {
    ssr: false,
    loading: () => (
      <div className="pharosville-loading pharosville-desktop" aria-busy="true">
        Preparing PharosVille
      </div>
    ),
  },
);

function useDesktopViewport() {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);

  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const sync = () => setIsDesktop(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return isDesktop;
}

export function PharosVilleClient() {
  const isDesktop = useDesktopViewport();

  if (isDesktop === null) {
    return (
      <>
        <DesktopOnlyFallback />
        <div className="pharosville-loading pharosville-desktop" aria-busy="true">Preparing PharosVille</div>
      </>
    );
  }
  if (!isDesktop) return <DesktopOnlyFallback />;

  return <PharosVilleDesktopData />;
}
