# Pharos URN Scheme

`urn:pharos:<entity-class>:<id>[@<qualifier>]`

The Pharos URN scheme is a stable, parser-friendly identifier for every cite-able artifact published by Pharos. It follows RFC 8141 with `pharos` as the namespace identifier. The grammar is **stable**: separator characters and the `urn:pharos:` prefix never change. New entity classes may be appended (additive) but existing entries never get renamed, removed, or repurposed once shipped — see the table below for the canonical list.

Implementation: `shared/lib/citation/urn.ts` (`formatPharosUrn`, `parsePharosUrn`).

---

## Grammar

```
urn:pharos:<entity-class>:<id>[@<qualifier>]
```

- **`urn:pharos:`** — fixed prefix. No other repo features may invent their own `pharos:foo:bar` strings.
- **`<entity-class>`** — one of the closed enum below.
- **`<id>`** — lowercase, hyphens not underscores, no leading or trailing hyphen.
- **`@<qualifier>`** — optional version or ISO date, used only when the citation pins a mutable surface to a point in time. Lowercase letters, digits, hyphens, or dots allowed; no leading or trailing hyphen or dot.

The colon `:` separates the prefix and entity-class fields; `@` separates the id from the optional qualifier. Reader tooling splits on `:` first, then on `@`, to extract all components.

---

## Entity classes (closed enum, immutable from v1)

| Class | Used for | Example |
|---|---|---|
| `coin` | A tracked stablecoin's detail page | `urn:pharos:coin:usdc-circle` |
| `depeg-event` | A confirmed depeg event | `urn:pharos:depeg-event:usdc-2023-03-11` |
| `methodology` | A methodology document or changelog | `urn:pharos:methodology:dews@v4.2` |
| `digest` | A daily or weekly digest issue | `urn:pharos:digest:2026-05-16` |
| `cemetery` | A frozen-coin obituary entry | `urn:pharos:cemetery:bac-basis-cash-2021-01` |
| `dataset` | A static dataset export | `urn:pharos:dataset:stablecoin-cemetery` |
| `snapshot` | A daily public-data snapshot row | `urn:pharos:snapshot:2026-05-16` |
| `depeg-report` | A per-event depeg report (post-mortem) | `urn:pharos:depeg-report:usdc-2023-03` |
| `page` | A first-class editorial or policy page | `urn:pharos:page:principles` |

Adding a new entity class is an explicit, deliberate event recorded here. The `page` class was added in 2026-05 for About / Principles / Editorial AI policy identifiers. Existing classes remain stable; do not rename, remove, or repurpose any entry once it has shipped.

---

## When to use the `@<qualifier>` suffix

Pages with permanently immutable URLs (digests, depeg events, cemetery entries) usually omit `@`. Use it only when the citation explicitly needs to pin a mutable surface to a point in time:

- **Methodology versions** — `urn:pharos:methodology:safety-score@v7.2`. The methodology page itself is mutable; the version qualifier pins it.
- **Coin detail at a freeze date** — `urn:pharos:coin:usdc-circle@2026-05-16`. The detail page is mutable; the date qualifier pins it.

---

## Display rules

1. When a specialized artifact must expose a URN, render it as a `<code>` element with a copy affordance.
2. **Do not** render the URN as a clickable link in v1. There is no resolver yet (`https://pharos.watch/r/<urn>` is deferred).

---

## JSON-LD integration

The URN is added to each coin surface's JSON-LD as an `identifier` `PropertyValue` via `src/lib/pharos-urn-json-ld.ts` (`buildPharosUrnJsonLdIdentifier`), already wired into the `Thing` and `Dataset` nodes in `src/lib/stablecoin-detail-json-ld.ts`. The canonical URL stays in `@id`; the URN is **only** an `identifier` property — never bake the URN scheme into the JSON-LD `@id` field.

```jsonc
{
  "@type": "Article",
  "@id": "https://pharos.watch/methodology/depeg-changelog/",
  "identifier": [
    {
      "@type": "PropertyValue",
      "propertyID": "Pharos URN",
      "value": "urn:pharos:methodology:dews@v4.2"
    }
  ]
}
```

---

## Accessed-date pinning

The "accessed" date in any generated citation artifact must come from deterministic build metadata, not from `new Date()` in the browser. This keeps dates stable across HTML, RSS feeds, and generated citation artifacts for the same build.

---

## See also

- `shared/lib/citation/urn.ts` — formatter + parser.
