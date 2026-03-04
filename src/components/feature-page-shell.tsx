import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import {
  FeatureStatusBadge,
  type FeatureStatus,
} from "@/components/feature-status-badge";

interface FeaturePageShellProps {
  breadcrumbName: string;
  path: string;
  title: string;
  breadcrumbLabel?: string;
  statusBadge?: {
    status: FeatureStatus;
    version?: string;
  };
  methodology?: {
    version: string;
    changelogPath: string;
  };
  leadParagraphs?: readonly React.ReactNode[];
  preface?: React.ReactNode;
  children: React.ReactNode;
}

export function FeaturePageShell({
  breadcrumbName,
  path,
  title,
  breadcrumbLabel,
  statusBadge,
  methodology,
  leadParagraphs = [],
  preface,
  children,
}: FeaturePageShellProps) {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name={breadcrumbName} path={path} />
      {preface}
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">{breadcrumbLabel ?? breadcrumbName}</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter flex items-center gap-3">
          {title}
          {statusBadge && (
            <FeatureStatusBadge status={statusBadge.status} version={statusBadge.version} />
          )}
        </h1>
        {methodology && (
          <p className="text-xs text-muted-foreground">
            Methodology {methodology.version}.{" "}
            <Link
              href={methodology.changelogPath}
              className="underline underline-offset-4 hover:text-foreground transition-colors"
            >
              Version history &rarr;
            </Link>
          </p>
        )}
        {leadParagraphs.map((paragraph, index) => (
          <p key={index} className="text-sm text-muted-foreground">
            {paragraph}
          </p>
        ))}
      </div>
      {children}
    </div>
  );
}
