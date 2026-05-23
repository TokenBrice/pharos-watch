import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { MicaLoadingState } from "@/app/mica/loading";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildPageMetadata } from "@/lib/page-metadata";
import type { FaqItem } from "@/lib/faq";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

const micaDescription =
  "EU MiCA compliance tracker: authorization status, EMT/ART token type, competent authority, and issuer entity for tracked stablecoins, with sourced register links.";

export const metadata = buildPageMetadata({
  title: "MiCA Compliance Tracker: EU Stablecoin Authorization Status",
  description: micaDescription,
  canonical: "/mica/",
  ogImage: `${SITE_URL}/og-card.png`,
});

const MICA_FAQ_ITEMS = [
  {
    question: "What does the MiCA Compliance Tracker show?",
    answer:
      "It maps tracked stablecoins to their standing under the EU Markets in Crypto-Assets Regulation (MiCA, Regulation (EU) 2023/1114): authorization status, token type (EMT vs ART), the supervising competent authority, the authorized issuer entity, and per-coin register references. It covers only coins that have been assessed; the rest are left out of the table.",
  },
  {
    question: "What is the difference between an EMT and an ART?",
    answer:
      "An e-money token (EMT) references a single official currency — most fiat-backed EUR and USD stablecoins are EMTs. An asset-referenced token (ART) references a basket or other value, such as a multi-currency mix or a commodity. ARTs are rare in the tracked set.",
  },
  {
    question: "Does a 2026 grandfathering window mean issuers are exempt until then?",
    answer:
      "No. The MiCA issuer rules for EMTs and ARTs have applied since 30 June 2024 with no grandfathering for issuance. The transitional window that runs to around mid-2026 covers crypto-asset service providers and venues, not issuers, so a 'transitional' status here refers to venue-level cover, not issuer authorization.",
  },
  {
    question: "Is this legal or compliance advice?",
    answer:
      "No. The tracker is an informational surface with sourced links, not legal advice. Statuses are editorial assignments against public registers and may lag real-world authorizations or delistings. Confirm any status against the underlying ESMA, EBA, or national-authority register before relying on it.",
  },
] as const satisfies readonly FaqItem[];

const MICA_STATIC_SECTION = (
  <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div className="rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
      <p className="pharos-kicker">How To Read MiCA Status</p>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Authorized</span> means the issuer holds an in-effect EMI or
          credit-institution authorization listed on a competent-authority register.{" "}
          <span className="font-medium text-foreground">Pending</span> and{" "}
          <span className="font-medium text-foreground">transitional</span> mark applications in flight or venue-level
          grandfathering. <span className="font-medium text-foreground">Non-compliant</span> means in-scope with no
          authorization path. <span className="font-medium text-foreground">Out of scope</span> means not offered to the
          EU public.
        </p>
        <p>
          This tracker is <span className="font-medium text-foreground">informational and sourced — not legal advice</span>.
          Statuses are editorial assignments against public registers and may lag real authorizations or delistings.
          Confirm against the linked register before relying on a status.
        </p>
      </div>
    </div>
    <div className="rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
      <p className="pharos-kicker">Best Questions</p>
      <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
        <li>Is the issuer actually authorized, or relying on a transitional venue window?</li>
        <li>Which national authority supervises it, and under what authorization route?</li>
        <li>Is it an EMT or ART, and is it an EBA-supervised &ldquo;significant&rdquo; token?</li>
      </ul>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Pair this with{" "}
        <Link
          href="/screener/"
          className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
        >
          Screener
        </Link>{" "}
        and{" "}
        <Link
          href="/safety-scores/"
          className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
        >
          Safety Scores
        </Link>{" "}
        for a fuller risk picture.
      </p>
    </div>
  </section>
);

export default createClientFeaturePage({
  loadClient: () => import("./client").then((m) => ({ default: m.MicaClient })),
  loading: <MicaLoadingState />,
  shell: {
    breadcrumbName: "MiCA Tracker",
    path: "/mica/",
    title: "MiCA Compliance Tracker",
    leadParagraphs: [
      "EU MiCA authorization status, token type, and supervising authority across assessed stablecoins — sourced to public registers.",
    ],
    headerSupplement: (
      <p className="pharos-lead hidden sm:block">
        MiCA (Regulation (EU) 2023/1114) sets the EU framework for e-money tokens (EMTs) and asset-referenced tokens
        (ARTs). This is an informational tracking surface with sourced links, not legal advice.
      </p>
    ),
  },
  beforeClient: MICA_STATIC_SECTION,
  afterClient: <FaqSection items={MICA_FAQ_ITEMS} includeJsonLd />,
});
