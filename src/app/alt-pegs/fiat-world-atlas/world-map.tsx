"use client";

import { useEffect, useState } from "react";

const STYLE_BLOCK = `
.fiat-world-map{--world-default-fill:oklch(0.79 0.015 248 / 1);--world-stroke:oklch(0.48 0.02 248 / 0.58)}
.dark .fiat-world-map{--world-default-fill:oklch(0.22 0.014 248 / 1);--world-stroke:oklch(0.62 0.02 248 / 0.55)}
.fiat-world-map .world-countries{stroke-width:0.7}
`;

export function WorldMap() {
  const [worldSvg, setWorldSvg] = useState("");

  useEffect(() => {
    let cancelled = false;

    fetch("/maps/world-countries.svg")
      .then((response) => response.ok ? response.text() : "")
      .then((svg) => {
        if (!cancelled) setWorldSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setWorldSvg("");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="fiat-world-map relative h-full w-full" aria-hidden="true">
      <style>{STYLE_BLOCK}</style>
      <div className="[&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: worldSvg }} />
    </div>
  );
}
