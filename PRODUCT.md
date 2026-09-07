# Product

> Synthesized from `docs/design-language.md#context` (canonical), `docs/design-language.md`, and `CLAUDE.md`. If this file and `docs/design-language.md#context` disagree, `docs/design-language.md#context` wins.

## Register

product

## Users

Crypto-native DeFi participants who actively monitor stablecoin health — peg stability, backing, freeze risk, liquidity — to inform financial decisions. Power-user-leaning: they value density, precision, and speed-to-insight. Discovery surfaces (`/start/`, `/about/`, `/learn/`) deliberately soften the funnel for newcomers; the data surfaces stay practitioner-grade.

## Product Purpose

Pharos is the most complete free, open-source source for stablecoin intelligence — full research dossiers on 400+ stablecoins (collateral composition, peg mechanism, cross-chain model, compliance, yield, depeg history). Like a Bloomberg Terminal scoped to stablecoins. Success: a user can verify any key fact about any stablecoin in seconds and trust the answer.

## Brand Personality

Vigilant, precise, distinctive. Pharos is a lighthouse: it watches every peg so you don't have to. Practitioner-built, not corporate. Calm by default, urgent when risk signals fire. Trust through completeness and specificity.

## Anti-references

- Web3 marketing pages (purple gradients, glassmorphism, buzzwords)
- Corporate fintech sterility (bank-app blandness)
- Generic SaaS dashboards (interchangeable KPI tiles, big empty cards)
- Reskinned DefiLlama / generic trading-terminal clones
- Consumer-app over-softening of data surfaces (no mascots or chunky illustrations inside data)

## Design Principles

1. Data density over decoration; every pixel earns its place.
2. Calibrate density to surface tier: Discovery breathes, Analytics holds default, Power-user compresses (see `docs/design-language.md#context` tier table).
3. Calm authority; risk signals shift tone without panic.
4. Precision as personality: mono numbers, exact percentages, named bands.
5. Semantic color only; color encodes state, never decoration.
6. Distinctive, not generic — when a page introduces a metaphor, draw it, and every shape must encode a data field.
7. Consistency is polish: repeated precision in spacing, shells, controls, empty/error states.

## Accessibility & Inclusion

Skip links on every page, focus-visible rings everywhere, keyboard-ready interactive rows, color reinforced with structure/iconography. Contrast floor: informational text targets `text-muted-foreground/70`; lighter tints (`/40`–`/60`) are reserved for decorative separators, aria-hidden glyphs, and empty-value placeholders (WCAG 1.4.3/1.4.11 on the light theme). Reduced-motion gates on all keyframe animation.
