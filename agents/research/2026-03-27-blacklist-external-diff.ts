import { execFileSync } from "node:child_process";
import { tronBase58ToHex } from "../../worker/src/lib/tron-address";

type LocalRow = {
  address: string;
  timestamp: number;
  amount_usd: number | null;
};

type ExternalRow = {
  address: string;
  frozen_balance: string;
};

function fetchLocalRows(): LocalRow[] {
  const sql = `
    WITH ranked AS (
      SELECT address, timestamp, event_type, id,
             ROW_NUMBER() OVER (PARTITION BY address ORDER BY timestamp DESC, id DESC) AS rn
      FROM blacklist_events
      WHERE stablecoin = 'USDT'
        AND chain_id = 'tron'
    ),
    active AS (
      SELECT address, timestamp
      FROM ranked
      WHERE rn = 1
        AND event_type = 'blacklist'
    )
    SELECT active.address, active.timestamp, cb.amount_usd
    FROM active
    LEFT JOIN blacklist_current_balances cb
      ON cb.stablecoin = 'USDT'
     AND cb.chain_id = 'tron'
     AND cb.address = active.address
  `;
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "stablecoin-db", "--remote", "--json", "--command", sql],
    {
      cwd: "./worker",
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    },
  );
  return (JSON.parse(raw)[0]?.results ?? []) as LocalRow[];
}

async function fetchExternalRows(): Promise<ExternalRow[]> {
  const rows: ExternalRow[] = [];
  const limit = 1000;
  let offset = 0;

  while (true) {
    const res = await fetch(`https://api.kyc.rip/v1/tools/ban-list?limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      throw new Error(`External API returned ${res.status}`);
    }
    const json = await res.json() as { data?: ExternalRow[] };
    const batch = json.data ?? [];
    rows.push(...batch.filter((row) => row.address.startsWith("T")));
    if (batch.length < limit) return rows;
    offset += limit;
  }
}

function monthKey(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 7);
}

async function main() {
  const localRows = fetchLocalRows();
  const externalRows = await fetchExternalRows();

  const externalByHex = new Map<string, number>();
  for (const row of externalRows) {
    const hex = await tronBase58ToHex(row.address);
    if (!hex) continue;
    externalByHex.set(hex.toLowerCase(), Number(row.frozen_balance));
  }

  const monthBuckets = new Map<string, {
    count: number;
    local: number;
    external: number;
    externalZero: number;
    externalPositive: number;
  }>();
  const deltas: Array<{
    address: string;
    month: string;
    local: number;
    external: number;
    delta: number;
  }> = [];

  for (const row of localRows) {
    const address = row.address.toLowerCase();
    const local = row.amount_usd ?? 0;
    const external = externalByHex.get(address) ?? 0;
    const month = monthKey(row.timestamp);
    const bucket = monthBuckets.get(month) ?? {
      count: 0,
      local: 0,
      external: 0,
      externalZero: 0,
      externalPositive: 0,
    };
    bucket.count++;
    bucket.local += local;
    bucket.external += external;
    if (external > 0) bucket.externalPositive++;
    else bucket.externalZero++;
    monthBuckets.set(month, bucket);
    deltas.push({ address, month, local, external, delta: local - external });
  }

  const monthSummary = [...monthBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, bucket]) => ({
      month,
      ...bucket,
      delta: bucket.local - bucket.external,
    }));
  const topPositiveDelta = [...deltas]
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 20);

  console.log(JSON.stringify({
    localCount: localRows.length,
    externalCount: externalRows.length,
    localTotal: localRows.reduce((sum, row) => sum + (row.amount_usd ?? 0), 0),
    externalMatchedTotal: localRows.reduce((sum, row) => sum + (externalByHex.get(row.address.toLowerCase()) ?? 0), 0),
    monthSummary,
    topPositiveDelta,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
