import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { INDEXABLE_ROBOTS } from "@/lib/seo-robots";
import { PENDING_TTL_SEC, TELEGRAM_ALERT_TTL_SEC } from "@shared/lib/telegram-delivery-policy";

// Retention prose derives from the shared delivery policy so the public
// inventory cannot drift from production TTL constants (TGB-028).
const RISK_ALERT_TTL_HOURS = PENDING_TTL_SEC / 3600;
const LAUNCH_ALERT_TTL_MINUTES = TELEGRAM_ALERT_TTL_SEC.launch / 60;
const ADMIN_ALERT_TTL_MINUTES = TELEGRAM_ALERT_TTL_SEC.adminBroadcast / 60;

export const metadata: Metadata = {
  title: "Pharos Privacy Policy: Analytics, API & Telegram Data",
  description:
    "Pharos privacy policy for analytics, feedback, API access requests, Telegram alert subscriptions, portfolio-local storage, and selector share links.",
  alternates: {
    canonical: "/privacy/",
  },
  robots: INDEXABLE_ROBOTS,
  openGraph: {
    title: "Pharos Privacy Policy: Analytics, API & Telegram Data",
    description:
      "Pharos privacy policy for analytics, feedback, API access requests, Telegram alert subscriptions, portfolio-local storage, and selector share links.",
    url: "/privacy/",
    type: "website",
    images: [{ url: "/og-card.png", width: 1200, height: 628 }],
  },
};

export default function PrivacyPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Privacy Policy"
      path="/privacy/"
      title="Privacy Policy"
      variant="longform"
      containerClassName="max-w-2xl"
      leadParagraphs={["Last updated: July 2026"]}
    >
      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
        <div className="pharos-card-shell px-5 py-4">
          <p className="pharos-kicker">Policy Summary</p>
          <p className="mt-2 text-sm text-foreground">
            Pharos does not ask for accounts or wallet connections. Portfolio data and homepage shortcut preferences
            are stored locally by default, share links encode holdings in the URL, analytics are anonymized when
            enabled, and support or API-access requests route through the feedback/contact channels listed below.
            Stablecoin Picker functional browser storage and share snapshots are described below.
          </p>
        </div>

        <section className="space-y-2">
          <h2 className="pharos-section-title">What We Collect</h2>
          <p>
            When a Google Analytics 4 (GA4) measurement ID is configured for the current deployment, public Pharos
            website routes collect anonymized usage analytics such as page views, session duration, approximate
            geographic region, device or browser type, and a small set of product-interaction events. The embedded
            PharosWatchBot Mini App is excluded from GA4 and Web Vitals collection. If you choose to share a Telegram
            or X handle in the feedback form, that handle is included in the GitHub issue created for the submission.
            Telegram alert subscriptions store chat ID, optional username, followed coins, alert settings, quiet hours,
            snooze state,
            and short-lived pending-command or pending-alert metadata; subscriber rows with no follows or pending state
            and no Telegram activity for 180 days are automatically purged by a weekly cleanup job. If you request API
            access, Pharos stores the email address you verify plus any name, organization, project URL, use-case,
            intended-endpoint, cadence, and volume details you submit; request throttling stores salted hashes of IP
            address and user-agent data. Homepage saved shortcuts store only an ordered list of route hrefs in
            browser-local storage and are not sent to the API. The Stablecoin Picker stores local browser state for
            callout dismissal and tab-scoped result recovery, and share links can store a content-addressed snapshot of
            the generated selector output in Cloudflare KV.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Stablecoin Picker Storage</h2>
          <p>
            The Picker at <code className="text-xs bg-muted px-1 py-0.5 rounded">/screener/picker/</code> uses
            functional browser storage. The long-lived local key in the current build is the callout dismissal key,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">pharos.selector.callout.v1</code>. It is scoped to
            this site, does not contain an IP address or user identifier, and remains until you clear browser site data.
            A tab-scoped <code className="text-xs bg-muted px-1 py-0.5 rounded">sessionStorage</code> key,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">pharos.selector.sessionResult.v1</code>, can hold the
            last successful live result for accidental navigation recovery and clears when the browser session ends.
          </p>
          <p>
            Picker share links use a <code className="text-xs bg-muted px-1 py-0.5 rounded">sid</code> that points to a
            Cloudflare Pages KV snapshot of the form answers and resulting output. Snapshot IDs are content-addressed,
            so identical answers against an identical dataset produce the same ID. Anyone with the link can view the
            frozen artifact. Snapshots do not include IP addresses, browser fingerprints, or account identifiers, and
            are retained for five years.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Telegram Data and Retention</h2>
          <p>
            PharosWatchBot stores only what is required to deliver alerts and keep the bot reliable. The full list of
            Telegram-owned tables and how long each one is retained:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Subscribers</strong> (chat ID, optional username, default alert flags, quiet hours, snooze state,
              last-active timestamp): auto-purged after 180 days of inactivity once no follows or pending state remain.
            </li>
            <li>
              <strong>Per-coin and preset subscriptions</strong>: live settings are retained until{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/unsubscribe all</code> or{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/forget</code>. Inactivity cleanup removes only
              inert per-coin rows after 180 days; preset follows and meaningful per-coin settings do not expire for
              inactivity.
            </li>
            <li>
              <strong>Pending disambiguation</strong> (ambiguous ticker prompts, setup wizard state, bulk-action
              confirmations): 5-minute TTL.
            </li>
            <li>
              <strong>Pending alerts</strong> (overflow and retry queue for delivery): {RISK_ALERT_TTL_HOURS}-hour TTL
              for depeg, DEWS, safety, reserve, freeze, and legacy alerts; {LAUNCH_ALERT_TTL_MINUTES}-minute TTL for launch
              alerts and {ADMIN_ALERT_TTL_MINUTES}-minute TTL for admin broadcasts.
            </li>
            <li>
              <strong>Alert job manifests and per-target audit</strong>: 90-day retention. A private-chat{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/forget</code> removes that chat&apos;s target
              rows and per-target item lineage, planning snapshots, rendered target plans, and transport-failure
              observations; aggregate job manifests remain until their normal prune.
            </li>
            <li>
              <strong>Freeze event and recipient lineage</strong>: immutable Tape and blacklist source identities plus
              the one-time opt-in recipient cohort are retained for 90 days. A private-chat{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/forget</code> removes that chat&apos;s freeze
              target rows immediately; source events remain until their normal audit prune.
            </li>
            <li>
              <strong>Dead-letter audit trail</strong> for expired or permanently failed deliveries: 90-day retention,
              or immediate removal for that chat through{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/forget</code>.
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
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/health</code>: kept while the subscriber exists,
              with a 90-day stale prune.
            </li>
          </ul>
          <p>
            For the PharosWatchBot Mini App, the signed Telegram{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">initData</code> body is never persisted. It is
            validated request-locally through Telegram&apos;s HMAC signature and freshness window. Mutations use a
            5-minute auth window plus a bounded per-user Pharos edit budget, while read-only session and watchlist
            portability requests accept a Telegram-signed launch up to 24 hours old so an open panel stays usable
            across the day. Exported watchlist tokens and pasted import tokens are returned or decoded request-locally
            and are not stored as token blobs. The embedded route does not load
            Google Analytics or report Web Vitals. After signed authentication succeeds, the Worker records only
            low-cardinality daily counters for Mini App adoption, operation outcomes, and error categories; those
            aggregate rows contain no chat ID.
          </p>
          <p>
            Inline-mode status queries use public tracked-coin data. Pharos stores only aggregate query and selected-card
            counters; query text, inline query IDs, result IDs, chat IDs, and user IDs are not persisted in D1 or custom
            Worker logs.
          </p>
          <p>
            The Telegram Worker also emits sampled operational logs to Cloudflare Workers Logs for reliability and
            incident response. Telegram-specific custom log records are limited to operation names, bounded counts,
            status codes, retry timing, and fixed error categories. They exclude chat and user IDs, update and callback
            identifiers, message or callback content, URLs, bot tokens, and Mini App{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">initData</code>. Cloudflare processes these records in
            the Pharos Cloudflare account, where access follows the account&apos;s permissions. This repository does not
            configure a separate Logpush archive or a Telegram-log retention duration. Per-chat incident investigation
            uses the private operator diagnostics backed by D1 instead of general logs.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">No Accounts or Wallet Connections</h2>
          <p>
            Pharos does not require user accounts, logins, or wallet connections for the website. Optional feedback
            contact details and self-serve API request emails are self-declared and are not used as site accounts.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Cookies</h2>
          <p>
            On GA4-enabled public website routes, the only cookies set by Pharos are those required by Google Analytics
            4 (e.g.,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">_ga</code>,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">_ga_*</code>) for distinguishing unique visitors. No
            advertising or tracking cookies are used. The embedded PharosWatchBot Mini App does not load GA4 or set
            GA4 cookies.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Data Retention</h2>
          <p>
            When GA4 is enabled, analytics data is retained for 14 months per Google&apos;s default settings. We do not
            maintain user-account databases. Feedback submissions are sent to GitHub Issues for product support and
            issue tracking; optional follow-up contact details are included there when you provide them. The worker
            stores rate-limit metadata for feedback abuse prevention. A legacy `feedback_submissions` table exists in
            the D1 schema, but the current submission path does not write to it. Self-serve API key requests are stored
            for operator review and duplicate-claim enforcement; verification tokens are stored only as hashes and
            expire after 30 minutes. Issued self-serve API keys expire after 60 days by default. Homepage shortcut
            preferences remain until reset or browser site data is cleared. Picker localStorage remains until browser
            site data is cleared. Picker KV snapshots are retained for five years because they are content-addressed
            analytical records rather than user-account records.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="pharos-section-title">Third-Party Services</h2>
          <p>
            Pharos is hosted on Cloudflare Pages with API endpoints served by Cloudflare Workers. Analytics data is
            processed by Google (GA4) only when analytics is enabled for the current deployment and never from the
            embedded PharosWatchBot Mini App route. Feedback submissions
            are also forwarded to GitHub Issues for product triage; optional Telegram/X handles are echoed publicly in
            those GitHub issues. API request verification emails are sent through Resend. API key issuance records stay
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
