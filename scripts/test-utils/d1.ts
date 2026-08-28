import { vi } from "vitest";

export type RemoteD1Like = {
  query<T>(sql: string): T[];
  queryRaw(sql: string): string;
  executeStatements(statements: string[], prefix: string): void;
};

export type RemoteD1Mock = RemoteD1Like & {
  executeStatementsMock: ReturnType<typeof vi.fn>;
  queryMock: ReturnType<typeof vi.fn>;
  queryRawMock: ReturnType<typeof vi.fn>;
};

export function createRemoteD1Mock<TQueryRow = Record<string, unknown>>(queryRows: TQueryRow[] = []): RemoteD1Mock {
  const queryMock = vi.fn(() => queryRows);
  const queryRawMock = vi.fn(() => "[]");
  const executeStatementsMock = vi.fn();

  return {
    query: queryMock as RemoteD1Like["query"],
    queryRaw: queryRawMock,
    executeStatements: executeStatementsMock,
    queryMock,
    queryRawMock,
    executeStatementsMock,
  };
}
