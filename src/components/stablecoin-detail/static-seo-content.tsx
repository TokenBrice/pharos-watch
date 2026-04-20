import type { StablecoinMeta } from "@shared/types";

export function StablecoinDetailSeoContent({ coin }: { coin: StablecoinMeta }) {
  return (
    <div className="sr-only">
      <h1>
        {coin.name} ({coin.symbol}) stablecoin analytics
      </h1>
    </div>
  );
}
