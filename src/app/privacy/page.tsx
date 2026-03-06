import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Pharos privacy policy: what data we collect, how we use it, and your choices.",
  alternates: {
    canonical: "/privacy/",
  },
  openGraph: {
    title: "Privacy Policy",
    description:
      "Pharos privacy policy: what data we collect, how we use it, and your choices.",
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
      leadParagraphs={["Last updated: February 2026"]}
    >
      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">What We Collect</h2>
          <p>
            Pharos collects anonymized usage analytics through Google Analytics 4 (GA4).
            This includes page views, session duration, approximate geographic region, and
            device/browser type. We do not collect personally identifiable information (PII).
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">No Accounts or Wallet Connections</h2>
          <p>
            Pharos does not require user accounts, logins, or wallet connections. There is no sign-up
            process, no email collection, and no authentication of any kind.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Cookies</h2>
          <p>
            The only cookies set by Pharos are those required by Google Analytics 4 (e.g., <code className="text-xs bg-muted px-1 py-0.5 rounded">_ga</code>,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">_ga_*</code>) for distinguishing unique visitors.
            No advertising or tracking cookies are used.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Data Retention</h2>
          <p>
            GA4 data is retained for 14 months per Google&apos;s default settings.
            We do not maintain any additional databases of visitor information.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Third-Party Services</h2>
          <p>
            Pharos is hosted on Cloudflare Pages with API endpoints served by Cloudflare Workers.
            Analytics data is processed by Google (GA4). No data is shared with any other third parties.
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
            </a>
            {" "}or via the{" "}
            <Link href="/about" className="text-foreground underline underline-offset-4 hover:text-sky-500 transition-colors">
              About page
            </Link>.
          </p>
        </section>
      </div>
    </FeaturePageShell>
  );
}
