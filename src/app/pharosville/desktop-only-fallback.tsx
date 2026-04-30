import Link from "next/link";

const FALLBACK_LINKS = [
  { href: "/stability-index/", label: "PSI" },
  { href: "/stablecoins/", label: "Stablecoins" },
  { href: "/chains/", label: "Chains" },
  { href: "/depeg/", label: "Depegs" },
  { href: "/cemetery/", label: "Cemetery" },
];

export function DesktopOnlyFallback() {
  return (
    <section className="pharosville-narrow" aria-labelledby="pharosville-narrow-title">
      <div className="pharosville-narrow__inner">
        <div className="pharosville-narrow__beacon" aria-hidden="true" />
        <p className="pharosville-narrow__kicker">Desktop map</p>
        <h2 id="pharosville-narrow-title">PharosVille needs a wider harbor.</h2>
        <p>
          PharosVille is a desktop-only map for now. Open this page on a screen at least 1280px wide and 760px tall.
        </p>
        <nav className="pharosville-narrow__links" aria-label="Pharos analytics">
          {FALLBACK_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </section>
  );
}
