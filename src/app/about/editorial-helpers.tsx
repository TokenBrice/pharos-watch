import type { ReactNode } from "react";

type AboutEditorialSectionProps = {
  eyebrow: string;
  title: string;
  children: ReactNode;
};

export function createAboutEditorialSection(idPrefix: string, headingClassName: string) {
  return function AboutEditorialSection({
    eyebrow,
    title,
    children,
  }: AboutEditorialSectionProps) {
    const slug = eyebrow.replace(/\s+/g, "-").toLowerCase();
    const headingId = `${idPrefix}-${slug}`;

    return (
      <section aria-labelledby={headingId} className="space-y-5">
        <header className="space-y-2">
          <p className="pharos-kicker">{eyebrow}</p>
          <h2 id={headingId} className={headingClassName}>
            {title}
          </h2>
          <div className="h-px bg-border/60" aria-hidden="true" />
        </header>
        {children}
      </section>
    );
  };
}
