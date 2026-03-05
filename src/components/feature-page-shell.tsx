import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import {
  FeatureStatusBadge,
  type FeatureStatus,
} from "@/components/feature-status-badge";
import { cn } from "@/lib/utils";

interface FeaturePageShellProps {
  breadcrumbName: string;
  path: string;
  title: string;
  variant?: "standard" | "longform" | "auth-gated";
  containerClassName?: string;
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
  variant = "standard",
  containerClassName,
  breadcrumbLabel,
  statusBadge,
  methodology,
  leadParagraphs = [],
  preface,
  children,
}: FeaturePageShellProps) {
  const variantClassName =
    variant === "longform"
      ? "mx-auto w-full max-w-3xl space-y-6"
      : variant === "auth-gated"
        ? "mx-auto w-full max-w-5xl space-y-6"
        : "space-y-6";

  return (
    <div className={cn(variantClassName, containerClassName)}>
      <BreadcrumbJsonLd name={breadcrumbName} path={path} />
      {preface}
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">{breadcrumbLabel ?? breadcrumbName}</span>
        </nav>
        <div className="flex max-w-full flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="min-w-0 text-4xl font-extrabold tracking-tighter">
            {title}
          </h1>
          {statusBadge && (
            <FeatureStatusBadge status={statusBadge.status} version={statusBadge.version} />
          )}
        </div>
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
