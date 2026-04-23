# Alt-Pegs World Map Refactor — Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is committed independently.

**Goal:** Replace the stylized-blob "Fiat Peg Geography" atlas in `src/app/alt-pegs/static-link-hub.tsx` with a real country-level world map, and fold Gold / Silver / CPI cohorts into the same card as a symbolic "celestial band" above the map.

**Architecture:** Pre-rendered static SVG of 1:110m Natural Earth country geometry, inlined at build time, colored per country via generated `<style>` rules derived from a peg → ISO-2 map. Gold / Silver / CPI render as inline-SVG orbital bodies above the map. Zero runtime map dependencies; `d3-geo` + `topojson-client` are dev-only for the one-shot build script.

**Tech Stack:** Next.js 16 static export, React, TypeScript, Tailwind, Vitest + Testing Library. New dev deps: `d3-geo`, `topojson-client`, `@types/d3-geo`, `@types/topojson-client`.

**Reference design:** `agents/specs/2026-04-23-alt-pegs-world-map-design.md`.

---

## Phase layout

- **Phase 1** (foundation, sequential): data layer + SVG pipeline. Subagent must commit each task independently before the next starts.
- **Phase 2** (primitives, **parallelizable across subagents**): world-map, celestial-band, region-chips, mobile-region-list components. All depend on Phase 1; none depend on each other.
- **Phase 3** (integration, sequential): top-level atlas assembly, static-link-hub swap, test + docs updates, visual QA.

---

## Task 1: Data layer — peg → country mapping

**Files:**
- Create: `src/lib/alt-peg-geography.ts`
- Create: `src/lib/__tests__/alt-peg-geography.test.ts`

- [ ] **Step 1.1 — Write `alt-peg-geography.ts`**

Content:

```ts
import type { PegCurrency } from "@shared/types";
import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";

export type Iso2 = string;

/**
 * ISO-3166-1 alpha-2 countries where each fiat peg is the reference currency.
 * Extend when a new fiat peg is added to the taxonomy — the geography test
 * enforces coverage for every `AltPegRegion !== "Other"` fiat peg.
 */
export const PEG_COUNTRY_MAP: Partial<Record<PegCurrency, readonly Iso2[]>> = {
  EUR: ["DE","FR","IT","ES","NL","BE","AT","PT","IE","FI","GR","SK","SI","LU","EE","LV","LT","CY","MT","HR"],
  CHF: ["CH","LI"],
  GBP: ["GB"],
  RUB: ["RU"],
  TRY: ["TR"],
  JPY: ["JP"],
  IDR: ["ID"],
  SGD: ["SG"],
  CNH: ["CN","HK"],
  PHP: ["PH"],
  BRL: ["BR"],
  CAD: ["CA"],
  MXN: ["MX"],
  ZAR: ["ZA"],
  AUD: ["AU"],
};

export interface CountryFill {
  peg: PegCurrency;
  colorHex: string;
}

/**
 * Builds a Map<ISO-A2, CountryFill> from the taxonomy-driven link-hub items.
 * Only fiat pegs present in PEG_COUNTRY_MAP participate. The item's own
 * colorHex (from PEG_CHART_COLORS) is propagated to each country it covers.
 */
export function buildCountryColorMap(
  items: readonly AltPegLinkHubItem[],
): ReadonlyMap<Iso2, CountryFill> {
  const result = new Map<Iso2, CountryFill>();
  for (const item of items) {
    const countries = PEG_COUNTRY_MAP[item.peg];
    if (!countries) continue;
    for (const iso of countries) {
      result.set(iso, { peg: item.peg, colorHex: item.colorHex });
    }
  }
  return result;
}
```

- [ ] **Step 1.2 — Write `alt-peg-geography.test.ts`**

Content:

```ts
import { describe, expect, it } from "vitest";
import { PEG_COUNTRY_MAP, buildCountryColorMap } from "@/lib/alt-peg-geography";
import { buildAltPegLinkHubGroups } from "@/lib/alt-peg-market";

describe("PEG_COUNTRY_MAP", () => {
  it("covers every tracked fiat peg whose region is not 'Other'", () => {
    const fiatItems = buildAltPegLinkHubGroups()
      .find((group) => group.label === "Fiat")
      ?.items ?? [];
    const uncovered = fiatItems
      .filter((item) => item.region !== "Other")
      .filter((item) => !PEG_COUNTRY_MAP[item.peg])
      .map((item) => item.peg);
    expect(uncovered).toEqual([]);
  });

  it("uses unique ISO-A2 codes per peg", () => {
    const allCountries: string[] = [];
    for (const list of Object.values(PEG_COUNTRY_MAP)) {
      if (!list) continue;
      for (const iso of list) allCountries.push(iso);
    }
    const duplicates = allCountries.filter(
      (iso, index) => allCountries.indexOf(iso) !== index,
    );
    expect(duplicates).toEqual([]);
  });
});

describe("buildCountryColorMap", () => {
  it("propagates the item colorHex to every country the peg covers", () => {
    const items = [
      { peg: "EUR", colorHex: "#8b5cf6" },
      { peg: "JPY", colorHex: "#f43f5e" },
    ] as Parameters<typeof buildCountryColorMap>[0];

    const result = buildCountryColorMap(items);
    expect(result.get("DE")).toEqual({ peg: "EUR", colorHex: "#8b5cf6" });
    expect(result.get("FR")).toEqual({ peg: "EUR", colorHex: "#8b5cf6" });
    expect(result.get("JP")).toEqual({ peg: "JPY", colorHex: "#f43f5e" });
    expect(result.has("US")).toBe(false);
  });

  it("skips pegs with no country mapping", () => {
    const items = [
      { peg: "OTHER", colorHex: "#64748b" },
    ] as Parameters<typeof buildCountryColorMap>[0];
    expect(buildCountryColorMap(items).size).toBe(0);
  });
});
```

- [ ] **Step 1.3 — Run the tests, verify green**

Run: `npm test -- src/lib/__tests__/alt-peg-geography.test.ts`
Expected: 4 tests pass.

- [ ] **Step 1.4 — Commit**

```bash
git add src/lib/alt-peg-geography.ts src/lib/__tests__/alt-peg-geography.test.ts
git commit -m "feat(alt-pegs): peg-to-country geography map and color builder"
```

---

## Task 2: SVG build pipeline

**Files:**
- Create: `scripts/data/world-countries-110m.json` (checked-in Natural Earth TopoJSON)
- Create: `scripts/build-world-map-svg.ts`
- Create: `public/maps/world-countries.svg` (generated, checked in)
- Modify: `package.json` (dev deps + `"build:world-map"` script)

- [ ] **Step 2.1 — Add dev dependencies**

Run:

```bash
npm install --save-dev d3-geo topojson-client @types/d3-geo @types/topojson-client
```

- [ ] **Step 2.2 — Fetch and check in Natural Earth TopoJSON**

Run:

```bash
mkdir -p scripts/data
curl -fsSL https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json \
  -o scripts/data/world-countries-110m.json
```

Verify: file is ~100KB and `jq '.type' scripts/data/world-countries-110m.json` returns `"Topology"`.

Note: `world-atlas` TopoJSON identifies countries by numeric M49 codes. Task 2.3's build script maps those to ISO-A2 via a checked-in lookup table.

- [ ] **Step 2.3 — Write the build script**

Content of `scripts/build-world-map-svg.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry, GeoJsonProperties } from "geojson";
import type { Topology } from "topojson-specification";
import { M49_TO_ISO2 } from "./data/m49-to-iso2";

const SRC = resolve("scripts/data/world-countries-110m.json");
const OUT = resolve("public/maps/world-countries.svg");
const WIDTH = 900;
const HEIGHT = 460;

const topology = JSON.parse(readFileSync(SRC, "utf8")) as Topology;
const countries = feature(
  topology,
  topology.objects.countries as Topology["objects"][string],
) as FeatureCollection<Geometry, GeoJsonProperties>;

const projection = geoNaturalEarth1()
  .fitExtent([[4, 4], [WIDTH - 4, HEIGHT - 24]], countries); // crop antarctica visually
const path = geoPath(projection);

const paths: string[] = [];
for (const feat of countries.features) {
  const id = typeof feat.id === "string" ? feat.id : String(feat.id);
  const iso2 = M49_TO_ISO2[id];
  if (!iso2) continue; // skip unmapped entities (e.g. Antarctica, small dependencies)
  const d = path(feat);
  if (!d) continue;
  paths.push(`<path id="${iso2}" d="${d}" />`);
}

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="World map">`,
  `<g class="world-countries" fill="var(--world-default-fill)" stroke="var(--world-stroke)" stroke-width="0.5" stroke-linejoin="round">`,
  paths.join(""),
  `</g>`,
  `</svg>`,
].join("\n");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`Wrote ${paths.length} countries to ${OUT}`);
```

- [ ] **Step 2.4 — Create the M49 → ISO-2 lookup**

Content of `scripts/data/m49-to-iso2.ts`:

```ts
/** UN M49 numeric code → ISO-3166-1 alpha-2. */
/** Limited to countries present in world-atlas 1:110m and the alt-peg geography. */
/** Extend as new fiat pegs are added. */
export const M49_TO_ISO2: Record<string, string> = {
  "004":"AF","008":"AL","010":"AQ","012":"DZ","016":"AS","020":"AD","024":"AO","028":"AG","031":"AZ","032":"AR",
  "036":"AU","040":"AT","044":"BS","048":"BH","050":"BD","051":"AM","052":"BB","056":"BE","060":"BM","064":"BT",
  "068":"BO","070":"BA","072":"BW","076":"BR","084":"BZ","090":"SB","092":"VG","096":"BN","100":"BG","104":"MM",
  "108":"BI","112":"BY","116":"KH","120":"CM","124":"CA","132":"CV","136":"KY","140":"CF","144":"LK","148":"TD",
  "152":"CL","156":"CN","158":"TW","170":"CO","174":"KM","175":"YT","178":"CG","180":"CD","184":"CK","188":"CR",
  "191":"HR","192":"CU","196":"CY","203":"CZ","204":"BJ","208":"DK","212":"DM","214":"DO","218":"EC","222":"SV",
  "226":"GQ","231":"ET","232":"ER","233":"EE","234":"FO","238":"FK","242":"FJ","246":"FI","250":"FR","254":"GF",
  "258":"PF","260":"TF","262":"DJ","266":"GA","268":"GE","270":"GM","275":"PS","276":"DE","288":"GH","292":"GI",
  "296":"KI","300":"GR","304":"GL","308":"GD","312":"GP","316":"GU","320":"GT","324":"GN","328":"GY","332":"HT",
  "334":"HM","336":"VA","340":"HN","344":"HK","348":"HU","352":"IS","356":"IN","360":"ID","364":"IR","368":"IQ",
  "372":"IE","376":"IL","380":"IT","384":"CI","388":"JM","392":"JP","398":"KZ","400":"JO","404":"KE","408":"KP",
  "410":"KR","414":"KW","417":"KG","418":"LA","422":"LB","426":"LS","428":"LV","430":"LR","434":"LY","438":"LI",
  "440":"LT","442":"LU","446":"MO","450":"MG","454":"MW","458":"MY","462":"MV","466":"ML","470":"MT","474":"MQ",
  "478":"MR","480":"MU","484":"MX","492":"MC","496":"MN","498":"MD","499":"ME","500":"MS","504":"MA","508":"MZ",
  "512":"OM","516":"NA","520":"NR","524":"NP","528":"NL","540":"NC","548":"VU","554":"NZ","558":"NI","562":"NE",
  "566":"NG","570":"NU","574":"NF","578":"NO","580":"MP","581":"UM","583":"FM","584":"MH","585":"PW","586":"PK",
  "591":"PA","598":"PG","600":"PY","604":"PE","608":"PH","612":"PN","616":"PL","620":"PT","624":"GW","626":"TL",
  "630":"PR","634":"QA","638":"RE","642":"RO","643":"RU","646":"RW","652":"BL","654":"SH","659":"KN","660":"AI",
  "662":"LC","663":"MF","666":"PM","670":"VC","674":"SM","678":"ST","682":"SA","686":"SN","688":"RS","690":"SC",
  "694":"SL","702":"SG","703":"SK","704":"VN","705":"SI","706":"SO","710":"ZA","716":"ZW","724":"ES","728":"SS",
  "729":"SD","732":"EH","740":"SR","744":"SJ","748":"SZ","752":"SE","756":"CH","760":"SY","762":"TJ","764":"TH",
  "768":"TG","772":"TK","776":"TO","780":"TT","784":"AE","788":"TN","792":"TR","795":"TM","796":"TC","798":"TV",
  "800":"UG","804":"UA","807":"MK","818":"EG","826":"GB","831":"GG","832":"JE","833":"IM","834":"TZ","840":"US",
  "850":"VI","854":"BF","858":"UY","860":"UZ","862":"VE","876":"WF","882":"WS","887":"YE","894":"ZM",
};
```

- [ ] **Step 2.5 — Wire the npm script**

Edit `package.json` scripts (insert alongside existing scripts):

```json
"build:world-map": "tsx scripts/build-world-map-svg.ts"
```

If `tsx` is not already a dev dep, add it: `npm install --save-dev tsx`. Verify first with `grep '"tsx"' package.json`.

- [ ] **Step 2.6 — Generate the SVG**

Run: `npm run build:world-map`
Expected: prints `Wrote N countries to .../public/maps/world-countries.svg`, N ≥ 170.

Verify: `ls -la public/maps/world-countries.svg` exists; file contains `<path id="DE"`, `<path id="JP"`, `<path id="BR"`.

- [ ] **Step 2.7 — Commit**

```bash
git add scripts/data/world-countries-110m.json scripts/data/m49-to-iso2.ts scripts/build-world-map-svg.ts public/maps/world-countries.svg package.json package-lock.json
git commit -m "build(alt-pegs): generate static world-countries SVG for map atlas"
```

---

## Task 3: `WorldMap` component

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/world-map.tsx`
- Create: `src/app/alt-pegs/fiat-world-atlas/__tests__/world-map.test.tsx`

**Depends on:** Task 1 (data layer), Task 2 (SVG).

- [ ] **Step 3.1 — Read the generated SVG at build time**

Next.js supports `import text from "./file.svg?raw"` via Turbopack, but the simplest portable route is Node's `readFileSync` at module load — this file is rendered at server/SSG time only, so `fs` is available.

Content of `world-map.tsx`:

```tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { buildCountryColorMap } from "@/lib/alt-peg-geography";

const WORLD_SVG = readFileSync(
  resolve(process.cwd(), "public/maps/world-countries.svg"),
  "utf8",
);

function buildStyleBlock(fills: ReadonlyMap<string, { colorHex: string }>): string {
  const rules: string[] = [
    `.fiat-world-map{color:oklch(0.61 0.02 248 / 0.22)}`,
    `.fiat-world-map .world-countries path{transition:fill 180ms ease}`,
    `.fiat-world-map{--world-default-fill:oklch(0.22 0.012 248 / 0.95);--world-stroke:oklch(0.45 0.02 248 / 0.55)}`,
  ];
  for (const [iso, fill] of fills) {
    rules.push(`.fiat-world-map path#${iso}{fill:${fill.colorHex};stroke:${fill.colorHex}}`);
  }
  return rules.join("");
}

export function WorldMap({ items }: { items: readonly AltPegLinkHubItem[] }) {
  const fills = buildCountryColorMap(items);
  const styleBlock = buildStyleBlock(fills);

  return (
    <div
      className="fiat-world-map relative w-full"
      aria-label="World map showing tracked fiat peg reference regions"
    >
      <style>{styleBlock}</style>
      <div
        className="[&_svg]:h-auto [&_svg]:w-full"
        dangerouslySetInnerHTML={{ __html: WORLD_SVG }}
      />
    </div>
  );
}
```

- [ ] **Step 3.2 — Write the test**

Content:

```tsx
// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";

describe("WorldMap", () => {
  it("renders country paths with the peg fill for tracked fiats", () => {
    const { container } = render(
      <WorldMap
        items={[
          { peg: "EUR", colorHex: "#8b5cf6" } as never,
          { peg: "JPY", colorHex: "#f43f5e" } as never,
        ]}
      />,
    );

    expect(container.querySelector("path#DE")).not.toBeNull();
    expect(container.querySelector("path#JP")).not.toBeNull();

    const styleBlock = container.querySelector("style")?.textContent ?? "";
    expect(styleBlock).toContain("path#DE{fill:#8b5cf6");
    expect(styleBlock).toContain("path#FR{fill:#8b5cf6");
    expect(styleBlock).toContain("path#JP{fill:#f43f5e");
    expect(styleBlock).not.toContain("path#US{fill:");
  });
});
```

- [ ] **Step 3.3 — Run the test**

Run: `npm test -- src/app/alt-pegs/fiat-world-atlas/__tests__/world-map.test.tsx`
Expected: pass.

- [ ] **Step 3.4 — Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/world-map.tsx src/app/alt-pegs/fiat-world-atlas/__tests__/world-map.test.tsx
git commit -m "feat(alt-pegs): WorldMap component renders country fills from peg taxonomy"
```

---

## Task 4: `CelestialBand` component

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/celestial-band.tsx`
- Create: `src/app/alt-pegs/fiat-world-atlas/__tests__/celestial-band.test.tsx`

**Depends on:** nothing (can run parallel with Tasks 3, 5, 6 after Task 1 commits).

- [ ] **Step 4.1 — Implement the component**

Content of `celestial-band.tsx`:

```tsx
import Link from "next/link";
import type { CSSProperties } from "react";
import type { AltPegLinkHubItem } from "@/lib/alt-peg-market";

type OrbitalKind = "sun" | "moon" | "index";

interface OrbitalBody {
  kind: OrbitalKind;
  item: AltPegLinkHubItem;
}

function pickItems(items: readonly AltPegLinkHubItem[]): OrbitalBody[] {
  const byPeg = new Map(items.map((item) => [item.peg, item]));
  const bodies: OrbitalBody[] = [];
  const gold = byPeg.get("GOLD");
  if (gold) bodies.push({ kind: "sun", item: gold });
  const silver = byPeg.get("SILVER");
  if (silver) bodies.push({ kind: "moon", item: silver });
  // Any item whose peg is not GOLD/SILVER and region === "Other" is treated
  // as an index / non-geographic reference (VAR/CPI, etc.). We aggregate
  // everything that falls through the map into a single "index" body so the
  // band remains a stable 3-slot layout.
  const index = items.filter((i) => i.peg !== "GOLD" && i.peg !== "SILVER" && i.region === "Other");
  if (index.length > 0) {
    const coinCount = index.reduce((sum, i) => sum + i.coinCount, 0);
    const symbolPreview = index.map((i) => i.symbolPreview).filter(Boolean).join(" · ");
    bodies.push({
      kind: "index",
      item: {
        ...index[0],
        label: index.length === 1 ? index[0].label : "Index-linked",
        coinCount,
        symbolPreview,
      },
    });
  }
  return bodies;
}

function bodySizePx(item: AltPegLinkHubItem, maxCoinCount: number): number {
  const emphasis = Math.sqrt(Math.max(1, item.coinCount) / Math.max(1, maxCoinCount));
  return Math.round(44 + emphasis * 44); // 44–88px
}

function Orbital({ body, maxCoinCount }: { body: OrbitalBody; maxCoinCount: number }) {
  const { kind, item } = body;
  const size = bodySizePx(item, maxCoinCount);
  const glyphStyle: CSSProperties = { width: size, height: size };

  return (
    <Link
      href={item.href}
      aria-label={`${item.label}, ${item.coinCount} coins`}
      className="pharos-focus-ring group inline-flex items-center gap-3 rounded-2xl border border-border/55 bg-background/55 px-3 py-2 transition-[background-color,border-color] hover:bg-accent/40"
      data-orbital={kind}
      data-peg={item.peg}
      data-coin-count={item.coinCount}
    >
      <span
        aria-hidden="true"
        className="relative grid place-items-center rounded-full"
        style={glyphStyle}
      >
        {kind === "sun" ? <SunGlyph color={item.colorHex} /> : null}
        {kind === "moon" ? <MoonGlyph color={item.colorHex} /> : null}
        {kind === "index" ? <IndexGlyph color={item.colorHex} /> : null}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold tracking-tight text-foreground">{item.label}</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {item.coinCount} coin{item.coinCount === 1 ? "" : "s"}
          {item.symbolPreview ? ` · ${item.symbolPreview}` : ""}
        </span>
      </span>
    </Link>
  );
}

function SunGlyph({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full">
      <defs>
        <radialGradient id="sun-grad" cx="42%" cy="38%" r="60%">
          <stop offset="0%" stopColor={`${color}ff`} />
          <stop offset="70%" stopColor={`${color}cc`} />
          <stop offset="100%" stopColor={`${color}00`} />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`${color}18`} />
      <circle cx="50" cy="50" r="32" fill="url(#sun-grad)" />
      <circle cx="50" cy="50" r="20" fill={color} />
    </svg>
  );
}

function MoonGlyph({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full">
      <circle cx="50" cy="50" r="38" fill={`${color}28`} />
      <circle cx="50" cy="50" r="26" fill={color} />
      <circle cx="42" cy="44" r="22" fill="var(--background)" opacity="0.9" />
    </svg>
  );
}

function IndexGlyph({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full">
      <circle cx="50" cy="50" r="42" fill="none" stroke={`${color}66`} strokeWidth="2" />
      <circle cx="50" cy="50" r="28" fill="none" stroke={`${color}aa`} strokeWidth="2" />
      <circle cx="50" cy="50" r="10" fill={color} />
      <circle cx="50" cy="8"  r="3" fill={color} />
      <circle cx="92" cy="50" r="3" fill={color} />
      <circle cx="50" cy="92" r="3" fill={color} />
      <circle cx="8"  cy="50" r="3" fill={color} />
    </svg>
  );
}

export function CelestialBand({ items }: { items: readonly AltPegLinkHubItem[] }) {
  const bodies = pickItems(items);
  if (bodies.length === 0) return null;
  const maxCoinCount = Math.max(1, ...bodies.map((b) => b.item.coinCount));

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border/55 px-4 py-3 sm:px-5 sm:py-4"
         data-testid="celestial-band">
      <p className="mr-auto text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        References beyond geography
      </p>
      {bodies.map((body) => (
        <Orbital key={body.kind} body={body} maxCoinCount={maxCoinCount} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4.2 — Write the test**

Content:

```tsx
// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CelestialBand } from "@/app/alt-pegs/fiat-world-atlas/celestial-band";

const items = [
  { peg: "GOLD",   label: "Gold",   href: "/stablecoins/gold",   coinCount: 8, symbolPreview: "XAUT · PAXG · KAU", group: "Commodity", region: "Other", colorHex: "#eab308" },
  { peg: "SILVER", label: "Silver", href: "/stablecoins/silver", coinCount: 1, symbolPreview: "KAG",              group: "Commodity", region: "Other", colorHex: "#9ca3af" },
  { peg: "VAR",    label: "CPI",    href: "/stablecoins/cpi",    coinCount: 3, symbolPreview: "FPI · ISC · SILK", group: "Other",     region: "Other", colorHex: "#64748b" },
] as never;

describe("CelestialBand", () => {
  it("renders Gold, Silver, and Index orbitals with the right hrefs and counts", () => {
    const { container, getByRole } = render(<CelestialBand items={items} />);

    expect(getByRole("link", { name: /Gold, 8 coins/ })).toBeTruthy();
    expect(getByRole("link", { name: /Silver, 1 coins/ })).toBeTruthy();
    expect(getByRole("link", { name: /CPI, 3 coins/ })).toBeTruthy();

    const sun = container.querySelector('[data-orbital="sun"]');
    const moon = container.querySelector('[data-orbital="moon"]');
    const index = container.querySelector('[data-orbital="index"]');
    expect(sun?.getAttribute("data-coin-count")).toBe("8");
    expect(moon?.getAttribute("data-coin-count")).toBe("1");
    expect(index?.getAttribute("data-coin-count")).toBe("3");
  });

  it("returns null when there are no non-geographic references", () => {
    const { container } = render(<CelestialBand items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 4.3 — Run the test**

Run: `npm test -- src/app/alt-pegs/fiat-world-atlas/__tests__/celestial-band.test.tsx`
Expected: pass.

- [ ] **Step 4.4 — Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/celestial-band.tsx src/app/alt-pegs/fiat-world-atlas/__tests__/celestial-band.test.tsx
git commit -m "feat(alt-pegs): CelestialBand renders Gold/Silver/CPI as orbital bodies"
```

---

## Task 5: `RegionChips` component

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/region-chips.tsx`

**Depends on:** Task 1 (for types). Parallel with 3, 4, 6.

- [ ] **Step 5.1 — Extract pill + chip primitives**

Lift `RegionSummaryPill`, `LinkChip`, and `FiatRegionSection`'s non-docked variant from the current `static-link-hub.tsx` (lines 193–259, 437–523). They must no longer know anything about "docked" / atlas positioning — each section renders as a clean grid.

Content of `region-chips.tsx`:

```tsx
import type { CSSProperties } from "react";
import Link from "next/link";
import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";

const REGION_ACCENT: Record<Exclude<AltPegRegion, "Other">, string> = {
  Americas: "#3b82f6",
  Europe: "#8b5cf6",
  Asia: "#14b8a6",
  Africa: "#d946ef",
  Oceania: "#6366f1",
};

function withAlpha(hex: string, alpha: string): string {
  return hex.startsWith("#") && hex.length === 7 ? `${hex}${alpha}` : hex;
}

function formatCoinCount(n: number): string { return `${n} coin${n === 1 ? "" : "s"}`; }
function formatCohortCount(n: number): string { return `${n} cohort${n === 1 ? "" : "s"}`; }

export function RegionSummaryPill({
  region, coinCount, cohortCount,
}: { region: Exclude<AltPegRegion, "Other">; coinCount: number; cohortCount: number }) {
  const accentHex = REGION_ACCENT[region];
  return (
    <div
      className="inline-flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5"
      style={{
        borderColor: withAlpha(accentHex, "24"),
        backgroundColor: withAlpha(accentHex, "0d"),
      }}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: accentHex }} />
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground/92">{region}</span>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatCohortCount(cohortCount)} · {formatCoinCount(coinCount)}
      </span>
    </div>
  );
}

export function LinkChip({ item }: { item: AltPegLinkHubItem }) {
  const style: CSSProperties = {
    borderColor: withAlpha(item.colorHex, "26"),
    backgroundColor: withAlpha(item.colorHex, "0d"),
  };
  return (
    <Link
      href={item.href}
      aria-label={`${item.label}, ${formatCoinCount(item.coinCount)}${item.symbolPreview ? `. ${item.symbolPreview}` : ""}`}
      style={style}
      className="pharos-focus-ring inline-flex min-h-11 flex-col rounded-xl border border-border/65 bg-background/50 px-3 py-2 text-left shadow-sm transition-[background-color,border-color,color,box-shadow] hover:border-border hover:bg-accent/55 hover:text-foreground"
    >
      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.colorHex }} />
        {item.label}
      </span>
      <span className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatCoinCount(item.coinCount)}
        {item.symbolPreview ? ` · ${item.symbolPreview}` : ""}
      </span>
    </Link>
  );
}

export function FiatRegionSection({
  region, items,
}: { region: AltPegRegion; items: readonly AltPegLinkHubItem[] }) {
  const slug = region.toLowerCase().replace(/\s+/g, "-");
  const coinCount = items.reduce((sum, i) => sum + i.coinCount, 0);
  const accentHex = region === "Other" ? items[0]?.colorHex ?? "#64748b" : REGION_ACCENT[region];
  return (
    <section aria-labelledby={`alt-peg-region-${slug}`} className="space-y-2" data-region={region}>
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accentHex }} />
          <h4 id={`alt-peg-region-${slug}`} className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/90">
            {region}
          </h4>
        </div>
        <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatCohortCount(items.length)} · {formatCoinCount(coinCount)}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 lg:gap-1.5">
        {items.map((item) => <LinkChip key={item.href} item={item} />)}
      </div>
    </section>
  );
}
```

- [ ] **Step 5.2 — Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/region-chips.tsx
git commit -m "feat(alt-pegs): extract region pill and chip primitives for world-atlas"
```

---

## Task 6: `MobileRegionList`

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/mobile-region-list.tsx`

**Depends on:** Task 5 (re-uses `FiatRegionSection`). Parallel with 3, 4 after Task 5 commits.

- [ ] **Step 6.1 — Implement**

Content:

```tsx
import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";
import { FiatRegionSection, LinkChip } from "@/app/alt-pegs/fiat-world-atlas/region-chips";

const MOBILE_REGION_ORDER: AltPegRegion[] = ["Europe", "Asia", "Americas", "Africa", "Oceania", "Other"];

export function MobileRegionList({
  fiatItems,
  commodityIndexItems,
}: {
  fiatItems: readonly AltPegLinkHubItem[];
  commodityIndexItems: readonly AltPegLinkHubItem[];
}) {
  const byRegion = new Map<AltPegRegion, AltPegLinkHubItem[]>();
  for (const item of fiatItems) {
    const list = byRegion.get(item.region) ?? [];
    list.push(item);
    byRegion.set(item.region, list);
  }
  const regions = MOBILE_REGION_ORDER
    .map((region) => ({ region, items: byRegion.get(region) ?? [] }))
    .filter((entry) => entry.items.length > 0);

  return (
    <div data-alt-peg-layout="region-list" className="space-y-4 px-4 py-4 sm:px-5 sm:py-5 xl:hidden">
      {regions.map(({ region, items }) => (
        <FiatRegionSection key={region} region={region} items={items} />
      ))}
      {commodityIndexItems.length > 0 ? (
        <section aria-labelledby="alt-peg-mobile-commodity" className="space-y-2" data-region="Non-geographic">
          <h4 id="alt-peg-mobile-commodity" className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/90">
            References beyond geography
          </h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {commodityIndexItems.map((item) => (
              <LinkChip key={item.peg} item={item} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6.2 — Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/mobile-region-list.tsx
git commit -m "feat(alt-pegs): MobileRegionList stacked view including non-geographic cohorts"
```

---

## Task 7: `FiatWorldAtlas` top-level + barrel

**Files:**
- Create: `src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx`
- Create: `src/app/alt-pegs/fiat-world-atlas/index.ts`

**Depends on:** Tasks 3, 4, 5, 6.

- [ ] **Step 7.1 — Implement**

Content of `world-atlas.tsx`:

```tsx
import type { AltPegLinkHubItem, AltPegRegion } from "@/lib/alt-peg-market";
import { CelestialBand } from "@/app/alt-pegs/fiat-world-atlas/celestial-band";
import { FiatRegionSection, RegionSummaryPill } from "@/app/alt-pegs/fiat-world-atlas/region-chips";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import { MobileRegionList } from "@/app/alt-pegs/fiat-world-atlas/mobile-region-list";

const ATLAS_REGION_ORDER: Exclude<AltPegRegion, "Other">[] = ["Americas", "Europe", "Asia", "Africa", "Oceania"];

function getRegionCoinCount(items: readonly AltPegLinkHubItem[]): number {
  return items.reduce((sum, i) => sum + i.coinCount, 0);
}

export function FiatWorldAtlas({
  fiatItems,
  commodityIndexItems,
}: {
  fiatItems: readonly AltPegLinkHubItem[];
  commodityIndexItems: readonly AltPegLinkHubItem[];
}) {
  const fiatByRegion = new Map<AltPegRegion, AltPegLinkHubItem[]>();
  for (const item of fiatItems) {
    const list = fiatByRegion.get(item.region) ?? [];
    list.push(item);
    fiatByRegion.set(item.region, list);
  }
  const geoRegions = ATLAS_REGION_ORDER
    .map((region) => ({ region, items: fiatByRegion.get(region) ?? [] }))
    .filter((entry) => entry.items.length > 0);

  return (
    <section aria-labelledby="alt-peg-fiat-geography" className="pharos-card-shell overflow-hidden">
      <div className="space-y-3 px-4 py-4 sm:px-5 sm:py-5">
        <div className="space-y-1">
          <h3 id="alt-peg-fiat-geography" className="pharos-kicker">Fiat Peg Geography</h3>
          <p className="text-sm text-muted-foreground">
            Countries are colored by the fiat peg whose currency they reference.
            Gold, Silver, and index-linked cohorts float above the map as
            references that exist beyond any single monetary region.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {geoRegions.map(({ region, items }) => (
            <RegionSummaryPill key={region} region={region} cohortCount={items.length} coinCount={getRegionCoinCount(items)} />
          ))}
        </div>
      </div>

      <CelestialBand items={commodityIndexItems} />

      <div data-alt-peg-layout="desktop-atlas" className="hidden border-t border-border/60 px-4 py-4 sm:px-5 sm:py-5 xl:block">
        <div className="relative overflow-hidden rounded-[1.5rem] border border-border/60 bg-background/35 p-3">
          <WorldMap items={fiatItems} />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {geoRegions.map(({ region, items }) => (
            <FiatRegionSection key={region} region={region} items={items} />
          ))}
        </div>
      </div>

      <MobileRegionList fiatItems={fiatItems} commodityIndexItems={commodityIndexItems} />
    </section>
  );
}
```

- [ ] **Step 7.2 — Create barrel `index.ts`**

```ts
export { FiatWorldAtlas } from "./world-atlas";
```

- [ ] **Step 7.3 — Commit**

```bash
git add src/app/alt-pegs/fiat-world-atlas/world-atlas.tsx src/app/alt-pegs/fiat-world-atlas/index.ts
git commit -m "feat(alt-pegs): FiatWorldAtlas assembles celestial band, world map, and chips"
```

---

## Task 8: Refactor `static-link-hub.tsx`

**Files:**
- Modify: `src/app/alt-pegs/static-link-hub.tsx`
- Modify: `src/app/alt-pegs/static-link-hub.test.tsx`
- Modify: `docs/alt-pegs-page.md`

**Depends on:** Task 7.

- [ ] **Step 8.1 — Replace the entire module**

New `static-link-hub.tsx`:

```tsx
import { buildAltPegLinkHubGroups, type AltPegLinkHubItem } from "@/lib/alt-peg-market";
import { FiatWorldAtlas } from "@/app/alt-pegs/fiat-world-atlas";

const LINK_HUB_GROUPS = buildAltPegLinkHubGroups();

export function StaticAltPegLinkHub() {
  const fiatItems = LINK_HUB_GROUPS.find((g) => g.label === "Fiat")?.items ?? [];
  const commodityIndexItems: AltPegLinkHubItem[] = LINK_HUB_GROUPS
    .filter((g) => g.label !== "Fiat")
    .flatMap((g) => g.items);

  return (
    <section aria-labelledby="alt-peg-link-hub" className="space-y-3">
      <div className="space-y-1">
        <p className="pharos-kicker">Drill Down</p>
        <h2 id="alt-peg-link-hub" className="pharos-section-title">Explore Peg Cohorts</h2>
        <p className="pharos-meta">
          Static route links keep the non-USD cohort taxonomy crawlable and make
          it easy to jump from the market lens into the peg you want to inspect
          next.
        </p>
      </div>
      <FiatWorldAtlas fiatItems={fiatItems} commodityIndexItems={commodityIndexItems} />
    </section>
  );
}
```

- [ ] **Step 8.2 — Update tests**

Rewrite `static-link-hub.test.tsx`:

```tsx
// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaticAltPegLinkHub } from "@/app/alt-pegs/static-link-hub";

describe("StaticAltPegLinkHub", () => {
  it("renders crawlable peg links in static markup for fiat, commodity, and index cohorts", () => {
    const html = renderToStaticMarkup(<StaticAltPegLinkHub />);
    expect(html.match(/href="\/stablecoins\/eur\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/gold\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/silver\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/href="\/stablecoins\/cpi\/?"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain("/stablecoins/usd");
    expect(html).toContain("Fiat Peg Geography");
    expect(html).toContain("References beyond geography");
    expect(html).toContain("Explore Peg Cohorts");
  });

  it("keeps the desktop atlas gated behind the xl layout and mobile list at xl:hidden", () => {
    const { container } = render(<StaticAltPegLinkHub />);
    const desktopAtlas = container.querySelector('[data-alt-peg-layout="desktop-atlas"]');
    const regionList = container.querySelector('[data-alt-peg-layout="region-list"]');
    expect(desktopAtlas?.className).toContain("hidden");
    expect(desktopAtlas?.className).toContain("xl:block");
    expect(regionList?.className).toContain("xl:hidden");
  });

  it("colors the German and Japanese country paths based on EUR and JPY fills", () => {
    const { container } = render(<StaticAltPegLinkHub />);
    const styleBlock = Array.from(container.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("");
    expect(styleBlock).toContain("path#DE{fill:#8b5cf6");
    expect(styleBlock).toContain("path#JP{fill:#f43f5e");
  });

  it("renders the celestial band with Gold, Silver, and CPI orbitals", () => {
    const { container } = render(<StaticAltPegLinkHub />);
    const band = container.querySelector('[data-testid="celestial-band"]');
    expect(band).not.toBeNull();
    expect(band?.querySelector('[data-orbital="sun"]')).not.toBeNull();
    expect(band?.querySelector('[data-orbital="moon"]')).not.toBeNull();
    expect(band?.querySelector('[data-orbital="index"]')).not.toBeNull();
  });
});
```

- [ ] **Step 8.3 — Update `docs/alt-pegs-page.md`**

Replace the prior "Fiat Peg Geography — stylized atlas / docked region cards / separate non-geographic side card" description with the new one:
- One unified `FiatWorldAtlas` card.
- Celestial band above a real world map.
- Per-country fills from `PEG_COUNTRY_MAP` in `src/lib/alt-peg-geography.ts`.
- Mobile falls back to stacked `MobileRegionList` including non-geographic cohorts.
- SVG regenerated via `npm run build:world-map`.

Read the current file first; edit only the "Fiat Peg Geography" / "Non-geographic references" sections. Leave everything else alone.

- [ ] **Step 8.4 — Run tests, lint, type-check, build**

Run, stopping if any fails:

```bash
npm test
npm run lint
npm run build
```

Expected: all green. Fix any failures before committing.

- [ ] **Step 8.5 — Commit**

```bash
git add src/app/alt-pegs/static-link-hub.tsx src/app/alt-pegs/static-link-hub.test.tsx docs/alt-pegs-page.md
git commit -m "refactor(alt-pegs): replace stylized atlas with world-map + celestial band"
```

---

## Task 9: Visual QA + dev-server walk-through

**Depends on:** Task 8.

- [ ] **Step 9.1 — Start dev server**

Run: `npm run dev`. Wait for "Ready".

- [ ] **Step 9.2 — Check `/alt-pegs` at desktop width with Playwright**

Use the Playwright MCP tools to navigate and screenshot:

1. `browser_navigate` → `http://localhost:3000/alt-pegs`
2. `browser_resize` → width 1440, height 900
3. `browser_wait_for` → text "Fiat Peg Geography"
4. `browser_take_screenshot` → save as `agents/design/2026-04-23-world-map-desktop.png`

Expected visual state:
- Single card labeled "Fiat Peg Geography".
- Celestial band with Gold (large golden sun), Silver (smaller moon), CPI (indigo index glyph).
- World map below with colored countries: eurozone purple, Japan rose, UK cyan, Brazil orange, Switzerland pink, Australia indigo, etc.
- Region pills above the band, per-currency chips below the map.
- No separate "Non-geographic references" side card.

- [ ] **Step 9.3 — Check mobile width**

1. `browser_resize` → width 390, height 844
2. `browser_take_screenshot` → save as `agents/design/2026-04-23-world-map-mobile.png`

Expected: no world map rendered. Stacked region list + commodity/index section at the bottom.

- [ ] **Step 9.4 — Commit screenshots if kept**

```bash
git add agents/design/2026-04-23-world-map-desktop.png agents/design/2026-04-23-world-map-mobile.png
git commit -m "docs(alt-pegs): world-map refactor visual QA screenshots"
```

If screenshots are not worth keeping, skip the commit.

- [ ] **Step 9.5 — Kill the dev server** (Ctrl+C the background process).

---

## Self-review checklist

Before marking the plan executed, confirm:

- [ ] Spec goal (real world map + celestial band) covered by Tasks 3, 4, 7.
- [ ] Decisions 1–6 from the spec all mapped to a task.
- [ ] Every test has concrete assertion content.
- [ ] Type names / function names are consistent: `buildCountryColorMap`,
  `PEG_COUNTRY_MAP`, `FiatWorldAtlas`, `CelestialBand`, `WorldMap`,
  `FiatRegionSection`, `RegionSummaryPill`, `MobileRegionList`.
- [ ] `docs/alt-pegs-page.md` updated in Task 8.
- [ ] No stale `AtlasBackdrop`, `AtlasLeadLines`, `CoverageMarker`,
  `NonGeographicReferenceCard`, `MAP_REGION_LAYOUT`, `ATLAS_LANDMASSES`, or
  `projectLonLat` references remain anywhere in the tree after Task 8.
