import { sqlString } from "./remote-d1";

type Client = {
  queryRaw(sql: string): string;
  executeStatementsRaw?(statements: string[], prefix: string): string;
};

const SQL_QUOTED_OR_COMMENT = /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g;

function writeSql(sql: string): { rendered: string; dml: boolean } {
  // Strip only code-external tokens; INSERT ... SELECT is still a write.
  const tokens = sql.replace(SQL_QUOTED_OR_COMMENT, " ").trim();
  const code = tokens.replace(/;$/, "").trim();
  if (!/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(code) ||
      /\bRETURNING\b/i.test(code) || code.includes(";")) {
    throw new Error("backfill-d1-batch-requires-nonreturning-writes");
  }
  // A newline terminates trailing -- comments before appending a receipt.
  return { rendered: `${sql}\n${tokens.endsWith(";") ? "" : ";"}`, dml: /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(code) };
}

/** Render D1 positional bindings without treating quoted/commented question marks as parameters. */
export function bindBackfillSql(sql: string, bindings: readonly unknown[]): string {
  let cursor = 0;
  const rendered = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|\?(\d*)/g, (token, index: string | undefined) => {
    if (!token.startsWith("?")) return token;
    const position = index ? Number(index) - 1 : cursor;
    cursor = Math.max(cursor, position + 1);
    if (position < 0 || position >= bindings.length) throw new Error("Missing SQL binding");
    const value = bindings[position];
    if (value === null) return "NULL";
    if (typeof value === "string") return sqlString(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "1" : "0";
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return `X'${Buffer.from(bytes).toString("hex")}'`;
    }
    throw new Error("Unsupported SQL binding");
  });
  if (cursor !== bindings.length) throw new Error("Unused SQL bindings");
  return rendered;
}

/**
 * Ordinary writes use the query API, one write plus changes() per command.
 * Atomic batches require explicit import opt-in: D1 imports can interrupt live
 * availability. Import receipts remain recoverable if readback/cleanup fails.
 */
export function createBackfillDatabase(client: Client, options: {
  atomicImports?: boolean;
  onUncertainAtomicOutcome?: (receipt: string) => void;
} = {}): D1Database {
  const decode = (raw: string, expected?: number): D1Result<Record<string, unknown>>[] => {
    const envelopes: unknown = JSON.parse(raw);
    if (!Array.isArray(envelopes) || (expected !== undefined && envelopes.length !== expected)) {
      throw new Error("backfill-d1-envelope-invalid");
    }
    return envelopes.map((value) => {
      const row = value as D1Result<Record<string, unknown>>;
      if (row?.success !== true || !Array.isArray(row.results) || !row.meta) {
        throw new Error("backfill-d1-query-failed");
      }
      return row;
    });
  };
  const statements = new WeakMap<D1PreparedStatement, () => string>();
  const runWrite = (sql: string): D1Result => {
    const { rendered, dml } = writeSql(sql);
    const [result, receipt] = decode(client.queryRaw(`${rendered} SELECT ${dml ? "changes()" : "0"} AS __pharos_changes;`), 2);
    const changes = (receipt!.results[0] as { __pharos_changes?: number } | undefined)?.__pharos_changes;
    if (receipt!.results.length !== 1 || !Number.isSafeInteger(changes) || changes! < 0) {
      throw new Error("backfill-d1-receipt-invalid");
    }
    return { ...result!, meta: { ...result!.meta, changes: changes! } };
  };
  const batch = async (items: D1PreparedStatement[]): Promise<D1Result[]> => {
    if (!items.length) return [];
    const texts = items.map((statement) => {
      const text = statements.get(statement);
      if (text === undefined) throw new Error("Foreign D1 statement");
      return text();
    });
    const reads = texts.map((text) => {
      const code = text.replace(SQL_QUOTED_OR_COMMENT, " ").trim().replace(/;$/, "").trim();
      return /^SELECT\b/i.test(code) && !code.includes(";");
    });
    // TAPE static projectors probe count/rows together. Keep reads on the query
    // API even in an import-enabled job; never import a mixed read/write batch.
    if (reads.every(Boolean)) return texts.map((text) => decode(client.queryRaw(text), 1)[0]!);
    const sql = texts.map(writeSql);
    if (!options.atomicImports || sql.length === 1) return sql.map(({ rendered }) => runWrite(rendered));
    if (!client.executeStatementsRaw) throw new Error("backfill-d1-batch-transport-unavailable");
    const receipt = `_pharos_backfill_${crypto.randomUUID().replaceAll("-", "")}`;
    const writes = [`CREATE TABLE ${receipt} (ordinal INTEGER PRIMARY KEY, changed INTEGER NOT NULL);`];
    sql.forEach(({ rendered, dml }, ordinal) => {
      writes.push(rendered, `INSERT INTO ${receipt} (ordinal, changed) SELECT ${ordinal}, ${dml ? "changes()" : "0"};`);
    });
    try {
      const imported = decode(client.executeStatementsRaw(writes, "backfill-d1"), 1);
      const rows = decode(client.queryRaw(`SELECT ordinal, changed FROM ${receipt} ORDER BY ordinal;`), 1)[0]!.results;
      if (rows.length !== items.length) throw new Error("backfill-d1-receipt-count-mismatch");
      const results = rows.map((value, ordinal) => {
        const row = value as { ordinal: number; changed: number };
        if (row.ordinal !== ordinal || !Number.isSafeInteger(row.changed) || row.changed < 0) {
          throw new Error("backfill-d1-receipt-invalid");
        }
        return { success: true, results: [], meta: { ...imported[0]!.meta, changes: row.changed } } as D1Result;
      });
      decode(client.queryRaw(`DROP TABLE ${receipt};`), 1);
      return results;
    } catch (cause) {
      // Do not erase evidence after an uncertain import or failed readback.
      options.onUncertainAtomicOutcome?.(receipt);
      throw Object.assign(new Error(`backfill-d1-atomic-outcome-requires-reconciliation: ${receipt}`), { cause });
    }
  };
  const prepare = (sql: string, bindings: readonly unknown[] = []): D1PreparedStatement => {
    const read = async () => decode(client.queryRaw(bindBackfillSql(sql, bindings)), 1)[0]!;
    const statement = {
      bind: (...values: unknown[]) => prepare(sql, values),
      all: read,
      run: async () => runWrite(bindBackfillSql(sql, bindings)),
      first: async (column?: string) => {
        const row = (await read()).results[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        if (column !== undefined && !(column in row)) throw new Error(`Column not found: ${column}`);
        return column === undefined ? row : row[column];
      },
      raw: async () => (await read()).results.map((row) => Object.values(row)),
    } as D1PreparedStatement;
    statements.set(statement, () => bindBackfillSql(sql, bindings));
    return statement;
  };
  return {
    prepare,
    batch,
    exec: async (sql: string) => {
      const result = await batch([prepare(sql)]);
      return { count: 1, duration: result[0]!.meta.duration ?? 0 };
    },
  } as D1Database;
}
