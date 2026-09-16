/** DefiLlama protocol slugs that represent one dedicated gold token. */
export const DEDICATED_SINGLE_TOKEN_GOLD_PROTOCOL_SLUGS: Readonly<Record<string, true>> = {
  "tether-gold": true,
  "paxos-gold": true,
};

export function isDedicatedSingleTokenGoldProtocolSlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEDICATED_SINGLE_TOKEN_GOLD_PROTOCOL_SLUGS, slug);
}
