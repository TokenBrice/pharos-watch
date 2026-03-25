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
      leadParagraphs={["Last updated: March 2026"]}
    >
      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
        <div className="rounded-[1.35rem] border border-border/60 bg-card/70 px-5 py-4 shadow-[0_14px_32px_oklch(0_0_0_/0.1)]">
          <p className="pharos-kicker">Policy Summary</p>
          <p className="mt-2 text-sm text-foreground">
            Pharos does not ask for accounts or wallet connections. Portfolio data stays in your browser, analytics are
            anonymized when enabled, and support requests route through the feedback/contact channels listed below.
          </p>
        </div>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">What We Collect</h2>
          <p>
            When a Google Analytics 4 (GA4) measurement ID is configured for the current deployment, Pharos collects
            anonymized usage analytics such as page views, session duration, approximate geographic region, device or
            browser type, and a small set of product-interaction events. If you choose to share a Telegram or X handle
            in the feedback form, we store that handle privately for follow-up on that submission. We do not otherwise
            collect personally identifiable information (PII).
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">No Accounts or Wallet Connections</h2>
          <p>
            Pharos does not require user accounts, logins, or wallet connections. There is no sign-up process, no email
            collection, and no authentication of any kind. Optional feedback contact details are self-declared and are
            not used as site accounts or persistent user identities.
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
            maintain user-account databases. Feedback submissions, including optional follow-up contact details when you
            provide them, are retained in our operational database for product support and issue tracking.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Third-Party Services</h2>
          <p>
            Pharos is hosted on Cloudflare Pages with API endpoints served by Cloudflare Workers. Analytics data is
            processed by Google (GA4) only when analytics is enabled for the current deployment. Feedback submissions
            are also forwarded to GitHub Issues for product triage; optional Telegram/X handles are
            echoed publicly in those GitHub issues.
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
