export const optionalTables = [
  "worker_job_attempts", "worker_repair_tasks", "worker_canary_runs", "surface_publication_generations",
];

export function snapshotSelector({
  omitted, discoveryError, failures = {},
}: { omitted?: string; discoveryError?: string; failures?: Record<string, string> } = {}) {
  const queried: string[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    cron_runs: [{ job: "sync-stablecoins", status: "ok" }],
    cron_slot_executions: [], cron_leases: [], cron_run_progress: [],
    worker_job_attempts: [], worker_repair_tasks: [], worker_canary_runs: [],
    surface_publication_generations: [],
    dex_liquidity_publication_generations: [{ generation_id: "dex-retained", state: "published" }],
    yield_publication_generations: [{ generation_id: "yield-retained", state: "published" }],
  };
  const select = (_args: unknown, sql: string) => {
    const table = /\bFROM\s+(\w+)/i.exec(sql)?.[1];
    if (!table || (table !== "sqlite_master" && !(table in rows))) throw new Error(`Unexpected query: ${sql}`);
    queried.push(table);
    if (table === "sqlite_master") {
      if (discoveryError) throw new Error(discoveryError);
      return optionalTables.filter((name) => name !== omitted).map((name) => ({ name }));
    }
    if (table === omitted) throw new Error(`Unexpected omitted-table query: ${sql}`);
    if (failures[table]) throw new Error(failures[table]);
    return rows[table];
  };
  return { select, queried };
}
