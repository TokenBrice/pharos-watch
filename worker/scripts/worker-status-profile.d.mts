export interface ProfileQueryResult {
  success?: boolean;
  results?: Array<Record<string, unknown>>;
  meta?: Record<string, unknown>;
}

export type ProfileQuery = (sql: string, params: unknown[]) => Promise<ProfileQueryResult>;

interface ProfileStatement {
  bind(...values: unknown[]): ProfileStatement;
  all(): Promise<ProfileQueryResult>;
  run(): Promise<ProfileQueryResult>;
  first(column?: string): Promise<unknown>;
  raw(): Promise<unknown[][]>;
}

export interface ReadOnlyProfileDb {
  prepare(sql: string): ProfileStatement;
  batch(statements: ProfileStatement[]): Promise<ProfileQueryResult[]>;
  withSession(): ReadOnlyProfileDb;
}

export function createReadOnlyProfileDb(query: ProfileQuery, receipts: object[]): ReadOnlyProfileDb;

// Method signatures keep handler/tracker parameters bivariant for narrow test doubles.
export interface ProfileStatusRouteOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  query?: ProfileQuery;
  handler?(args: { db: ReadOnlyProfileDb; request: Request; trustedAdmin: boolean }): Promise<Response>;
  trackerFactory?(db: ReadOnlyProfileDb): { db: unknown; snapshot(): { queries: number; reasons: readonly string[] } };
}

export interface ProfileStatusRouteResult {
  schemaVersion: 1;
  generatedAt: string;
  route: string;
  mode: string;
  statements: number;
  rowsRead: number | null;
  sqlDurationMs: number | null;
  durationMs: number;
  d1Cost: unknown;
  httpStatus: number;
  sectionErrors: string[];
  selfCheck: { coverage: string; reason: string | null; cost: unknown; startedAt?: unknown };
  coverage: "complete" | "partial";
  reasons: string[];
  limitations: string[];
}

export function profileStatusRoute(options?: ProfileStatusRouteOptions): Promise<ProfileStatusRouteResult>;
