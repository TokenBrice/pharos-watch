export const CEMETERY_HERO_COPY = {
  title: "Stablecoin Cemetery",
  recordedDeaths: "Recorded deaths",
  latestDeathPrefix: "Latest recorded death · ",
} as const;

export function formatCemeteryPlaque(total: number, firstYear: number): string {
  return `${total} interred · first recorded death ${firstYear}`;
}
