import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";

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
  },
};

export default function PrivacyPage() {
  return (
    <div className="space-y-6 max-w-2xl">
      <BreadcrumbJsonLd name="Privacy Policy" path="/privacy/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Privacy Policy</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground">Last updated: February 2026</p>
      </div>

      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">What We Collect</h2>
          <p>
            Pharos collects anonymized usage analytics through Google Analytics 4 (GA4) and Cloudflare
            Web Analytics. This includes page views, session duration, approximate geographic region, and
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
            GA4 data is retained for 14 months per Google&apos;s default settings. Cloudflare Analytics
            data is retained for 6 months. We do not maintain any additional databases of visitor information.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">Third-Party Services</h2>
          <p>
            Pharos is hosted on Cloudflare Pages with API endpoints served by Cloudflare Workers.
            Analytics data is processed by Google (GA4) and Cloudflare. No data is shared with any other
            third parties.
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
    </div>
  );
}
