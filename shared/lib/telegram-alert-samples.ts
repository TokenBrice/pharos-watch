import type { TelegramAlertType } from "../types/status/telegram";

/**
 * Canonical formatter fixtures and public alert samples (TGB-028).
 *
 * The /pharoswatchbot landing page renders `TELEGRAM_PUBLIC_ALERT_SAMPLES`
 * verbatim as "shown exactly as the bot sends them" example bubbles. The
 * contract test `worker/src/lib/__tests__/telegram-alert-samples.test.ts`
 * feeds `TELEGRAM_ALERT_SAMPLE_FIXTURES` through the real Worker formatter
 * (`formatConsolidatedMessage`) and asserts the plaintext projection equals
 * each sample below, so any formatter change that would make the public
 * examples lie fails CI instead of drifting.
 *
 * Fixture shapes structurally mirror the Worker formatter payload interfaces
 * in `worker/src/lib/telegram-alerts-formatting.ts`; the contract test proves
 * assignability because it passes them to the formatter directly.
 */
export interface TelegramDewsSampleFixture {
  stablecoinId: string;
  symbol: string;
  oldBand: string;
  newBand: string;
  score: number;
  topSignals: { name: string; value: number }[];
}

export interface TelegramDepegSampleFixture {
  stablecoinId: string;
  symbol: string;
  direction: "above" | "below";
  deviationBps: number;
  price: number;
  pegReference: number;
}

export interface TelegramSafetySampleFixture {
  stablecoinId: string;
  symbol: string;
  oldGrade: string;
  newGrade: string;
  oldScore: number | null;
  newScore: number | null;
  contextLine?: string;
}

export interface TelegramNamedCoinSampleFixture {
  stablecoinId: string;
  symbol: string;
  name: string;
}

export interface TelegramAlertSampleFixtures {
  dews: TelegramDewsSampleFixture;
  depeg: TelegramDepegSampleFixture;
  safety: TelegramSafetySampleFixture;
  launch: TelegramNamedCoinSampleFixture;
  reserve: TelegramNamedCoinSampleFixture;
}

/** Synthetic but format-faithful inputs, one per alert family. */
export const TELEGRAM_ALERT_SAMPLE_FIXTURES: TelegramAlertSampleFixtures = {
  dews: {
    stablecoinId: "usdt-tether",
    symbol: "USDT",
    oldBand: "WATCH",
    newBand: "ALERT",
    score: 42,
    topSignals: [
      { name: "pool_balance_drift", value: 61 },
      { name: "supply_velocity", value: 48 },
    ],
  },
  depeg: {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    direction: "below",
    deviationBps: 120,
    price: 0.988,
    pegReference: 1,
  },
  safety: {
    stablecoinId: "usdr-tangible",
    symbol: "USDR",
    oldGrade: "B",
    newGrade: "F",
    oldScore: 70,
    newScore: 39,
    contextLine:
      "Reason: Active depeg peak 7546 bps capped the pre-variant Safety Score at F (39). Now: Safety F 39 · Liquidity 57, DEX TVL $1.2M · Supply $13.1M",
  },
  launch: {
    stablecoinId: "usdpt-western-union",
    symbol: "USDPT",
    name: "US Dollar Payment Token",
  },
  reserve: {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    name: "Circle USD Coin",
  },
};

/**
 * Deterministic plaintext projection of the Telegram HTML the formatter
 * emits. Telegram alert HTML uses a small fixed tag set (`<b>`, `<a>`,
 * `<blockquote expandable>`), so the projection is: anchors become
 * "label: host/path", blockquotes keep their text, remaining tags are
 * stripped, and `escapeHtml` entities are decoded.
 */
export function telegramAlertHtmlToPublicText(html: string): string {
  return html
    .replace(
      /<a href="([^"]+)">([^<]+)<\/a>/g,
      (_match, href: string, text: string) => `${text}: ${href.replace(/^https?:\/\//, "")}`,
    )
    .replace(/<\/?blockquote(?: expandable)?>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Public sample messages, one per family, exactly as the bot sends them
 * (after the plaintext projection above). Kept as literals so the landing
 * page stays a static render; the Worker contract test regenerates each one
 * from `TELEGRAM_ALERT_SAMPLE_FIXTURES` and fails on any mismatch.
 */
export const TELEGRAM_PUBLIC_ALERT_SAMPLES: Record<TelegramAlertType, { message: string }> = {
  dews: {
    message: `DEWS
🟡 USDT — WATCH → ALERT (score: 42)
Top signals: pool_balance_drift (61%), supply_velocity (48%)

View on Pharos: pharos.watch/stablecoin/usdt-tether`,
  },
  depeg: {
    message: `Depeg Detected
▼ USDC — below peg by 1.2% (120 bps)
Price: $0.9880 (peg: $1.00)

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
  },
  safety: {
    message: `Safety Grade Change
USDR — B → F
Score: 70 → 39
Reason: Active depeg peak 7546 bps capped the pre-variant Safety Score at F (39). Now: Safety F 39 · Liquidity 57, DEX TVL $1.2M · Supply $13.1M

View on Pharos: pharos.watch/stablecoin/usdr-tangible`,
  },
  launch: {
    message: `Stablecoin Launched
✦ USDPT — US Dollar Payment Token has launched and is now tracked by Pharos

View on Pharos: pharos.watch/stablecoin/usdpt-western-union`,
  },
  reserve: {
    message: `Reserve Drift
USDC — Circle USD Coin live reserve mix has drifted from its curated profile

View on Pharos: pharos.watch/stablecoin/usdc-circle`,
  },
};
