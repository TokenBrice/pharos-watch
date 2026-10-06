# Stablecoin Pulse layout

## Build

From the repository root:

```sh
node .codex/skills/stablecoin-pulse-report/scripts/build-pulse-pdf.mjs --dir agents/<YYYY-MM-DD>-pulse-report
```

Requires Node.js and the repository's installed `playwright`. The builder resolves repository assets from its own location; `--dir` is relative to the current working directory. It first tries bundled Chromium (`npx playwright install chromium`), then installed Google Chrome, using `CHROME_PATH` if supplied. No network research occurs during rendering.

Inputs are exclusively `<dir>/content.json`, `data/digest-archive.json`, `data/chains.json`, and `data/movers-30d.csv`, plus the repository's `public/pharos-mark-on-light.svg`. Outputs are `out/report.html`, `out/report.pdf`, `out/page-1.png`, `out/page-2.png`, `out/build-info.json`, and `Stablecoin-Pulse-<Month>-<YYYY>.pdf`. The filename uses a full English month/year in `period.label`, otherwise the UTC month/year of `period.end`.

## Editorial schema

All fields below are required unless marked optional. Strings must be nonempty; arrays must be nonempty except `chartAnnotations`. `tone` is `up`, `down`, or `flat`.

```text
{
  title, subtitle, window, footer: string,
  period: { start: YYYY-MM-DD, end: YYYY-MM-DD, label?: string },
  kpis: [{ label, value, delta: string, tone }],
  tldr: [HTML string],
  sections: [
    { id: "movers", title: string,
      rows: [{ asset, delta, pct: string, tone, why: HTML string }] },
    { id: "launches", title: string, items: [HTML string] },
    { id: "stress", title: string, items: [HTML string] },
    { id: "market", title: string, items: [HTML string] }
  ],
  watch: [HTML string],
  chartAnnotations: [{ date: YYYY-MM-DD, label: string }],
  annex: {
    title: string,
    blocks: [{ tag, heading: string, body: HTML string,
               sources: [{ label: string, url: HTTPS URL }] }],
    methodology: HTML string
  }
}
```

Dates are valid UTC calendar dates; start precedes end; annotations must fall inside the period. Plain fields are escaped. HTML fields are editorial copy with an enforced parser allowlist: use only `<b>`, `<i>`, and `<a href="https://…">`; no scripts, styles, images, arbitrary markup, or additional attributes. Unsupported markup fails the build before HTML is written. The renderer disables document JavaScript and external requests; exported HTML also carries a restrictive CSP. Preserve U+2060 word joiners between a sign and `$` (for example `−⁠$`), preventing broken monetary figures. Source prefixes are derived automatically: X, On-chain (Etherscan/Solscan/Tronscan/Basescan/Arbiscan), or Web.

### Visible-character targets

Spaces count; HTML tags and URL destinations do not. These are writing budgets, not hard truncation limits. Fit checks and visual review are authoritative.

| Field | Target |
| --- | --- |
| `title` / `subtitle` / `window` / `footer` | 42 / 105 / 90 / 65 |
| `period.label` | Full month and four-digit year |
| Six KPI `label` / `value` / `delta` | 17 / 8 / 20 each |
| Four `tldr` items | About 125 each, 500 total |
| Section `title` | 28; movers may use 40 |
| Eight mover `asset` / `delta` / `pct` | 8 / 10 / 9 each |
| Mover `why` | 190–205 each, ideally two printed lines |
| Five items in each compact section | 85–95 each, about 450 per section |
| Three `watch` items | 100 each, about three printed lines |
| `chartAnnotations[].label` | 22; prefer at most two annotations |
| `annex.title` | 42 |
| Eight annex `tag` / `heading` | 18 / 45 each |
| Annex `body` | 550–650 each |
| Source `label` | 60, at most three per block |
| Source `url` | No display budget; a valid HTTPS destination |
| `annex.methodology` | 700–850 total |

Identifiers, dates and tones use their schema literals, not character budgets. More annotations receive separate lanes where needed; long labels or excessive copy must be corrected deliberately, never clipped or silently removed.

## Charts and layout

The market line uses only positive daily `totalMcapUsd`, selecting the latest `generatedAt` per UTC day within the inclusive period. It labels the actual first and last observations, spans the requested period, and explicitly notes that the axis is not zero-based. Missing observations are not invented. Editorial KPI copy is not silently recomputed.

The "Where the dollars moved" strip shows four ranked lists across the page: coin gainers, coin losers, chain gainers, chain losers, six rows each. Each row has a fixed name column, a bar from a shared baseline, and the value to the right of the bar; no text sits on a bar. Coins share one scale and chains share another. Coin rankings exclude purely numeric IDs and absent/zero prior supply. Chain rankings use USD `change30d`, never percentage changes; null baselines are excluded and chains of at least $100M appear in the one-line no-baseline note. No peg bucket is multiplied by price.

Pages use serif headings, navy/green/red accents, tabular figures, and 8px section spacing with compact internal spacing. The movers' USD values sit above smaller muted percentages; annex tags precede headings and measured block heights balance the two columns. Body copy is at least 7.5pt. Each content panel is 296mm high within an A4 sheet, with 7mm vertical and 9mm side padding; nothing is hidden to force fit.

## Verification and delivery

The builder fails on missing fields, footer intrusion, horizontal overflow, body type below 7.5pt, or anything other than two A4 PDF pages. `build-info.json` records chart observations/rankings, browser and verification paths, and content-to-footer clearances in CSS pixels and millimetres.

`pdfinfo` checks page count and size when available; otherwise the builder inspects PDF page objects and MediaBoxes itself. `pdftoppm` produces actual-PDF PNGs at 140 dpi when available. Otherwise Playwright captures each page under print media: these are HTML previews, **not** rasterized PDF evidence. The command prints which paths ran. Unexpected installed-tool failures stop the build rather than being hidden by fallback.

After every monthly build, inspect both PNGs at full resolution (upper/lower crops are fine). Check every table row, sign, annotation, bar label, source prefix, heading, footer, and the no-baseline line for overlap or clipping. Check both annex columns and the watch box. PDF page-count checks cannot detect all visual collisions. If copy exceeds the layout, adjust the layout without reducing body type below 7.5pt or changing editorial meaning; never distribute a clipped result. Outputs from an earlier build can remain after failure: distribute only after a successful command and visual review.
