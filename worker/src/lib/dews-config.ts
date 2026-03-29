export const DEWS_SIGNAL_WEIGHTS = {
  supply: 0.25,
  pool: 0.2,
  liq: 0.15,
  price: 0.15,
  diverg: 0.15,
  black: 0.1,
  flow: 0.1,
  yield: 0.05,
} as const;

export const DEWS_THREAT_BANDS = [
  { upper: 15, band: "CALM" },
  { upper: 35, band: "WATCH" },
  { upper: 55, band: "ALERT" },
  { upper: 75, band: "WARNING" },
  { upper: 100, band: "DANGER" },
] as const;
