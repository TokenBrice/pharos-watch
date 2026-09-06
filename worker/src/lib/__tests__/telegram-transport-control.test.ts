import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  claimTelegramTransportPermit,
  pruneTelegramTransportObservations,
  readTelegramDeliveryPause,
  readTelegramFreshHandoffAllowance,
  readTelegramTransportCircuit,
  recordTelegramTransportOutcomes,
  resumeTelegramDelivery,
  setTelegramDeliveryPause,
} from "../telegram/transport-control";
import type { SendToChatResult } from "../telegram";

const NOW = 1_800_000_000;
const databases: DatabaseSync[] = [];

function setupLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
  for (const file of readdirSync(migrationDir).filter((entry) => entry.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(migrationDir, file), "utf8"));
  }
  databases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function result(
  errorClass: SendToChatResult["errorClass"],
  overrides: Partial<SendToChatResult> = {},
): SendToChatResult {
  const ok = errorClass == null;
  return {
    ok,
    blocked: false,
    retryable: !ok,
    permanentFailure: false,
    statusCode: ok ? 200 : null,
    errorClass,
    delivery: ok ? "sent" : "retryable_failure",
    retryAfterSec: null,
    ...overrides,
  };
}

async function closedPermit(db: D1Database, owner = "owner-a", requestedDistinctChats = 6) {
  return await claimTelegramTransportPermit(db, {
    mode: "fresh",
    owner,
    nowSec: NOW,
    requestedDistinctChats,
  });
}

describe("Telegram transport outage control", () => {
  it("replays the latest schema and leaves normal closed-state concurrency unchanged", async () => {
    const { db } = setupLatestSchema();
    const permit = await closedPermit(db);
    expect(permit).toMatchObject({ allowed: true, reason: "closed", maxDistinctChats: 6 });
    expect(await readTelegramTransportCircuit(db)).toMatchObject({ state: "closed", generation: 0 });
  });

  it("holds fresh handoff while open and seeds at most four targets when a probe is due", async () => {
    const { sqlite, db } = setupLatestSchema();
    sqlite.prepare(
      `UPDATE telegram_transport_circuit
          SET state = 'open', generation = 1, next_probe_at = ?, updated_at = ?
        WHERE singleton_id = 1`,
    ).run(NOW + 60, NOW);
    await expect(readTelegramFreshHandoffAllowance(db, NOW, 90)).resolves.toMatchObject({
      allowed: false,
      maxTargets: 0,
      reason: "outage_open",
    });
    sqlite.prepare("UPDATE telegram_transport_circuit SET next_probe_at = ? WHERE singleton_id = 1").run(NOW);
    await expect(readTelegramFreshHandoffAllowance(db, NOW, 90)).resolves.toMatchObject({
      allowed: true,
      maxTargets: 4,
      reason: "probe_seed",
    });
  });

  it("lets fresh handoff seed a replacement probe after a half-open lease expires", async () => {
    const { sqlite, db } = setupLatestSchema();
    sqlite.prepare(
      `UPDATE telegram_transport_circuit
          SET state = 'half_open',
              generation = 3,
              next_probe_at = ?,
              probe_owner = 'stale-owner',
              probe_generation = 3,
              probe_expires_at = ?,
              probe_limit = 4,
              probe_attempted = 0,
              updated_at = ?
        WHERE singleton_id = 1`,
    ).run(NOW - 60, NOW - 1, NOW - 30);

    await expect(readTelegramFreshHandoffAllowance(db, NOW, 90)).resolves.toMatchObject({
      allowed: true,
      maxTargets: 4,
      reason: "probe_seed",
      deferUntil: null,
    });
  });

  it("opens immediately on auth failure and denies the untouched tail", async () => {
    const { db } = setupLatestSchema();
    const permit = await closedPermit(db);
    const circuit = await recordTelegramTransportOutcomes(db, permit, [
      { chatId: "chat-a", result: result("auth_error", { statusCode: 401, permanentFailure: true }) },
    ], NOW);
    expect(circuit).toMatchObject({ state: "open", causeClass: "auth_error", causeScope: "fatal" });

    await expect(claimTelegramTransportPermit(db, {
      mode: "pending",
      owner: "owner-b",
      nowSec: NOW + 1,
      requestedDistinctChats: 4,
    })).resolves.toMatchObject({ allowed: false, reason: "outage_open", maxDistinctChats: 0 });
  });

  it.each(["server_error", "network", "timeout"] as const)(
    "requires distinct chats before %s opens the circuit",
    async (errorClass) => {
      const { db } = setupLatestSchema();
      const permit = await closedPermit(db);
      await recordTelegramTransportOutcomes(db, permit, [
        { chatId: "same-chat", result: result(errorClass) },
        { chatId: "same-chat", result: result(errorClass) },
      ], NOW);
      expect((await readTelegramTransportCircuit(db)).state).toBe("closed");

      await recordTelegramTransportOutcomes(db, permit, [
        { chatId: "chat-b", result: result(errorClass) },
        { chatId: "chat-c", result: result(errorClass) },
      ], NOW + 1);
      expect(await readTelegramTransportCircuit(db)).toMatchObject({
        state: "open",
        causeScope: "transient",
        distinctFailureCount: 3,
      });
    },
  );

  it("converges separately admitted passes on one generation-fenced open", async () => {
    const { db } = setupLatestSchema();
    const firstPermit = await closedPermit(db, "owner-a", 2);
    const secondPermit = await closedPermit(db, "owner-b", 2);
    await recordTelegramTransportOutcomes(db, firstPermit, [
      { chatId: "chat-a", result: result("server_error") },
      { chatId: "chat-b", result: result("server_error") },
    ], NOW);
    await recordTelegramTransportOutcomes(db, secondPermit, [
      { chatId: "chat-c", result: result("network") },
      { chatId: "chat-d", result: result("network") },
    ], NOW);
    const circuit = await readTelegramTransportCircuit(db);
    expect(circuit).toMatchObject({ state: "open", generation: 1, causeScope: "transient" });
    expect(circuit.distinctFailureCount).toBe(4);
  });

  it("ignores a stale closed-state result after a newer circuit generation wins", async () => {
    const { db } = setupLatestSchema();
    const stalePermit = await closedPermit(db, "stale-owner", 1);
    const winnerPermit = await closedPermit(db, "winner", 1);
    await recordTelegramTransportOutcomes(db, winnerPermit, [
      { chatId: "chat-a", result: result("auth_error", { statusCode: 401 }) },
    ], NOW);
    const opened = await readTelegramTransportCircuit(db);

    await recordTelegramTransportOutcomes(db, stalePermit, [
      { chatId: "chat-b", result: result("auth_error", { statusCode: 401 }) },
    ], NOW + 1);
    expect(await readTelegramTransportCircuit(db)).toEqual(opened);
  });

  it("keeps one chat-local 429 isolated but infers an outage across distinct chats", async () => {
    const { db } = setupLatestSchema();
    const permit = await closedPermit(db);
    await recordTelegramTransportOutcomes(db, permit, [
      { chatId: "chat-a", result: result("rate_limit", { statusCode: 429, rateLimitScope: "chat" }) },
    ], NOW);
    expect((await readTelegramTransportCircuit(db)).state).toBe("closed");

    const circuit = await recordTelegramTransportOutcomes(db, permit, [
      { chatId: "chat-b", result: result("rate_limit", { statusCode: 429, rateLimitScope: "chat" }) },
      { chatId: "chat-c", result: result("rate_limit", { statusCode: 429, rateLimitScope: "chat" }) },
    ], NOW + 1);
    expect(circuit).toMatchObject({ state: "open", causeScope: "rate_limit", distinctFailureCount: 3 });
  });

  it("allows one bounded half-open owner and counts only actual distinct attempts", async () => {
    const { sqlite, db } = setupLatestSchema();
    const permit = await closedPermit(db);
    await recordTelegramTransportOutcomes(db, permit, [
      { chatId: "chat-a", result: result("auth_error", { statusCode: 401 }) },
    ], NOW);
    sqlite.prepare("UPDATE telegram_transport_circuit SET next_probe_at = ? WHERE singleton_id = 1").run(NOW + 10);

    const [first, second] = await Promise.all([
      claimTelegramTransportPermit(db, {
        mode: "fresh", owner: "probe-a", nowSec: NOW + 10, requestedDistinctChats: 4,
      }),
      claimTelegramTransportPermit(db, {
        mode: "pending", owner: "probe-b", nowSec: NOW + 10, requestedDistinctChats: 4,
      }),
    ]);
    const winner = [first, second].find((candidate) => candidate.allowed);
    const loser = [first, second].find((candidate) => !candidate.allowed);
    expect(winner).toMatchObject({ reason: "half_open_probe", maxDistinctChats: 4 });
    expect(loser).toMatchObject({ reason: "probe_owned_elsewhere", maxDistinctChats: 0 });

    const closed = await recordTelegramTransportOutcomes(db, winner!, [
      { chatId: "chat-1", result: result(null) },
      { chatId: "chat-2", result: result("blocked", { statusCode: 403, retryable: false, permanentFailure: true }) },
    ], NOW + 11);
    expect(closed).toMatchObject({ state: "closed", probeAttempted: 0, lastSuccessAt: NOW + 11 });
  });

  it("releases a half-open probe permit when no send is attempted", async () => {
    const { sqlite, db } = setupLatestSchema();
    const permit = await closedPermit(db);
    await recordTelegramTransportOutcomes(db, permit, [
      { chatId: "chat-a", result: result("auth_error", { statusCode: 401 }) },
    ], NOW);
    sqlite.prepare("UPDATE telegram_transport_circuit SET next_probe_at = ? WHERE singleton_id = 1").run(NOW + 10);

    const probe = await claimTelegramTransportPermit(db, {
      mode: "pending",
      owner: "probe-without-send",
      nowSec: NOW + 10,
      requestedDistinctChats: 4,
    });
    expect(probe).toMatchObject({ allowed: true, reason: "half_open_probe" });

    const released = await recordTelegramTransportOutcomes(db, probe, [], NOW + 11);
    expect(released).toMatchObject({
      state: "open",
      nextProbeAt: NOW + 11,
      probeOwner: null,
      probeGeneration: null,
      probeAttempted: 0,
    });
    await expect(readTelegramFreshHandoffAllowance(db, NOW + 11, 90)).resolves.toMatchObject({
      allowed: true,
      maxTargets: 4,
      reason: "probe_seed",
    });
  });

  it("treats a lone local 429 half-open result as inconclusive", async () => {
    const { sqlite, db } = setupLatestSchema();
    const permit = await closedPermit(db);
    await recordTelegramTransportOutcomes(db, permit, [
      { chatId: "chat-a", result: result("auth_error", { statusCode: 401 }) },
    ], NOW);
    sqlite.prepare("UPDATE telegram_transport_circuit SET next_probe_at = ? WHERE singleton_id = 1").run(NOW + 10);
    const probe = await claimTelegramTransportPermit(db, {
      mode: "fresh", owner: "probe-a", nowSec: NOW + 10, requestedDistinctChats: 1,
    });
    const circuit = await recordTelegramTransportOutcomes(db, probe, [
      { chatId: "hot-chat", result: result("rate_limit", { statusCode: 429, rateLimitScope: "chat", retryAfterSec: 12 }) },
    ], NOW + 11);
    expect(circuit).toMatchObject({ state: "open", causeClass: "auth_error", causeScope: "fatal" });
    expect(circuit.nextProbeAt).toBe(NOW + 23);
  });

  it("fences independent pause generations and expires them automatically", async () => {
    const { db } = setupLatestSchema();
    const paused = await setTelegramDeliveryPause(db, {
      mode: "admin",
      expectedGeneration: 0,
      expiresAt: NOW + 120,
      reason: "incident review",
      actor: "operator@example.com",
      nowSec: NOW,
    });
    expect(paused).toMatchObject({ generation: 1, active: true, expiresAt: NOW + 120 });
    expect(await claimTelegramTransportPermit(db, {
      mode: "admin", owner: "admin-send", nowSec: NOW + 1, requestedDistinctChats: 1,
    })).toMatchObject({ allowed: false, reason: "operator_pause", pauseGeneration: 1 });
    expect(await claimTelegramTransportPermit(db, {
      mode: "pending", owner: "pending-send", nowSec: NOW + 1, requestedDistinctChats: 4,
    })).toMatchObject({ allowed: true, reason: "closed", maxDistinctChats: 4 });
    expect((await readTelegramDeliveryPause(db, "admin", NOW + 121))?.active).toBe(false);

    await expect(resumeTelegramDelivery(db, {
      mode: "admin", expectedGeneration: 0, actor: "operator@example.com", nowSec: NOW + 10,
    })).resolves.toBeNull();
    const resumed = await resumeTelegramDelivery(db, {
      mode: "admin", expectedGeneration: 1, actor: "operator@example.com", nowSec: NOW + 10,
    });
    expect(resumed).toMatchObject({ generation: 2, active: false, expiresAt: NOW + 10 });
  });

  it("prunes observations beyond the documented bounded retention", async () => {
    const { sqlite, db } = setupLatestSchema();
    sqlite.prepare(
      `INSERT INTO telegram_transport_failure_observations
         (failure_scope, chat_id, error_class, observed_at)
       VALUES ('transient', 'old-chat', 'network', ?), ('transient', 'new-chat', 'network', ?)`,
    ).run(NOW - 301, NOW - 299);
    expect(await pruneTelegramTransportObservations(db, NOW)).toBe(1);
    expect(sqlite.prepare("SELECT chat_id FROM telegram_transport_failure_observations").all()).toEqual([
      { chat_id: "new-chat" },
    ]);
  });
});
