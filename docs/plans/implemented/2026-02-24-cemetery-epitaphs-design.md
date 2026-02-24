# Cemetery Epitaphs

**Date:** 2026-02-24
**Status:** Draft

## Context

The cemetery page has a distinctive tombstone design that gives it genuine character among the dashboard's data-driven pages. Each tombstone currently shows: R.I.P., logo, symbol (struck-through), death date, and peak market cap. Real tombstones have one more thing: an epitaph. A terse, memorable line that captures a life and its end. Adding epitaphs completes the metaphor and creates a three-tier information hierarchy: epitaph (one glance) -> tooltip hover (summary) -> expanded autopsy (full story).

The peak market cap number is already communicated visually by tombstone size (that's the stated purpose of the size scaling). Removing the redundant number from the tombstone face makes room for an epitaph without increasing tombstone dimensions.

## Changes

### 1. Add `epitaph` field to `DeadStablecoin` type

**File:** `src/lib/types.ts`

Add optional `epitaph?: string` field to the `DeadStablecoin` interface. Optional so the build doesn't break if a coin is added without one immediately.

### 2. Write epitaphs for all 72 dead stablecoins

**File:** `src/lib/dead-stablecoins.ts`

Add an `epitaph` field to every entry in `DEAD_STABLECOINS`. Constraints:

- **Max ~25 characters** for small tombstones (88px wide, ~80px usable, ~13 chars/line at 8px font = 2 lines max)
- Longer epitaphs (up to ~35 chars) are acceptable for coins with medium/large tombstones (>=$50M peak mcap)
- Tone: terse, dark wit, factual. Not cruel — memorial, not mockery.
- Each epitaph should capture *how* or *why* the coin died, not just *that* it died.

Draft epitaphs for all 72 coins (to be refined during implementation):

**2018**
| Coin | Symbol | Size | Epitaph |
|------|--------|------|---------|
| NuBits | USNBT | sm | "The first to try" |

**2021**
| Coin | Symbol | Size | Epitaph |
|------|--------|------|---------|
| Empty Set Dollar | ESD | md | "The coupon experiment" |
| Dynamic Set Dollar | DSD | md | "Forked ESD. Same fate" |
| SafeDollar | SAFEDOLLAR | sm | "Not safe. Not a dollar" |
| Basis Cash | BAC | sm | "The theory was elegant" |
| Fei Protocol | FEI | md | "Built different. Died the same" |

**2022**
| Coin | Symbol | Size | Epitaph |
|------|--------|------|---------|
| Iron Finance | IRON | sm | "First to fall by design" |
| Cashio | CASH | sm | "Infinite mint, instant death" |
| Acala aUSD | AUSD | sm | "One exploit. 1.29B minted" |
| Bean | BEAN | sm | "Beanstalk got cut down" |
| Nirvana ANA | ANA | sm | "No rebirth this time" |
| TerraUSD | UST | lg | "Too big to fail. Too flawed to live" |
| DEI | DEI | sm | "Collateral damage" |
| Fantom USD | fUSD | sm | "Chained to a falling chain" |
| USDD (old) | USDD | md | "Sun also sets" |
| Neutrino USD | USDN | md | "Waves crashed" |
| Platypus USD | USP | sm | "Exploited at the watering hole" |
| Bai Stablecoin | BAI | sm | "Silently deprecated" |
| Celo Dollar | CUSD | sm | "Pivoted away" |
| HUSD | HUSD | md | "Trusted the wrong custodian" |
| Steem Dollar | SBD | sm | "Outgrew its blockchain" |

**2023**
| Coin | Symbol | Size | Epitaph |
|------|--------|------|---------|
| Synth sUSD | SUSD | md | "The Synthetix sun set" |
| Origin Dollar | OUSD | md | "Yield chasing ran dry" |
| Volt Protocol | VOLT | sm | "Inflation-proof wasn't" |
| Float Protocol | FLOAT | sm | "Never found ground" |
| Rai | RAI | sm | "Too pure for this world" |
| Reserve Dollar | RSV | sm | "Reserved for history" |
| USDP (Unit) | USDP | sm | "Paxos moved on" |
| TrueUSD | TUSD | md | "Prime Trust wasn't" |
| Magic Internet Money | MIM | md | "The magic ran out" |
| Reflexer Ungovernance | UNIGOV | sm | "Ungoverned to the end" |
| Tor | TOR | sm | "Multichain took it down" |
| Monerium EURe | EURE | sm | "MiCA's first casualty" |
| PAR | PAR | sm | "Mimo went quiet" |
| EURT | EURT | md | "Killed by decree" |
| EUROe | EUROE | sm | "Membrane dissolved" |

**2024**
| Coin | Symbol | Size | Epitaph |
|------|--------|------|---------|
| BEAN (replant) | BEAN2 | sm | "Second planting failed too" |
| Dola | DOLA | sm | "Inverse didn't work out" |
| Fei USD (rari) | TRIBE | sm | "Tribe disbanded" |
| Kava USDX | USDX | sm | "Kava moved on" |
| Gemini Dollar | GUSD | md | "Too small to matter" |
| Pax Dollar | USDP2 | md | "Consolidated away" |
| FRAX (v1) | FRAX | md | "Fractional no more" |
| Lybra eUSD | EUSD | sm | "Yield compressed to zero" |
| sUSD (legacy) | SUSD2 | sm | "Deprecated for v3" |
| Vai | VAI | sm | "Venus couldn't save it" |
| USDR | USDR | sm | "Real estate illiquid" |
| Prisma mkUSD | MKUSD | sm | "Maker's shadow faded" |
| HAY/lisUSD | HAY | sm | "Rebranded. Still dying" |
| ZUSD | ZUSD | sm | "Zero users, zero supply" |
| YUSD | YUSD | sm | "Yielded to reality" |
| MiMatic MAI | MAI | sm | "Qi collapsed" |
| DCHF | DCHF | sm | "Swiss precision, not demand" |
| Gyroscope GYD | GYD | sm | "Spin cycle stopped" |
| BUSD | BUSD | lg | "Killed by decree" |
| OHM/gOHM | OHM | md | "3,3 became 0,0" |
| Ampleforth AMPL | AMPL | sm | "Rebased into irrelevance" |
| Angle agEUR | AGEUR | sm | "Angle pivoted" |
| Silo crvUSD | CRVUSD-S | sm | "Silo walls crumbled" |
| flexUSD | FLEXUSD | sm | "CoinFLEX went rigid" |
| UXD | UXD | sm | "Delta-neutral theory" |
| UNO | UNO | sm | "Last place" |

**2025**
| Coin | Symbol | Size | Epitaph |
|------|--------|------|---------|
| Alchemix alUSD | ALUSD | sm | "Transmutation failed" |
| csUSDL | CSUSDL | sm | "Coinshift shifted away" |
| Parallel PAC | PAC | sm | "Parallel ended" |
| mUSD | MUSD | sm | "mStable unstable" |
| SpiceUSD | USDS-SPICE | sm | "Lost its flavor" |
| eUSD (Lybra v2) | EUSD2 | sm | "Version 2, same ending" |
| SILK | SILK | sm | "Secret no more" |
| Bean v2 | BEAN3 | sm | "Third time unlucky" |
| Raft R | R | sm | "Adrift" |
| Reservoir rUSD | RUSD | sm | "$88M walked out the door" |

**2026**
| Coin | Symbol | Size | Epitaph |
|------|--------|------|---------|
| Palm USD | PUSD | sm | "Billions announced. $81K left" |

Note: The symbols above are shorthand for the table. Actual symbols come from the existing `DEAD_STABLECOINS` array. The epitaphs will be refined during implementation when reading each coin's full obituary and context.

### 3. Replace peak mcap with epitaph on tombstone face

**File:** `src/components/cemetery-tombstones.tsx`

In the `Tombstone` component, replace the peak mcap `<span>` (lines 240-244) with the epitaph:

**Remove:**
```tsx
{coin.peakMcap && (
  <span className="text-[10px] font-mono tabular-nums text-muted-foreground/60">
    {formatCurrency(coin.peakMcap, 1)}
  </span>
)}
```

**Replace with:**
```tsx
{coin.epitaph && (
  <span className="text-[8px] italic text-muted-foreground/50 text-center leading-tight px-1.5">
    {coin.epitaph}
  </span>
)}
```

Styling rationale:
- `text-[8px]` — smallest legible size, matches R.I.P. text
- `italic` — distinguishes epitaph from data; traditional inscription style
- `text-muted-foreground/50` — subtle, weathered appearance (slightly more faded than the date)
- `text-center leading-tight` — centered, compact multi-line wrapping
- `px-1.5` — small horizontal padding to prevent text touching tombstone edges

### 4. Add peak mcap back to hover tooltip

**File:** `src/components/cemetery-tombstones.tsx`

The tooltip (lines 248-260) currently shows: name, first sentence of obituary, cause label. Add peak market cap to the tooltip so it remains accessible on desktop hover:

```tsx
{hovered && (
  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-30 w-56 rounded-lg border bg-popover p-3 text-xs shadow-lg pointer-events-none">
    <p className="font-semibold">{coin.name}</p>
    <p className="text-muted-foreground mt-1 leading-relaxed">
      {coin.obituary.split(". ")[0]}.
    </p>
    <div className="mt-1.5 flex items-center justify-between">
      <span className={CAUSE_META[coin.causeOfDeath].textColor}>
        {CAUSE_META[coin.causeOfDeath].label}
      </span>
      {coin.peakMcap && (
        <span className="font-mono tabular-nums text-muted-foreground">
          {formatCurrency(coin.peakMcap, 1)}
        </span>
      )}
    </div>
  </div>
)}
```

The mcap sits right-aligned on the same line as the cause label, using space that was previously empty. This tooltip only appears on desktop hover, which is fine — the expanded autopsy card (always accessible on mobile via tap) already shows peak mcap in its key facts section.

## What Changes

| File | Change |
|------|--------|
| `src/lib/types.ts` | Add `epitaph?: string` to `DeadStablecoin` |
| `src/lib/dead-stablecoins.ts` | Add `epitaph` field to all 72 entries |
| `src/components/cemetery-tombstones.tsx` | Swap mcap for epitaph on tombstone face; add mcap to tooltip |

## What Doesn't Change

- Tombstone dimensions (no size changes needed)
- Autopsy reports / expandable obituary list (already shows peak mcap)
- Cemetery charts (still use peakMcap data from the array)
- Cemetery summary widget
- Cemetery timeline component
- Any other page or component

## Verification

1. `npm run build` — type-check passes, static export succeeds
2. `npm run dev` — visual check on cemetery page:
   - Epitaphs render on all tombstone sizes without overflow
   - Text wraps cleanly within 88px (small), 100px (medium), 120px (large) tombstones
   - Italic style reads as "engraved inscription" not "broken layout"
   - Hover tooltip shows peak mcap alongside cause label
   - Mobile: epitaphs legible on 3-column grid (smallest viewport)
3. Click a tombstone — autopsy card still shows peak mcap in key facts
4. Spot-check a few coins: epitaph content matches the coin's actual story
