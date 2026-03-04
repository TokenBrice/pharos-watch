import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import {
  MethodologyVersionCard,
  type MethodologyChangelogEntry,
} from "@/components/methodology-version-card";

interface MethodologyChangelogPageProps {
  breadcrumbName: string;
  path: string;
  title: string;
  lead: React.ReactNode;
  accentClass: string;
  entries: readonly MethodologyChangelogEntry[];
}

export function MethodologyChangelogPage({
  breadcrumbName,
  path,
  title,
  lead,
  accentClass,
  entries,
}: MethodologyChangelogPageProps) {
  return (
    <div className="space-y-8">
      <BreadcrumbJsonLd name={breadcrumbName} path={path} />

      <div className="space-y-2">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link href="/" className="hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <span>/</span>
          <Link href="/methodology" className="hover:text-foreground transition-colors">
            Methodology
          </Link>
          <span>/</span>
          <span className="text-foreground">{title}</span>
        </nav>

        <h1 className="text-4xl font-extrabold tracking-tighter">{title}</h1>

        <p className="text-sm text-muted-foreground">{lead}</p>
      </div>

      <div className="space-y-4">
        {entries.map((entry) => (
          <MethodologyVersionCard key={entry.version} entry={entry} accentClass={accentClass} />
        ))}
      </div>
    </div>
  );
}
