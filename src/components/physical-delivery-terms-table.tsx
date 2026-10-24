import Link from "next/link";
import { ContentTable } from "@/components/table";
import type { ContentTableRow } from "@/components/table/content-table";
import { PHYSICAL_BAR_CLASS_LABELS, PHYSICAL_VAULT_LOCATION_LABELS } from "@shared/lib/classification";
import { formatUtcDayLabel } from "@shared/lib/format";
import { getCurrentRedemptionConfig } from "@/lib/redemption-review-currency";
import type { PegCurrency } from "@shared/types";
import { buildStablecoinUrl } from "@shared/lib/urls";

const METAL_BY_PEG: Partial<Record<PegCurrency, "XAU" | "XAG">> = { GOLD: "XAU", SILVER: "XAG" };
const NOT_RECORDED = "Not recorded";
const LINK_CLASS = "pharos-focus-ring rounded-sm text-frost-blue underline-offset-2 hover:underline";

const COLUMNS = [
  { id: "token", header: "Token", rowHeader: true },
  { id: "metal", header: "Metal per token" },
  { id: "minimum", header: "Minimum delivery" },
  { id: "bar", header: "Bar class" },
  { id: "vaults", header: "Vaults" },
  { id: "eligibility", header: "Eligibility" },
  { id: "reviewed", header: "Reviewed" },
] as const;

function formatAmount(value: number): string {
  return value.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

function formatDay(isoDate: string): string {
  return formatUtcDayLabel(new Date(`${isoDate}T00:00:00Z`));
}

/**
 * Rows from reviewed physical-delivery redemption terms for the given cohort.
 * A route whose physical review has expired is omitted, never shown as current (R3).
 */
export function buildPhysicalDeliveryRows(
  pegCurrency: PegCurrency,
  coins: readonly { id: string; name: string; symbol: string }[],
  today = new Date().toISOString().slice(0, 10),
): ContentTableRow[] {
  const metal = METAL_BY_PEG[pegCurrency];
  if (!metal) return [];
  const nowSec = Math.floor(Date.parse(`${today}T00:00:00Z`) / 1_000);
  return coins.flatMap((coin) => {
    const config = getCurrentRedemptionConfig(coin.id, nowSec);
    const delivery = config?.physicalCommodityDelivery;
    const route = config?.physicalToUsd;
    if (!config || !delivery || delivery.commodity !== metal) return [];
    if (route && route.reviewExpiresAt < today) return [];
    const minimumTokens = route?.lot.minimumTokens ?? delivery.minimumDeliveryTokens;
    const ouncesPerToken = route?.fineTroyOuncesPerToken ?? delivery.deliverableOuncesPerToken;
    // getCurrentRedemptionConfig only admits configs with a current reviewedAt.
    const reviewedAt = route?.reviewedAt ?? config.reviewedAt!;
    return [{
      id: coin.id,
      cells: {
        token: (
          <Link href={buildStablecoinUrl(coin.id)} className={LINK_CLASS}>
            {coin.name} ({coin.symbol})
          </Link>
        ),
        metal: `${formatAmount(ouncesPerToken)} troy oz`,
        minimum: `${formatAmount(minimumTokens)} ${coin.symbol}`,
        bar: route ? PHYSICAL_BAR_CLASS_LABELS[route.barClass] : NOT_RECORDED,
        vaults: route ? route.vaultLocations.map((location) => PHYSICAL_VAULT_LOCATION_LABELS[location]).join(", ") : NOT_RECORDED,
        eligibility: route ? "Verified customers" : NOT_RECORDED,
        reviewed: formatDay(reviewedAt),
      },
    }];
  });
}

export function PhysicalDeliveryTermsTable({
  pegCurrency,
  coins,
}: {
  pegCurrency: PegCurrency;
  coins: readonly { id: string; name: string; symbol: string }[];
}) {
  const rows = buildPhysicalDeliveryRows(pegCurrency, coins);
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="physical-delivery-terms-title" className="space-y-3">
      <div className="space-y-1.5">
        <h2 id="physical-delivery-terms-title" className="pharos-label">
          Physical delivery terms
        </h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Reviewed issuer terms for taking delivery of metal instead of selling the token. Delivery is limited to
          customers the issuer has verified, and delivery, storage, tax and bank charges can apply on top.
        </p>
      </div>
      <ContentTable tableAriaLabel="Physical delivery terms" columns={COLUMNS} rows={rows} />
      <p className="text-xs leading-relaxed text-muted-foreground">
        Source: Pharos-reviewed redemption terms in this build. Rows whose physical-delivery review has expired are left
        out.
      </p>
    </section>
  );
}
