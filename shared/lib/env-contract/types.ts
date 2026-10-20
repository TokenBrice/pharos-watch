export type EnvRuntimeName = "worker" | "pagesOps" | "pagesSiteData" | "frontend";
export type EnvRuntimeStatus = "required" | "optional" | "reserved";
export type EnvBindingValueType = "string" | "D1Database" | "KVNamespace" | "R2Bucket" | "WorkerVersionMetadata" | "RateLimit" | "Fetcher" | "Queue<ReserveContinuationMessage>";

export type EnvExampleSection =
  | "frontend"
  | "workerRequired"
  | "workerOptional"
  | "workerReserved"
  | "sharedSiteApiSecret"
  | "pagesSiteDataRequired"
  | "pagesOpsRequired"
  | "pagesOptional";

interface EnvRuntimeUsage {
  status: EnvRuntimeStatus;
  /** Operator-required credentials may still be absent at the runtime ingress. */
  optionalAtIngress?: true;
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
