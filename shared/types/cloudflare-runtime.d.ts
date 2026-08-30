/*! *****************************************************************************
Copyright (c) Cloudflare. All rights reserved.
Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at http://www.apache.org/licenses/LICENSE-2.0
THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED
WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A PARTICULAR PURPOSE,
MERCHANTABLITY OR NON-INFRINGEMENT.
See the Apache Version 2.0 License for specific language governing permissions
and limitations under the License.
***************************************************************************** */
/**
 * Vendored from @cloudflare/workers-types@5.20260730.1.
 *
 * This shared type-only module exists so the root workspace carries no
 * dependency on the package (its >=5.20260821 global Node-compat shims
 * collide with @types/node in the root project). It lives under shared/types
 * so shared test utilities remain a base layer and never import functions/.
 * Extend only when functions/ code needs new surface; the upstream package
 * wins on semantics.
 */

export interface KVNamespaceListKey<Metadata, Key extends string = string> {
  name: Key;
  expiration?: number;
  metadata?: Metadata;
}

export type KVNamespaceListResult<Metadata, Key extends string = string> =
  | {
      list_complete: false;
      keys: KVNamespaceListKey<Metadata, Key>[];
      cursor: string;
      cacheStatus: string | null;
    }
  | {
      list_complete: true;
      keys: KVNamespaceListKey<Metadata, Key>[];
      cacheStatus: string | null;
    };

export interface KVNamespace<Key extends string = string> {
  get(
    key: Key,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Promise<string | null>;
  get(key: Key, type: "text"): Promise<string | null>;
  get<ExpectedValue = unknown>(
    key: Key,
    type: "json",
  ): Promise<ExpectedValue | null>;
  get(key: Key, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  get(key: Key, type: "stream"): Promise<ReadableStream | null>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"text">,
  ): Promise<string | null>;
  get<ExpectedValue = unknown>(
    key: Key,
    options?: KVNamespaceGetOptions<"json">,
  ): Promise<ExpectedValue | null>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"arrayBuffer">,
  ): Promise<ArrayBuffer | null>;
  get(
    key: Key,
    options?: KVNamespaceGetOptions<"stream">,
  ): Promise<ReadableStream | null>;
  get(key: Array<Key>, type: "text"): Promise<Map<string, string | null>>;
  get<ExpectedValue = unknown>(
    key: Array<Key>,
    type: "json",
  ): Promise<Map<string, ExpectedValue | null>>;
  get(
    key: Array<Key>,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Promise<Map<string, string | null>>;
  get(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"text">,
  ): Promise<Map<string, string | null>>;
  get<ExpectedValue = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"json">,
  ): Promise<Map<string, ExpectedValue | null>>;
  list<Metadata = unknown>(
    options?: KVNamespaceListOptions,
  ): Promise<KVNamespaceListResult<Metadata, Key>>;
  put(
    key: Key,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Promise<void>;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Promise<KVNamespaceGetWithMetadataResult<string, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "text",
  ): Promise<KVNamespaceGetWithMetadataResult<string, Metadata>>;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Key,
    type: "json",
  ): Promise<KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "arrayBuffer",
  ): Promise<KVNamespaceGetWithMetadataResult<ArrayBuffer, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    type: "stream",
  ): Promise<KVNamespaceGetWithMetadataResult<ReadableStream, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"text">,
  ): Promise<KVNamespaceGetWithMetadataResult<string, Metadata>>;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"json">,
  ): Promise<KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"arrayBuffer">,
  ): Promise<KVNamespaceGetWithMetadataResult<ArrayBuffer, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    key: Key,
    options: KVNamespaceGetOptions<"stream">,
  ): Promise<KVNamespaceGetWithMetadataResult<ReadableStream, Metadata>>;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    type: "text",
  ): Promise<Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>>;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Array<Key>,
    type: "json",
  ): Promise<
    Map<string, KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>
  >;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    options?: Partial<KVNamespaceGetOptions<undefined>>,
  ): Promise<Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>>;
  getWithMetadata<Metadata = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"text">,
  ): Promise<Map<string, KVNamespaceGetWithMetadataResult<string, Metadata>>>;
  getWithMetadata<ExpectedValue = unknown, Metadata = unknown>(
    key: Array<Key>,
    options?: KVNamespaceGetOptions<"json">,
  ): Promise<
    Map<string, KVNamespaceGetWithMetadataResult<ExpectedValue, Metadata>>
  >;
  delete(key: Key): Promise<void>;
}

export interface KVNamespaceListOptions {
  limit?: number;
  prefix?: string | null;
  cursor?: string | null;
}

export interface KVNamespaceGetOptions<Type> {
  type: Type;
  cacheTtl?: number;
}

export interface KVNamespacePutOptions {
  expiration?: number;
  expirationTtl?: number;
  // Upstream workers-types intentionally exposes untyped KV metadata.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any | null;
}

export interface KVNamespaceGetWithMetadataResult<Value, Metadata> {
  value: Value | null;
  metadata: Metadata | null;
  cacheStatus: string | null;
}

export interface D1Meta {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
  /**
   * The region of the database instance that executed the query.
   */
  served_by_region?: string;
  /**
   * The three letters airport code of the colo that executed the query.
   */
  served_by_colo?: string;
  /**
   * True if-and-only-if the database instance that executed the query was the primary.
   */
  served_by_primary?: boolean;
  timings?: {
    /**
     * The duration of the SQL query execution by the database instance. It doesn't include any network time.
     */
    sql_duration_ms: number;
  };
  /**
   * Number of total attempts to execute the query, due to automatic retries.
   * Note: All other fields in the response like `timings` only apply to the last attempt.
   */
  total_attempts?: number;
}

export interface D1Response {
  success: true;
  meta: D1Meta & Record<string, unknown>;
  error?: never;
}

export type D1Result<T = unknown> = D1Response & {
  results: T[];
};

export interface D1ExecResult {
  count: number;
  duration: number;
}

export type D1SessionConstraint =
  // Indicates that the first query should go to the primary, and the rest queries
  // using the same D1DatabaseSession will go to any replica that is consistent with
  // the bookmark maintained by the session (returned by the first query).
  | "first-primary"
  // Indicates that the first query can go anywhere (primary or replica), and the rest
  // queries using the same D1DatabaseSession will go to any replica that is consistent
  // with the bookmark maintained by the session (returned by the first query).
  | "first-unconstrained";

export type D1SessionBookmark = string;

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  /**
   * Creates a new D1 Session anchored at the given constraint or the bookmark.
   * All queries executed using the created session will have sequential consistency,
   * meaning that all writes done through the session will be visible in subsequent reads.
   *
   * @param constraintOrBookmark Either the session constraint or the explicit bookmark to anchor the created session.
   */
  withSession(
    constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint,
  ): D1DatabaseSession;
  /**
   * @deprecated dump() will be removed soon, only applies to deprecated alpha v1 databases.
   */
  dump(): Promise<ArrayBuffer>;
}

export interface D1DatabaseSession {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  /**
   * @returns The latest session bookmark across all executed queries on the session.
   *          If no query has been executed yet, `null` is returned.
   */
  getBookmark(): D1SessionBookmark | null;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
}
