import type { MockTableConfig } from "@shared/test-utils/mock-d1";
import type { ApiKeyRow } from "../lib/api-key-core";
import { makeApiKeyRow } from "./__shared/fixtures";

export interface RequestAttributionTableOptions {
  includeApiKey?: boolean;
  workerChanges?: number;
  apiKeyChanges?: number;
  workerPruneChanges?: number;
  apiKeyPruneChanges?: number;
  apiKeyFailure?: unknown;
  workerPruneFailure?: unknown;
  apiKeyPruneFailure?: unknown;
}

function failureOverride(failure: unknown): Pick<MockTableConfig, "throwError"> | Record<string, never> {
  return failure === undefined ? {} : { throwError: failure };
}

export function makeRequestAttributionTables(
  options: RequestAttributionTableOptions = {},
): MockTableConfig[] {
  return [
    {
      match: "INSERT INTO api_request_consumer_stats",
      rows: [],
      runMeta: { changes: options.workerChanges ?? 1 },
    },
    ...(options.includeApiKey
      ? [
          {
            match: "INSERT INTO api_key_request_stats",
            rows: [],
            runMeta: { changes: options.apiKeyChanges ?? 1 },
            ...failureOverride(options.apiKeyFailure),
          },
        ]
      : []),
    {
      match: "DELETE FROM api_request_consumer_stats",
      rows: [],
      runMeta: { changes: options.workerPruneChanges ?? 0 },
      ...failureOverride(options.workerPruneFailure),
    },
    {
      match: "DELETE FROM api_key_request_stats",
      rows: [],
      runMeta: { changes: options.apiKeyPruneChanges ?? 0 },
      ...failureOverride(options.apiKeyPruneFailure),
    },
  ];
}

type ApiKeyMutationStatementOverrides = Partial<
  Pick<MockTableConfig, "runMeta" | "throwError" | "delayMs" | "allowUnused">
>;

export interface ApiKeyMutationTableOptions {
  id?: number;
  keyPrefix?: string;
  secretHash?: string;
  existingRow?: Partial<ApiKeyRow>;
  update?: ApiKeyMutationStatementOverrides;
  audit?: ApiKeyMutationStatementOverrides;
  postMutationRow?: Partial<ApiKeyRow> | null;
}

export function makeApiKeyMutationTables(
  options: ApiKeyMutationTableOptions = {},
): MockTableConfig[] {
  const existingRow = makeApiKeyRow({
    id: options.id ?? 7,
    key_prefix: options.keyPrefix ?? "0123456789abcdef",
    secret_hash: options.secretHash ?? "hash",
    ...options.existingRow,
  });
  const postMutationRow = options.postMutationRow === null
    ? null
    : makeApiKeyRow({ ...existingRow, ...options.postMutationRow });

  return [
    {
      match: "key_prefix,\n       secret_hash,\n       name",
      matchBinds: [existingRow.id],
      first: existingRow,
      rows: [],
    },
    {
      match: "UPDATE api_keys",
      rows: [],
      runMeta: { changes: 1 },
      ...options.update,
    },
    {
      match: "INSERT INTO api_key_audit_log",
      rows: [],
      runMeta: { changes: 1 },
      ...options.audit,
    },
    {
      match: "key_prefix,\n       name,\n       owner_email",
      matchBinds: [existingRow.id],
      first: postMutationRow,
      rows: [],
    },
  ];
}
