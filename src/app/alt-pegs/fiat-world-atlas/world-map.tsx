"use client";

import { useEffect, useRef } from "react";

const STYLE_BLOCK = `
.fiat-world-map{--world-default-fill:oklch(0.79 0.015 248 / 1);--world-stroke:oklch(0.48 0.02 248 / 0.58)}
.dark .fiat-world-map{--world-default-fill:oklch(0.22 0.014 248 / 1);--world-stroke:oklch(0.62 0.02 248 / 0.55)}
.fiat-world-map svg{display:block;width:100%;height:100%}
.fiat-world-map .world-countries{stroke-width:0.7}
`;

// Sanitize parsed SVG: strip <script> elements and on* event-handler attributes.
// Defense-in-depth against a poisoned /maps/world-countries.svg response.
function sanitizeSvg(root: Element): void {
  root.querySelectorAll("script").forEach((el) => el.remove());
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = root;
  while (node) {
    if (node instanceof Element) {
      for (const attr of Array.from(node.attributes)) {
        if (attr.name.toLowerCase().startsWith("on")) node.removeAttribute(attr.name);
      }
    }
    node = walker.nextNode();
  }
}

export function WorldMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    fetch("/maps/world-countries.svg")
      .then((response) => response.ok ? response.text() : "")
      .then((text) => {
        if (cancelled || !text) return;
        // Parse via DOMParser into an isolated XML document, sanitize, then
        // adopt the <svg> node. Avoids `dangerouslySetInnerHTML` entirely.
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        const svg = doc.documentElement;
        if (!svg || svg.nodeName.toLowerCase() !== "svg") return;
        sanitizeSvg(svg);
        host.replaceChildren(host.ownerDocument.importNode(svg, true));
      })
      .catch(() => {
        // swallow: empty atlas is acceptable fallback
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="fiat-world-map relative h-full w-full" aria-hidden="true">
      <style>{STYLE_BLOCK}</style>
      <div
        ref={hostRef}
        className="h-full w-full overflow-hidden [&_svg]:block [&_svg]:h-full [&_svg]:w-full"
      />
    </div>
  );
}
