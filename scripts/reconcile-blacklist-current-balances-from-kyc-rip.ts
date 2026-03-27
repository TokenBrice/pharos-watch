import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBlacklistCurrentBalanceId } from "../worker/src/lib/blacklist-current-balances";
import { tronBase58ToHex } from "../worker/src/lib/tron-address";

type ExternalRow = {
  address: string;
  asset: "USDT" | "USDC";
  chain: "ETH" | "TRON";
  frozen_balance: string;
};

type SnapshotRow = {
  id: string;
  stablecoin: "USDT" | "USDC";
  chainId: "ethereum" | "tron";
  address: string;
  amountUsd: number;
};

function executeWrangler(file: string): void {
  execFileSync("npx", ["wrangler", "d1", "execute", "stablecoin-db", "--remote", "--json", "--file", file], {
    cwd: join(process.cwd(), "worker"),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    stdio: "pipe",
  });
}

function sqlString(value: string | null): string {
  if (value == null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchAllExternalRows(): Promise<ExternalRow[]> {
  const rows: ExternalRow[] = [];
  const limit = 1000;
  let offset = 0;

  while (true) {
    const res = await fetch(`https://api.kyc.rip/v1/tools/ban-list?limit=${limit}&offset=${offset}`);
    if (!res.ok) throw new Error(`kyc.rip returned ${res.status}`);
    const json = await res.json() as { data?: ExternalRow[] };
    const batch = json.data ?? [];
    rows.push(...batch);
    if (batch.length < limit) return rows;
    offset += limit;
  }
}

async function normalizeRows(rows: ExternalRow[]): Promise<SnapshotRow[]> {
  const snapshots: SnapshotRow[] = [];
  for (const row of rows) {
    if (row.chain === "ETH" && row.asset === "USDT") {
      const address = row.address.toLowerCase();
      snapshots.push({
        id: buildBlacklistCurrentBalanceId("USDT", "ethereum", address),
        stablecoin: "USDT",
        chainId: "ethereum",
        address,
        amountUsd: Number(row.frozen_balance),
      });
      continue;
    }

    if (row.chain === "ETH" && row.asset === "USDC") {
      const address = row.address.toLowerCase();
      snapshots.push({
        id: buildBlacklistCurrentBalanceId("USDC", "ethereum", address),
        stablecoin: "USDC",
        chainId: "ethereum",
        address,
        amountUsd: Number(row.frozen_balance),
      });
      continue;
    }

    if (row.chain === "TRON" && row.asset === "USDT") {
      const address = await tronBase58ToHex(row.address);
      if (!address) continue;
      snapshots.push({
        id: buildBlacklistCurrentBalanceId("USDT", "tron", address),
        stablecoin: "USDT",
        chainId: "tron",
        address,
        amountUsd: Number(row.frozen_balance),
      });
    }
  }

  return snapshots;
}

async function main() {
  const externalRows = await fetchAllExternalRows();
  const snapshots = await normalizeRows(externalRows);
  const observedAt = Math.floor(Date.now() / 1000);

  const tmpDir = mkdtempSync(join(tmpdir(), "blacklist-kyc-rip-reconcile-"));
  try {
    const sqlFile = join(tmpDir, "reconcile.sql");
    const statements = [
      "DELETE FROM blacklist_current_balances WHERE (stablecoin = 'USDT' AND chain_id = 'ethereum') OR (stablecoin = 'USDC' AND chain_id = 'ethereum') OR (stablecoin = 'USDT' AND chain_id = 'tron');",
      ...snapshots.map((row) =>
        `INSERT INTO blacklist_current_balances (id, stablecoin, chain_id, address, amount_native, amount_usd, source, status, observed_at, attempt_count, last_attempted_at, last_error_class)
         VALUES (${sqlString(row.id)}, ${sqlString(row.stablecoin)}, ${sqlString(row.chainId)}, ${sqlString(row.address)}, ${row.amountUsd}, ${row.amountUsd}, 'kyc_rip_bootstrap', 'resolved', ${observedAt}, 1, ${observedAt}, NULL)
         ON CONFLICT(id) DO UPDATE SET
           amount_native = excluded.amount_native,
           amount_usd = excluded.amount_usd,
           source = excluded.source,
           status = excluded.status,
           observed_at = excluded.observed_at,
           attempt_count = excluded.attempt_count,
           last_attempted_at = excluded.last_attempted_at,
           last_error_class = excluded.last_error_class;`,
      ),
    ];
    writeFileSync(sqlFile, statements.join("\n"));
    executeWrangler(sqlFile);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    reconciled: snapshots.length,
    ethUsdt: snapshots.filter((row) => row.chainId === "ethereum" && row.stablecoin === "USDT").length,
    ethUsdc: snapshots.filter((row) => row.chainId === "ethereum" && row.stablecoin === "USDC").length,
    tronUsdt: snapshots.filter((row) => row.chainId === "tron" && row.stablecoin === "USDT").length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
