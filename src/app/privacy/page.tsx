import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Pharos privacy policy: what data we collect, how we use it, and your choices.",
  alternates: {
    canonical: "/privacy/",
  },
  openGraph: {
    title: "Privacy Policy",
    description: "Pharos privacy policy: what data we collect, how we use it, and your choices.",
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
      leadParagraphs={["Last updated: May 2026"]}
    >
      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
        <div className="rounded-[1.35rem] border border-border/60 bg-card/70 px-5 py-4 shadow-[0_14px_32px_oklch(0_0_0_/0.1)]">
          <p className="pharos-kicker">Policy Summary</p>
          <p className="mt-2 text-sm text-foreground">
            Pharos does not ask for accounts or wallet connections. Portfolio data is stored locally by default, share
            links encode holdings in the URL, analytics are anonymized when enabled, and support or API-access requests
            route through the feedback/contact channels listed below.
          </p>
        </div>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">What We Collect</h2>
          <p>
            When a Google Analytics 4 (GA4) measurement ID is configured for the current deployment, Pharos collects
            anonymized usage analytics such as page views, session duration, approximate geographic region, device or
            browser type, and a small set of product-interaction events. If you choose to share a Telegram or X handle
            in the feedback form, that handle is included in the GitHub issue created for the submission. Telegram alert
            subscriptions store chat ID, optional username, followed coins, alert settings, quiet hours, snooze state,
            and short-lived pending-command or pending-alert metadata; subscriber rows with no follows or pending state
            and no Telegram activity for 180 days are automatically purged by a weekly cleanup job. If you request API access, Pharos stores the
            email address you verify plus any name, organization, project URL, use-case, intended-endpoint, cadence, and
            volume details you submit; request throttling stores salted hashes of IP address and user-agent data.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Telegram Data and Retention</h2>
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
              <strong>Per-coin and preset subscriptions</strong>: kept while the subscriber exists, cleared by{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/unsubscribe all</code> or the inactivity prune.
            </li>
            <li>
              <strong>Pending disambiguation</strong> (ambiguous ticker prompts, setup wizard state, bulk-action
              confirmations): 5-minute TTL.
            </li>
            <li>
              <strong>Pending alerts</strong> (overflow and retry queue for delivery): 1-hour TTL for depeg, DEWS, and
              safety; 30-minute TTL for launch and admin broadcasts.
            </li>
            <li>
              <strong>Alert job manifests and per-target audit</strong>: 90-day retention.
            </li>
            <li>
              <strong>Dead-letter audit trail</strong> for expired or permanently failed deliveries: 90-day retention.
            </li>
            <li>
              <strong>Processed-update idempotency claims</strong>: 7-day prune.
            </li>
            <li>
              <strong>Daily usage aggregates</strong>: privacy-preserving counters only; no chat ID is stored. 400-day
              retention.
            </li>
            <li>
              <strong>Daily watcher lifecycle snapshots</strong>: aggregate-only public pulse history.
            </li>
            <li>
              <strong>Per-chat delivery diagnostics</strong> used by{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/health</code>: kept while the subscriber exists,
              with a 90-day stale prune.
            </li>
          </ul>
          <p>
            For the PharosWatchBot Mini App, the signed Telegram{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">initData</code> body is never persisted. Only its
            hash is recorded once per mutation for one-shot replay protection within the 5-minute mutation window.
            Read-only session launches accept a Telegram-signed launch up to 24 hours old so an open panel stays usable
            across the day.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">No Accounts or Wallet Connections</h2>
          <p>
            Pharos does not require user accounts, logins, or wallet connections for the website. Optional feedback
            contact details and self-serve API request emails are self-declared and are not used as site accounts.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Cookies</h2>
          <p>
            When analytics is enabled, the only cookies set by Pharos are those required by Google Analytics 4 (e.g.,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">_ga</code>,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">_ga_*</code>) for distinguishing unique visitors. No
            advertising or tracking cookies are used.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Data Retention</h2>
          <p>
            When GA4 is enabled, analytics data is retained for 14 months per Google&apos;s default settings. We do not
            maintain user-account databases. Feedback submissions are sent to GitHub Issues for product support and issue
            tracking; optional follow-up contact details are included there when you provide them. The worker stores
            rate-limit metadata for feedback abuse prevention. A legacy `feedback_submissions` table exists in the D1
            schema, but the current submission path does not write to it. Self-serve API key requests are stored for
            operator review and duplicate-claim enforcement; verification tokens are stored only as hashes and expire
            after 30 minutes. Issued self-serve API keys expire after 60 days by default.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Third-Party Services</h2>
          <p>
            Pharos is hosted on Cloudflare Pages with API endpoints served by Cloudflare Workers. Analytics data is
            processed by Google (GA4) only when analytics is enabled for the current deployment. Feedback submissions
            are also forwarded to GitHub Issues for product triage; optional Telegram/X handles are
            echoed publicly in those GitHub issues. API request verification emails are sent through Resend. API key
            issuance notifications can create private operator GitHub issues, but those notifications include request ID,
            key prefix, quota, expiry, and an ops link only, not requester details or plaintext tokens.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Contact</h2>
          <p>
            Questions about this policy? Reach out on{" "}
            <a
              href="https://x.com/PharosWatch"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
            >
              @PharosWatch
            </a>{" "}
            or via the{" "}
            <Link
              href="/about"
              className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors"
            >
              About page
            </Link>
            .
          </p>
        </section>
      </div>
    </FeaturePageShell>
  );
}
