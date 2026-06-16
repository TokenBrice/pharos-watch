import type { ReactNode } from "react";

// Maps ISO-4217 currency codes to ISO-3166 country codes for flag lookup.
// Limited to currencies with reference-rate benchmarks; extend as new currencies
// are added to the yield benchmark registry.
const CURRENCY_TO_COUNTRY: Record<string, string> = {
  USD: "US",
  EUR: "EU",
  GBP: "GB",
  JPY: "JP",
  CHF: "CH",
  AUD: "AU",
  CAD: "CA",
  BRL: "BR",
  MXN: "MX",
  ZAR: "ZA",
  CNY: "CN",
  CNH: "CN",
  RUB: "RU",
  TRY: "TR",
  IDR: "ID",
  SGD: "SG",
  PHP: "PH",
};

// Compact inline SVG flags sized for a 16×12 viewBox so they read cleanly at
// 20×15 in the table. Designed for recognition next to the ISO code, not for
// vexillological accuracy — fine detail (stars, mottoes) is intentionally
// omitted so the glyph stays sharp at small sizes.
//
// Intentionally a subset of CURRENCY_TO_COUNTRY: country codes without an entry
// here (MX, ZA, CN, TR, ID, SG, PH) deliberately fall back to the two-letter
// text box in CurrencyFlag below rather than ship a low-fidelity glyph for a
// rarely-shown benchmark. Add an entry here when a currency becomes prominent.
const FLAGS: Record<string, ReactNode> = {
  US: (
    <>
      <rect width="16" height="12" fill="#B22234" />
      <g fill="#FFFFFF">
        <rect y="0.923" width="16" height="0.923" />
        <rect y="2.769" width="16" height="0.923" />
        <rect y="4.615" width="16" height="0.923" />
        <rect y="6.461" width="16" height="0.923" />
        <rect y="8.308" width="16" height="0.923" />
        <rect y="10.154" width="16" height="0.923" />
      </g>
      <rect width="6.4" height="6.461" fill="#3C3B6E" />
    </>
  ),
  EU: (
    <>
      <rect width="16" height="12" fill="#003399" />
      <g fill="#FFCC00">
        <circle cx="8" cy="3.2" r="0.4" />
        <circle cx="10.4" cy="3.84" r="0.4" />
        <circle cx="11.84" cy="5.6" r="0.4" />
        <circle cx="12.2" cy="7.84" r="0.4" />
        <circle cx="11.2" cy="9.6" r="0.4" />
        <circle cx="9.2" cy="10.4" r="0.4" />
        <circle cx="6.8" cy="10.4" r="0.4" />
        <circle cx="4.8" cy="9.6" r="0.4" />
        <circle cx="3.8" cy="7.84" r="0.4" />
        <circle cx="4.16" cy="5.6" r="0.4" />
        <circle cx="5.6" cy="3.84" r="0.4" />
        <circle cx="8" cy="8.8" r="0.4" />
      </g>
    </>
  ),
  CH: (
    <>
      <rect width="16" height="12" fill="#D52B1E" />
      <rect x="4.5" y="5.25" width="7" height="1.5" fill="#FFFFFF" />
      <rect x="7.25" y="2.5" width="1.5" height="7" fill="#FFFFFF" />
    </>
  ),
  BR: (
    <>
      <rect width="16" height="12" fill="#009C3B" />
      <polygon points="8,1.5 14.5,6 8,10.5 1.5,6" fill="#FEDF00" />
      <circle cx="8" cy="6" r="2.4" fill="#002776" />
    </>
  ),
  AU: (
    <>
      <rect width="16" height="12" fill="#012169" />
      <g>
        <line x1="0" y1="0" x2="8" y2="6" stroke="#FFFFFF" strokeWidth="0.8" />
        <line x1="8" y1="0" x2="0" y2="6" stroke="#FFFFFF" strokeWidth="0.8" />
        <line x1="0" y1="0" x2="8" y2="6" stroke="#C8102E" strokeWidth="0.3" />
        <line x1="8" y1="0" x2="0" y2="6" stroke="#C8102E" strokeWidth="0.3" />
      </g>
      <rect x="3.6" y="0" width="0.8" height="6" fill="#FFFFFF" />
      <rect x="0" y="2.6" width="8" height="0.8" fill="#FFFFFF" />
      <rect x="3.75" y="0" width="0.5" height="6" fill="#C8102E" />
      <rect x="0" y="2.75" width="8" height="0.5" fill="#C8102E" />
      <circle cx="4" cy="9.5" r="0.5" fill="#FFFFFF" />
      <circle cx="12" cy="3" r="0.4" fill="#FFFFFF" />
      <circle cx="13.2" cy="5.2" r="0.4" fill="#FFFFFF" />
      <circle cx="12.6" cy="7.6" r="0.4" fill="#FFFFFF" />
      <circle cx="11.4" cy="9" r="0.35" fill="#FFFFFF" />
      <circle cx="13.6" cy="8.4" r="0.3" fill="#FFFFFF" />
    </>
  ),
  CA: (
    <>
      <rect width="4" height="12" fill="#D52B1E" />
      <rect x="4" width="8" height="12" fill="#FFFFFF" />
      <rect x="12" width="4" height="12" fill="#D52B1E" />
      <path
        d="M8 2 L8.4 3.7 L9.6 3.3 L9.2 5 L10.7 5.5 L9.4 6.4 L9.9 8.2 L8.4 7.7 L8.2 9.4 L8 8.6 L7.8 9.4 L7.6 7.7 L6.1 8.2 L6.6 6.4 L5.3 5.5 L6.8 5 L6.4 3.3 L7.6 3.7 Z"
        fill="#D52B1E"
      />
    </>
  ),
  GB: (
    <>
      <rect width="16" height="12" fill="#012169" />
      <line x1="0" y1="0" x2="16" y2="12" stroke="#FFFFFF" strokeWidth="1.5" />
      <line x1="16" y1="0" x2="0" y2="12" stroke="#FFFFFF" strokeWidth="1.5" />
      <line x1="0" y1="0" x2="16" y2="12" stroke="#C8102E" strokeWidth="0.7" />
      <line x1="16" y1="0" x2="0" y2="12" stroke="#C8102E" strokeWidth="0.7" />
      <rect x="7" y="0" width="2" height="12" fill="#FFFFFF" />
      <rect x="0" y="5" width="16" height="2" fill="#FFFFFF" />
      <rect x="7.4" y="0" width="1.2" height="12" fill="#C8102E" />
      <rect x="0" y="5.4" width="16" height="1.2" fill="#C8102E" />
    </>
  ),
  JP: (
    <>
      <rect width="16" height="12" fill="#FFFFFF" />
      <circle cx="8" cy="6" r="3.6" fill="#BC002D" />
    </>
  ),
  RU: (
    <>
      <rect width="16" height="4" fill="#FFFFFF" />
      <rect y="4" width="16" height="4" fill="#0039A6" />
      <rect y="8" width="16" height="4" fill="#D52B1E" />
    </>
  ),
};

export function CurrencyFlag({ currency, className }: { currency: string; className?: string }) {
  const country = CURRENCY_TO_COUNTRY[currency];
  const flag = country ? FLAGS[country] : null;
  if (!flag) {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex h-[15px] w-5 items-center justify-center rounded-[2px] bg-muted/40 text-[8px] font-mono tabular-nums text-muted-foreground/70 ring-1 ring-border/40 ${className ?? ""}`}
      >
        {currency.slice(0, 2)}
      </span>
    );
  }
  return (
    <svg
      viewBox="0 0 16 12"
      width="20"
      height="15"
      aria-hidden="true"
      className={`shrink-0 rounded-[2px] ring-1 ring-border/40 ${className ?? ""}`}
      preserveAspectRatio="xMidYMid slice"
    >
      {flag}
    </svg>
  );
}
