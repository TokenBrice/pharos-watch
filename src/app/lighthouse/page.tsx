import type { Metadata } from "next";
import Link from "next/link";
import { buildPageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = buildPageMetadata({
  title: "PharosVille",
  description: "PharosVille has moved to /pharosville/.",
  canonical: "/pharosville/",
  robots: {
    index: false,
    follow: true,
  },
});

export default function LegacyLighthouseRedirectPage() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 text-center">
      <meta httpEquiv="refresh" content="0; url=/pharosville/" />
      <script dangerouslySetInnerHTML={{ __html: "location.replace('/pharosville/')" }} />
      <h1 className="text-2xl font-semibold">PharosVille has moved</h1>
      <p className="text-sm text-muted-foreground">
        The old Lighthouse route now lives at PharosVille.
      </p>
      <Link className="pharos-focus-ring rounded-md border border-border px-4 py-2 text-sm" href="/pharosville/">
        Open PharosVille
      </Link>
    </main>
  );
}
