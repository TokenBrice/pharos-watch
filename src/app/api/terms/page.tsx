import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { formatLongDate } from "@shared/lib/format";
import {
  API_KEY_COMMERCIAL_MONTHLY_REQUEST_QUOTA,
  API_KEY_COMMERCIAL_RATE_LIMIT_PER_MINUTE,
  API_KEY_FREE_PARTNER_MONTHLY_REQUEST_QUOTA,
  API_KEY_FREE_PARTNER_RATE_LIMIT_PER_MINUTE,
  API_KEY_INSTITUTIONAL_MONTHLY_REQUEST_QUOTA,
  API_KEY_INSTITUTIONAL_RATE_LIMIT_PER_MINUTE,
  API_KEY_MONTHLY_QUOTA_EFFECTIVE_SEC,
  DONOR_API_KEY_MONTHLY_REQUEST_QUOTA,
  DONOR_API_KEY_RATE_LIMIT_PER_MINUTE,
} from "@shared/lib/ops-limits";
import {
  API_ACCESS_TELEGRAM_HANDLE,
  API_ACCESS_TELEGRAM_URL,
  API_ACCESS_X_HANDLE,
  API_ACCESS_X_URL,
  API_BREAKING_CHANGE_NOTICE_DAYS,
  COMMERCIAL_API_KEY_EVAL_DAYS,
  COMMERCIAL_API_KEY_USD_PER_MONTH,
  COMMERCIAL_API_KEY_USD_PER_QUARTER,
  COMMERCIAL_API_KEY_USD_PER_YEAR,
  INSTITUTIONAL_API_KEY_USD_PER_MONTH,
  INSTITUTIONAL_API_KEY_USD_PER_YEAR,
  PARTNER_KEY_REPLY_BUSINESS_DAYS,
  PUBLIC_API_HOST,
} from "@shared/lib/public-api-contract";

export const metadata: Metadata = buildPageMetadata({
  title: "API Terms: Keys, Limits And Notice",
  description:
    "Terms for Pharos API keys: scope, data license and attribution, key handling, per-minute and monthly limits, change notice, payment in stablecoins, suspension and contact.",
  canonical: "/api/terms/",
});

const formatRequestQuota = (value: number): string => value.toLocaleString("en-US");
const QUOTA_EFFECTIVE_DATE = formatLongDate(new Date(API_KEY_MONTHLY_QUOTA_EFFECTIVE_SEC * 1000), { utc: true });

export default function ApiTermsPage() {
  return (
    <FeaturePageShell
      breadcrumbName="API Terms"
      path="/api/terms/"
      title="API terms"
      variant="longform"
      containerClassName="max-w-2xl"
      leadParagraphs={["Last updated: November 21, 2026"]}
    >
      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
        <section className="space-y-2">
          <h2 className="pharos-section-title">Scope</h2>
          <p>
            These terms apply to Pharos API keys (supporter, free partner, commercial and institutional) used on{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">{PUBLIC_API_HOST}</code>. The free Safety grades
            lane, embeddable SVG safety badges, and the{" "}
            <Link href="/api/reference/#public-datasets" className="pharos-prose-link">
              published datasets
            </Link>{" "}
            need no key and are outside these terms.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Data license and attribution</h2>
          <p>
            Pharos code, data and data exports are MIT-licensed, and editorial content is licensed under CC BY 4.0.
            These terms govern access to keys, not the data license. Credit &quot;Pharos (pharos.watch)&quot; when you
            republish what the API returns, and, where a response carries third-party market data, also credit its
            upstream sources as shown on the{" "}
            <Link href="/about/" className="pharos-prose-link">
              About page data sources list
            </Link>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Keys</h2>
          <p>
            A key is issued to one holder. Keep it secret and use it from servers and scripts only, never in browser
            code or public repositories. Do not share or resell access. Supporter keys are for personal use: not for
            reselling the data or powering a paid service. Commercial and institutional keys carry no restriction on how
            you use, republish or redistribute the data, beyond the credit above. Pharos may rotate or revoke a leaked key; report
            leaks privately via{" "}
            <a href={API_ACCESS_TELEGRAM_URL} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
              @{API_ACCESS_TELEGRAM_HANDLE} on Telegram
            </a>
            .
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Limits</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Supporter key: {DONOR_API_KEY_RATE_LIMIT_PER_MINUTE} requests per minute,{" "}
              {formatRequestQuota(DONOR_API_KEY_MONTHLY_REQUEST_QUOTA)} requests per month (core read endpoints,
              contract resolver, and the five core stateless MCP tools).
            </li>
            <li>
              Free partner key for non-commercial open-source public goods and academic research (attribution required):{" "}
              {API_KEY_FREE_PARTNER_RATE_LIMIT_PER_MINUTE} requests per minute,{" "}
              {formatRequestQuota(API_KEY_FREE_PARTNER_MONTHLY_REQUEST_QUOTA)} requests per month (core read endpoints,
              contract resolver, and the five core stateless MCP tools).
            </li>
            <li>
              Commercial key: {API_KEY_COMMERCIAL_RATE_LIMIT_PER_MINUTE} requests per minute,{" "}
              {formatRequestQuota(API_KEY_COMMERCIAL_MONTHLY_REQUEST_QUOTA)} requests per month, with higher limits on
              request. Includes Compliance API, Risk-Gate, and the paid MCP tools (
              <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">get_risk_check</code> and{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">get_compliance</code>).
            </li>
            <li>
              Institutional key: {API_KEY_INSTITUTIONAL_RATE_LIMIT_PER_MINUTE} requests per minute,{" "}
              {formatRequestQuota(API_KEY_INSTITUTIONAL_MONTHLY_REQUEST_QUOTA)} requests per month, with higher limits
              on request. Includes everything in Commercial plus priority integration and custom coverage onboarding.
            </li>
          </ul>
          <p>
            Rate limits use fixed 60-second windows; exceeding them returns{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">429</code> with a{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">Retry-After</code> header. Calling a paid-plan
            REST endpoint (Compliance API or Risk-Gate) with a key on a plan that does not include it returns{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">403</code> with{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">reason: &quot;plan_upgrade_required&quot;</code>;
            calling a paid MCP tool on <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">/api/mcp</code>{" "}
            returns a JSON-RPC tool error (<code className="text-xs bg-muted px-1 py-0.5 rounded-sm">isError: true</code>,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">_meta.httpStatus: 403</code>,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">reason: &quot;plan_upgrade_required&quot;</code>).
            Both count against the per-minute limiter without consuming monthly quota. Monthly volume is counted per UTC
            calendar month, resets on the 1st (UTC), and applies from {QUOTA_EFFECTIVE_DATE}. The supporter monthly
            volume changes from the 200,000 requests per month published on November 20, 2026 to{" "}
            {formatRequestQuota(DONOR_API_KEY_MONTHLY_REQUEST_QUOTA)} requests per month for every supporter key before
            monthly enforcement begins on {QUOTA_EFFECTIVE_DATE}.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Changes</h2>
          <p>
            Breaking changes to keyed routes get {API_BREAKING_CHANGE_NOTICE_DAYS} days&apos; notice, announced in the{" "}
            <Link href="/api/reference/" className="pharos-prose-link">
              API reference
            </Link>{" "}
            and the{" "}
            <Link href="/changelog/" className="pharos-prose-link">
              changelog
            </Link>
            . A retired route answers <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">410</code> with its
            replacement.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Payment and term</h2>
          <p>
            Commercial and institutional keys are paid in stablecoins only, to the addresses published on the{" "}
            <Link href="/funding/" className="pharos-prose-link">
              funding page
            </Link>{" "}
            and never to an address sent by direct message. Commercial access is priced at $
            {COMMERCIAL_API_KEY_USD_PER_MONTH} per month, ${COMMERCIAL_API_KEY_USD_PER_QUARTER} per quarter, or $
            {COMMERCIAL_API_KEY_USD_PER_YEAR.toLocaleString("en-US")} per year, with {COMMERCIAL_API_KEY_EVAL_DAYS}-day
            evaluation keys available on request. Institutional access starts at $
            {INSTITUTIONAL_API_KEY_USD_PER_MONTH.toLocaleString("en-US")} per month ($
            {INSTITUTIONAL_API_KEY_USD_PER_YEAR.toLocaleString("en-US")} per year). Access lasts for the paid term and
            renews at the published price. Partial terms are not refunded, unless Pharos ends access early without
            cause, in which case the unused portion is refunded.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Suspension</h2>
          <p>
            Access can be suspended for abuse, for sharing or reselling access, for non-payment, or for traffic that
            endangers the service.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">No advice, no warranty</h2>
          <p>
            Pharos data is informational and is not investment advice. It is provided as is, without warranty and
            without an uptime guarantee. Key-holder requests get a human reply within{" "}
            {PARTNER_KEY_REPLY_BUSINESS_DAYS} business days.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Contact</h2>
          <p>
            Questions about these terms or a key? Message{" "}
            <a href={API_ACCESS_TELEGRAM_URL} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
              @{API_ACCESS_TELEGRAM_HANDLE}
            </a>{" "}
            on Telegram or{" "}
            <a href={API_ACCESS_X_URL} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
              @{API_ACCESS_X_HANDLE}
            </a>{" "}
            on X.
          </p>
        </section>
      </div>
    </FeaturePageShell>
  );
}
