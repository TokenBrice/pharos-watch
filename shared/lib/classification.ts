import type { BackingType, GovernanceType, PegCurrency } from "../types";

export * from "./classification/index";

export const HERO_CHIP_PEG_LABELS = {
  USD: "USD-Pegged",
  EUR: "EUR-Pegged",
  GBP: "GBP-Pegged",
  CHF: "CHF-Pegged",
  BRL: "BRL-Pegged",
  RUB: "RUB-Pegged",
  JPY: "JPY-Pegged",
  KRW: "KRW-Pegged",
  IDR: "IDR-Pegged",
  INR: "INR-Pegged",
  MYR: "MYR-Pegged",
  SGD: "SGD-Pegged",
  HKD: "HKD-Pegged",
  TRY: "TRY-Pegged",
  AUD: "AUD-Pegged",
  ZAR: "ZAR-Pegged",
  CAD: "CAD-Pegged",
  CNY: "CNY-Pegged",
  CNH: "CNH-Pegged",
  PHP: "PHP-Pegged",
  MXN: "MXN-Pegged",
  VND: "VND-Pegged",
  UAH: "UAH-Pegged",
  ARS: "ARS-Pegged",
  KGS: "KGS-Pegged",
  NGN: "NGN-Pegged",
  XOF: "XOF-Pegged",
  COP: "COP-Pegged",
  CLP: "CLP-Pegged",
  GHS: "GHS-Pegged",
  KES: "KES-Pegged",
  PEN: "PEN-Pegged",
  GOLD: "GOLD-Pegged",
  SILVER: "SILVER-Pegged",
  VAR: "VAR-Pegged",
  OTHER: "OTHER-Pegged",
} as const satisfies Record<PegCurrency, string>;

export const HERO_CHIP_BACKING_LABELS = {
  "rwa-backed": "RWA-Backed",
  "crypto-backed": "Crypto-Backed",
  algorithmic: "Algorithmic",
} as const satisfies Record<BackingType, string>;

export const HERO_CHIP_GOVERNANCE_LABELS = {
  centralized: "Centralized",
  "centralized-dependent": "Dependent",
  decentralized: "Decentralized",
} as const satisfies Record<GovernanceType, string>;
