import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  API_ACCESS_TELEGRAM_HANDLE,
  API_ACCESS_TELEGRAM_URL,
  API_ACCESS_X_HANDLE,
  API_ACCESS_X_URL,
} from "@shared/lib/public-api-contract";
import { PENDING_TTL_SEC, TELEGRAM_ALERT_TTL_SEC } from "@shared/lib/telegram-delivery-policy";

// Retention prose derives from the shared delivery policy so the public
// inventory cannot drift from production TTL constants (TGB-028).
const RISK_ALERT_TTL_HOURS = PENDING_TTL_SEC / 3600;
const ADMIN_ALERT_TTL_MINUTES = TELEGRAM_ALERT_TTL_SEC.adminBroadcast / 60;

export const metadata: Metadata = buildPageMetadata({
  title: "Privacy Policy: Analytics, API & Telegram Data",
  description:
    "Pharos privacy policy for analytics, feedback, API access requests, Telegram alert subscriptions, portfolio-local storage, and selector share links.",
  canonical: "/privacy/",
});

export default function PrivacyPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Privacy Policy"
      path="/privacy/"
      title="Privacy Policy"
      variant="longform"
      containerClassName="max-w-2xl"
      leadParagraphs={["Last updated: October 27, 2026"]}
    >
      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
        <div className="pharos-card-shell px-5 py-4">
          <p className="pharos-label">Policy summary</p>
          <p className="mt-2 text-sm text-foreground">
            Pharos does not ask for accounts. The only wallet interaction is the optional supporter API key claim on
            the API page, which stores a wallet address, key prefix, and claim time. Portfolio data and homepage
            shortcut preferences are stored locally by default, share links encode holdings in the URL, analytics are
            anonymized when enabled, support requests route through the feedback channel described below, and
            API-access requests arrive by Telegram or X direct message. Stablecoin Picker functional browser storage
            and share snapshots are described below.
          </p>
        </div>

        <section className="space-y-2">
          <h2 className="pharos-section-title">What we collect</h2>
          <p>
            When Google Analytics 4 (GA4) is enabled, public pages on pharos.watch
            collect anonymized usage analytics such as page views, session duration, approximate
            geographic region, device or browser type, and a small set of product-interaction events. Page URLs and referrers sent to Google Analytics include only the origin and path, such as https://pharos.watch/portfolio/. Query parameters and URL fragments, including shared portfolio holdings, are not sent. The embedded
            PharosWatchBot Mini App, operator pages, and preview deployments are excluded from GA4 and Web Vitals collection. If you choose to share a Telegram
            or X handle in the feedback form, that handle is included in the GitHub issue created for the submission.
            Telegram alert subscriptions store chat ID, optional username, followed coins, alert settings, quiet hours,
            snooze state,
            and short-lived pending-command or pending-alert metadata; subscriber rows with no follows or pending state
            and no Telegram activity for 180 days are automatically purged by a weekly cleanup job. If you request API
            access, Pharos receives your Telegram or X direct message and deletes it once the key is issued or rotated;
            request throttling stores salted hashes of IP address and user-agent data. Homepage saved shortcuts store
            only an ordered list of route hrefs in
            browser-local storage and are not sent to the API. The Stablecoin Picker stores local browser state for
            callout dismissal and tab-scoped result recovery, and share links can store a content-addressed snapshot of
            the generated selector output in Cloudflare KV.
          </p>
          <p>
            The homepage saves a compact copy of public market, stability-index and incident evidence in
            IndexedDB on your device. Stablecoin detail pages also keep compact public price and supply summaries
            for up to 20 recently used coin IDs. These copies contain no personal data, credentials, portfolio
            holdings, page URLs or visit timestamps and are not sent to the API. Saved values are labelled retained
            with their original dates and are ignored after 72 hours or an incompatible data-version change.
            Older detail entries are removed as newer coins are used. Clearing browser site data removes these copies.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Stablecoin picker storage</h2>
          <p>
            The Picker at <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">/screener/picker/</code> uses
            functional browser storage. The long-lived local key in the current build is the callout dismissal key,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">pharos.selector.callout.v1</code>. It is scoped to
            this site, does not contain an IP address or user identifier, and remains until you clear browser site data.
            A tab-scoped <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">sessionStorage</code> key,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">pharos.selector.sessionResult.v1</code>, can hold the
            answers from the last successful live run and their save time for accidental navigation recovery, not the
            generated result. Restoring them regenerates a shortlist against current data. This clears when the browser session ends.
          </p>
          <p>
            Picker share links use a <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">sid</code> that points to a
            Cloudflare Pages KV snapshot of the form answers and resulting output. Snapshot IDs are content-addressed,
            so identical answers against an identical dataset produce the same ID. Anyone with the link can view the
            frozen artifact. Snapshots do not include IP addresses, browser fingerprints, or account identifiers, and
            expire after 90 days if never opened; the first successful read extends retention to five years.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Telegram Data and Retention</h2>
          <p>
            PharosWatchBot stores only what is required to deliver alerts and keep the bot reliable. Storage categories
            include:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Subscribers</strong> (chat ID, optional username, default alert flags, quiet hours, snooze state,
              last-active timestamp): auto-purged after 180 days of inactivity once no follows or
              pending state remain.
            </li>
            <li>
              <strong>Per-coin and preset subscriptions</strong>: live settings are retained until{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">/unsubscribe all</code> or{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">/forget</code>. Inactivity cleanup removes only
              inert per-coin rows after 180 days; preset follows and meaningful per-coin settings do not expire for
              inactivity.
            </li>
            <li>
              <strong>Queued alert deliveries</strong>: {RISK_ALERT_TTL_HOURS}-hour TTL for depeg, DEWS, safety,
              reserve, and freeze alerts and {ADMIN_ALERT_TTL_MINUTES}-minute TTL for admin broadcasts. Message text is
              cleared once a delivery finishes; the delivery outcome (state, attempts, error category) is kept for
              90 days. <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">/forget</code> removes that chat&apos;s
              delivery rows, roll-up records and pending changes immediately.
            </li>
            <li>
              <strong>Retired features</strong>: records from the retired personalized recap, the legacy alert queue
              and its dead-letter, planning and freeze-recipient audit trails were deleted when their tables were
              dropped.
            </li>
            <li>
              <strong>Processed-update idempotency claims</strong>: 7-day prune.
            </li>
            <li>
              <strong>Daily usage aggregates</strong>: privacy-preserving counters only; no chat ID is stored. 400-day
              retention.
            </li>
            <li>
              <strong>Daily watcher lifecycle snapshots</strong>: aggregate-only public pulse history with 400-day
              retention.
            </li>
            <li>
              <strong>Per-chat delivery diagnostics</strong> used by{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">/health</code>: kept while the subscriber exists,
              with a 90-day stale prune.
            </li>
          </ul>
          <p>
            For the PharosWatchBot Mini App, the signed Telegram{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">initData</code> body is never persisted. It is
            validated request-locally through Telegram&apos;s HMAC signature and freshness window. Mutations use a
            5-minute auth window plus a bounded per-user Pharos edit budget, while read-only session and bulk-watchlist
            preview requests accept a Telegram-signed launch up to 24 hours old so an open panel stays usable across
            the day. The embedded route does not load Google Analytics or report Web Vitals. After signed
            authentication succeeds, the Worker records only low-cardinality daily counters for Mini App operation
            outcomes and error categories; those aggregate rows contain no chat ID.
          </p>
          <p>
            PharosWatchBot no longer records sign-up funnel telemetry: landing-page Telegram links are plain links
            with no click counter, and bot starts, setup completions, first follows, and first Mini App edits are no
            longer counted by campaign. The previously collected aggregate funnel rows and the salted-IP click-quota
            rows have been deleted.
          </p>
          <p>
            The Telegram Worker also emits sampled operational logs to Cloudflare Workers Logs for reliability and
            incident response. Telegram-specific custom log records are limited to operation names, bounded counts,
            status codes, retry timing, and fixed error categories. They exclude chat and user IDs, update and callback
            identifiers, message or callback content, URLs, bot tokens, and Mini App{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">initData</code>. Cloudflare processes these records in
            the Pharos Cloudflare account, where access follows the account&apos;s permissions. This repository does not
            configure a separate Logpush archive or a Telegram-log retention duration. Per-chat incident investigation
            uses the private operator diagnostics backed by D1 instead of general logs.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">No accounts</h2>
          <p>
            Pharos does not require user accounts or logins for the website. Optional feedback contact details and
            API-access request details sent by direct message are self-declared and are not used as site accounts.
          </p>
          <p>
            The one exception is optional: the supporter API key claim on{" "}
            <Link href="/api/" className="pharos-prose-link">
              the API page
            </Link>{" "}
            asks a wallet to sign a short text message so the key can be tied to a donating wallet. Pharos stores the
            wallet address, the issued key prefix, and the claim time, plus the key record itself, which is named after
            the address and carries the last-used timestamp and route that every API key records. Those records are
            retained without an automatic expiry. Deactivation stops access but does not delete these records. You
            can request removal of the key record and its usage metadata by messaging{" "}
            <a
              href={API_ACCESS_TELEGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-prose-link"
            >
              @{API_ACCESS_TELEGRAM_HANDLE}
            </a>{" "}
            on Telegram or sending a direct message to{" "}
            <a
              href={API_ACCESS_X_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-prose-link"
            >
              @{API_ACCESS_X_HANDLE}
            </a>{" "}
            on X. We retain the wallet address, key prefix, and claim time to prevent a second claim, unless an
            operator explicitly approves removing that restriction. The public donation ledger is a separate record.
            Signatures and plaintext API tokens are never persistently stored or logged; only a keyed hash verifies
            the token. An unsaved token remains in browser memory across internal navigation so you can recover it,
            until you copy or acknowledge it or leave or reload the site. It is never written to localStorage or
            sessionStorage.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Cookies</h2>
          <p>
            On GA4-enabled public website routes, the only cookies set by Pharos are those required by Google Analytics
            4 (e.g.,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">_ga</code>,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded-sm">_ga_*</code>) for distinguishing unique visitors. No
            advertising or tracking cookies are used. The embedded PharosWatchBot Mini App does not load GA4 or set
            GA4 cookies.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Data retention</h2>
          <p>
            When GA4 is enabled, analytics retention is controlled by the externally configured GA4 property rather than
            guaranteed by repository code. We do not
            maintain user-account databases. Feedback submissions are sent to GitHub Issues for product support and
            issue tracking; optional follow-up contact details are included there when you provide them. The worker
            stores rate-limit metadata for feedback abuse prevention. The current submission path does not persist a
            separate D1 submission row. The self-serve API key request lane was retired in September 2026; stored
            request records remain in private operator storage until a planned cleanup deletes them, and no new
            requests are accepted. Issued self-serve API keys expire after 60 days. Partner-key, lost-key, and
            key-removal requests arrive by
            Telegram or X direct message and are deleted once the key is issued or rotated. Homepage shortcut
            preferences remain until reset or browser site data is cleared. Picker localStorage remains until browser
            site data is cleared. Unread Picker KV snapshots expire after 90 days; the first successful read extends
            retention to five years because they are content-addressed analytical records rather than user-account records.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Third-Party Services</h2>
          <p>
            Pharos is hosted on Cloudflare Pages with API endpoints served by Cloudflare Workers. Analytics data is
            processed by Google (GA4) only when analytics is enabled on the public website, excluding
            operator pages, preview deployments, and the embedded PharosWatchBot Mini App. Feedback submissions
            are also forwarded to GitHub Issues for product triage; optional Telegram/X handles are echoed publicly in
            those GitHub issues. API key issuance records stay
            in private operator storage and structured Worker logs; requester details and key material are not published
            to GitHub Issues.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Contact</h2>
          <p>
            Questions about this policy? Reach out on{" "}
            <a
              href="https://x.com/PharosWatch"
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-prose-link"
            >
              @PharosWatch
            </a>{" "}
            or via the{" "}
            <Link href="/about/" className="pharos-prose-link">
              About page
            </Link>
            .
          </p>
        </section>
      </div>
    </FeaturePageShell>
  );
}
