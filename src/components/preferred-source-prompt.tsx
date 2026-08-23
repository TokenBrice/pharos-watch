import { SITE_ORIGIN } from "@shared/lib/runtime-origins";

/**
 * Google Preferred Sources deeplink.
 *
 * When a reader marks Pharos as a preferred source, Google surfaces it more
 * prominently for that reader in Top Stories, AI Overviews and AI Mode, with a
 * "preferred" badge. Google reports readers are roughly twice as likely to
 * click through to a preferred source.
 *
 * This is the deeplink implementation rather than Google's recommended
 * `news.google.com/swg/js/v1/publisher.js` button. The script would be a
 * third-party dependency on every page of a static export that inlines
 * critical CSS and enforces a build-size budget, and it renders a
 * Google-styled control that does not belong in this design system. The
 * tradeoff: the scripted flow returns the reader to their exact scroll
 * position, the deeplink does not — so this opens in a new tab to keep the
 * Pharos page intact.
 *
 * The `q` parameter takes a bare host, not a URL, and Google only accepts
 * domain and subdomain level entries. Derived from SITE_ORIGIN so it cannot
 * drift if the canonical host changes.
 */
const PREFERRED_SOURCE_HOST = new URL(SITE_ORIGIN).host;

export const PREFERRED_SOURCE_URL = `https://www.google.com/preferences/source?q=${PREFERRED_SOURCE_HOST}`;

export function PreferredSourcePrompt({ className }: { className?: string }) {
  return (
    <section className={className ? `pharos-card-shell space-y-2 px-5 py-5 ${className}` : "pharos-card-shell space-y-2 px-5 py-5"}>
      <p className="pharos-kicker">Preferred source</p>
      <p className="text-sm leading-6 text-muted-foreground">
        Reading Pharos regularly? Mark it as a preferred source and Google will surface Pharos Watch more often in
        Top Stories, AI Overviews, and AI Mode.
      </p>
      <a
        href={PREFERRED_SOURCE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="pharos-focus-ring text-frost-blue underline-offset-2 hover:underline"
      >
        Add Pharos Watch in Google ↗
      </a>
    </section>
  );
}
