import { describe, expect, it } from "vitest";
import { installAdapterNetwork } from "./reserve-adapter.test-support";
import { createSuiCheckpointReader } from "../sui";

const ENDPOINT = "https://graphql.mainnet.sui.io/graphql";
const address = `0x${"1".repeat(64)}`;
const head = { data: { checkpoint: { sequenceNumber: 320550547, timestamp: "2026-09-09T00:00:00.000Z" } } };
const nowSec = Date.parse("2026-09-09T00:00:30Z") / 1000;
const page = (hasNextPage: boolean, endCursor: string | null) => ({
  data: { object: { dynamicFields: { nodes: [], pageInfo: { hasNextPage, endCursor } } } },
});

type QueryBody = { query: string; variables: Record<string, unknown> };

function installSuiNetwork(responses: unknown[]) {
  const bodies: QueryBody[] = [];
  const network = installAdapterNetwork({
    json: {
      [ENDPOINT]: async (request: Request) => {
        bodies.push(await request.clone().json() as QueryBody);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response ?? page(false, null);
      },
    },
  });
  return { network, bodies };
}

describe("Sui checkpoint reader", () => {
  it("pins objects and every page to the observed checkpoint", async () => {
    const { bodies } = installSuiNetwork([
      head,
      { data: { object: { address, version: 7, asMoveObject: { contents: { json: { balance: "100" }, type: { repr: "vault" } } } } } },
      page(true, "next"),
      page(false, null),
    ]);
    const ctx = { nowSec };
    const reader = await createSuiCheckpointReader(ENDPOINT, new AbortController().signal, ctx);

    expect((await reader.object(address)).asMoveObject.contents.json).toEqual({ balance: "100" });
    expect(await reader.dynamicFields(address)).toEqual([]);
    expect(reader.checkpoint).toBe(320550547);
    expect(reader.timestamp).toBe(nowSec - 30);
    for (const call of bodies.slice(1)) {
      expect(call.variables).toMatchObject({ checkpoint: 320550547, address });
    }
    expect(bodies[3]!.variables).toMatchObject({ after: "next" });
  });

  it("rejects partial GraphQL data accompanied by errors", async () => {
    installSuiNetwork([{ ...head, errors: [{ message: "checkpoint unavailable" }] }]);

    await expect(createSuiCheckpointReader(ENDPOINT, new AbortController().signal, { nowSec }))
      .rejects.toThrow("GraphQL error");
  });

  it("rejects a stale latest checkpoint", async () => {
    installSuiNetwork([head]);

    await expect(createSuiCheckpointReader(ENDPOINT, new AbortController().signal, { nowSec: nowSec + 300 }))
      .rejects.toThrow("stale");
  });

  it("fails closed instead of returning a truncated census at the page cap", async () => {
    installSuiNetwork([head, ...Array.from({ length: 8 }, (_, index) => page(true, `cursor${index}`))]);
    const reader = await createSuiCheckpointReader(ENDPOINT, new AbortController().signal, { nowSec });

    await expect(reader.dynamicFields(address)).rejects.toThrow("page cap");
  });

  it("rejects nonadvancing pagination", async () => {
    installSuiNetwork([head, page(true, "same"), page(true, "same")]);
    const reader = await createSuiCheckpointReader(ENDPOINT, new AbortController().signal, { nowSec });

    await expect(reader.dynamicFields(address)).rejects.toThrow("cursor did not advance");
  });

  it("bounds total dependent reads, including successful single-page censuses", async () => {
    const { bodies } = installSuiNetwork([head]);
    const reader = await createSuiCheckpointReader(ENDPOINT, new AbortController().signal, { nowSec });

    for (let i = 0; i < 23; i++) await reader.dynamicFields(address);
    await expect(reader.dynamicFields(address)).rejects.toThrow("read budget exceeded");
    expect(bodies).toHaveLength(24);
  });

  it("rejects repeated fields instead of double-counting collateral", async () => {
    const field = {
      address,
      name: { json: "SUI", type: { repr: "name" } },
      value: { __typename: "MoveValue", json: "100", type: { repr: "u64" } },
    };
    const first = page(true, "next");
    const second = page(false, null);
    installSuiNetwork([
      head,
      { data: { object: { dynamicFields: { ...first.data.object.dynamicFields, nodes: [field] } } } },
      { data: { object: { dynamicFields: { ...second.data.object.dynamicFields, nodes: [field] } } } },
    ]);
    const reader = await createSuiCheckpointReader(ENDPOINT, new AbortController().signal, { nowSec });

    await expect(reader.dynamicFields(address)).rejects.toThrow("duplicate dynamic field");
  });
});
