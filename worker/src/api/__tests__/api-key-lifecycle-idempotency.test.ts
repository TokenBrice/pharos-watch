import { readJsonResponse } from "./api-request-response.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { makeApiRequest, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import {
  handleApiKeyDeactivateRoute,
  handleApiKeyRotateRoute,
  handleApiKeysRoute,
  handleApiKeyUpdateRoute,
} from "../api-keys";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

stubCryptoForAuth();

function setup() {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

function mutationRequest(path: string, idempotencyKey: string, body?: Record<string, unknown>): Request {
  return makeApiRequest(path, {
    method: "POST",
    adminKey: "secret",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("API key lifecycle idempotency", () => {
  it("redacts create and rotate replay storage while replaying ordinary lifecycle mutations", async () => {
    const { sqlite, db } = setup();

    const firstCreate = await handleApiKeysRoute({
      db,
      trustedAdmin: true,
      apiKeyHashPepper: "pepper",
      request: mutationRequest("/api/api-keys", "create-intent", { name: "Ops Key" }),
    });
    const firstCreateBody = (await readJsonResponse(firstCreate, 201)) as { key: { id: number; name: string }; token: string };
    const createReplay = await handleApiKeysRoute({
      db,
      trustedAdmin: true,
      apiKeyHashPepper: "pepper",
      request: mutationRequest("/api/api-keys", "create-intent", { name: "Ops Key" }),
    });
    const createReplayBody = (await createReplay.json()) as Record<string, unknown>;
    const storedCreate = sqlite
      .prepare("SELECT response_body FROM admin_idempotency_keys WHERE action = 'api-key-create'")
      .get() as { response_body: string };

    expect(firstCreate.headers.get("X-Idempotent-Replay")).toBe("false");
    expect(firstCreateBody.token).toMatch(/^ph_live_/);
    expect(createReplay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(createReplayBody).toMatchObject({
      key: { id: firstCreateBody.key.id, name: "Ops Key" },
      tokenUnavailableOnReplay: true,
      recovery: expect.stringMatching(/Rotate the identified API key/i),
    });
    expect(createReplayBody).not.toHaveProperty("token");
    expect(storedCreate.response_body).not.toContain(firstCreateBody.token);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({ count: 1 });

    const keyId = firstCreateBody.key.id;
    const updatePath = `/api/api-keys/${keyId}/update`;
    const firstUpdate = await handleApiKeyUpdateRoute({
      db,
      apiKeyId: keyId,
      trustedAdmin: true,
      request: mutationRequest(updatePath, "update-intent", { name: "Updated Ops Key" }),
    });
    const replayUpdate = await handleApiKeyUpdateRoute({
      db,
      apiKeyId: keyId,
      trustedAdmin: true,
      request: mutationRequest(updatePath, "update-intent", { name: "Updated Ops Key" }),
    });
    expect(firstUpdate.status).toBe(200);
    expect(replayUpdate.headers.get("X-Idempotent-Replay")).toBe("true");

    const deactivatePath = `/api/api-keys/${keyId}/deactivate`;
    const firstDeactivate = await handleApiKeyDeactivateRoute({
      db,
      apiKeyId: keyId,
      trustedAdmin: true,
      request: mutationRequest(deactivatePath, "deactivate-intent"),
    });
    const replayDeactivate = await handleApiKeyDeactivateRoute({
      db,
      apiKeyId: keyId,
      trustedAdmin: true,
      request: mutationRequest(deactivatePath, "deactivate-intent"),
    });
    expect(firstDeactivate.status).toBe(200);
    expect(replayDeactivate.headers.get("X-Idempotent-Replay")).toBe("true");

    const rotatePath = `/api/api-keys/${keyId}/rotate`;
    const firstRotate = await handleApiKeyRotateRoute({
      db,
      apiKeyId: keyId,
      trustedAdmin: true,
      apiKeyHashPepper: "pepper",
      request: mutationRequest(rotatePath, "rotate-intent"),
    });
    const firstRotateBody = (await firstRotate.json()) as { key: { id: number }; token: string };
    const replayRotate = await handleApiKeyRotateRoute({
      db,
      apiKeyId: keyId,
      trustedAdmin: true,
      apiKeyHashPepper: "pepper",
      request: mutationRequest(rotatePath, "rotate-intent"),
    });
    const replayRotateBody = (await replayRotate.json()) as Record<string, unknown>;
    const storedRotate = sqlite
      .prepare("SELECT response_body FROM admin_idempotency_keys WHERE action = 'api-key-rotate'")
      .get() as { response_body: string };

    expect(firstRotateBody.token).toMatch(/^ph_live_/);
    expect(firstRotate.headers.get("X-Idempotent-Replay")).toBe("false");
    expect(replayRotate.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(replayRotateBody).toMatchObject({
      key: { id: keyId },
      tokenUnavailableOnReplay: true,
      recovery: expect.stringMatching(/Rotate the identified API key/i),
    });
    expect(replayRotateBody).not.toHaveProperty("token");
    expect(storedRotate.response_body).not.toContain(firstRotateBody.token);
    expect(
      sqlite.prepare("SELECT action, COUNT(*) AS count FROM api_key_audit_log GROUP BY action ORDER BY action").all(),
    ).toEqual([
      { action: "created", count: 1 },
      { action: "deactivated", count: 1 },
      { action: "rotated", count: 1 },
      { action: "updated", count: 1 },
    ]);
  });
});
