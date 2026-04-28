export type EnvRuntimeName = "worker" | "pagesOps" | "pagesSiteData" | "frontend";
export type EnvRuntimeStatus = "required" | "optional" | "reserved";
export type EnvBindingValueType = "string" | "D1Database";

export type EnvExampleSection =
  | "frontend"
  | "workerRequired"
  | "workerOptional"
  | "workerReserved"
  | "sharedSiteApiSecret"
  | "pagesOpsRequired"
  | "pagesOptional";

interface EnvRuntimeUsage {
  order: number;
  status: EnvRuntimeStatus;
}

interface EnvExampleEntry {
  section: EnvExampleSection;
  value: string;
}

interface EnvDocEntry {
  includeInOperatorOriginAccess?: boolean;
}

export interface EnvBindingDefinition {
  key: string;
  valueType: EnvBindingValueType;
  description: string;
  docs?: EnvDocEntry;
  example?: EnvExampleEntry;
  runtimes: Partial<Record<EnvRuntimeName, EnvRuntimeUsage>>;
}
