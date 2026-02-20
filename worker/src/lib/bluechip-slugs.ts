// Bluechip slug → Pharos DefiLlama ID (only coins in both systems)
// Worker-only: used by sync-bluechip cron to fetch ratings from bluechip.org
export const BLUECHIP_SLUG_MAP: Record<string, string> = {
  usdc: "2",
  usdt: "1",
  dai: "5",
  lusd: "8",
  bold: "269",
  pyusd: "120",
  paxg: "gold-paxg",
  xaut: "gold-xaut",
  gusd: "19",
  usdp: "11",
  eurc: "50",
  fdusd: "119",
  frax: "6",
  gho: "118",
  tusd: "7",
  rlusd: "250",
  xsgd: "289",
};
