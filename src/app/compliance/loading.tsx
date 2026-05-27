import {
  PageLoadingHeader,
  PageLoadingRowList,
  PageLoadingShell,
} from "@/components/page-loading-skeleton";

const COMPLIANCE_SKELETON_ROW_COUNT = 10;

export function ComplianceLoadingState() {
  return (
    <PageLoadingShell>
      <PageLoadingHeader sectionWidth="w-24" titleWidth="w-64 sm:w-80" />

      <PageLoadingRowList
        rowCount={COMPLIANCE_SKELETON_ROW_COUNT}
        titleWidth="w-40"
        actionWidth="w-20"
        primaryWidth="w-32"
        metricWidths={["w-20", "w-24", "w-16"]}
      />
    </PageLoadingShell>
  );
}

export default function Loading() {
  return <ComplianceLoadingState />;
}
