import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSuiCheckpointReader } from "../sui";
import { fetchJsonPostWithRetry } from "../helpers";
vi.mock("../helpers", () => ({ fetchJsonPostWithRetry: vi.fn() }));
const fetchMock = vi.mocked(fetchJsonPostWithRetry);
const address = `0x${"1".repeat(64)}`;
const head = { data: { checkpoint: { sequenceNumber: 320550547, timestamp: "2026-09-09T00:00:00.000Z" } } };
const nowSec = Date.parse("2026-09-09T00:00:30Z") / 1000;
const page = (hasNextPage: boolean, endCursor: string | null) => ({ data: { object: { dynamicFields: { nodes: [], pageInfo: { hasNextPage, endCursor } } } } });
beforeEach(() => fetchMock.mockReset());
describe("Sui checkpoint reader", () => {
  it("pins objects and every page to the observed checkpoint", async () => {
    fetchMock.mockResolvedValueOnce(head).mockResolvedValueOnce({ data: { object: { address, version: 7, asMoveObject: { contents: { json: { balance: "100" }, type: { repr: "vault" } } } } } }).mockResolvedValueOnce(page(true, "next")).mockResolvedValueOnce(page(false, null));
    const ctx = { nowSec };
    const reader = await createSuiCheckpointReader("https://graphql.mainnet.sui.io/graphql", new AbortController().signal, ctx);
    expect((await reader.object(address)).asMoveObject.contents.json).toEqual({ balance: "100" });
    expect(await reader.dynamicFields(address)).toEqual([]);
    expect(reader.checkpoint).toBe(320550547);
    expect(reader.timestamp).toBe(nowSec - 30);
    for (const call of fetchMock.mock.calls.slice(1)) expect(call[1]).toMatchObject({ variables: { checkpoint: 320550547, address } });
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ variables: { after: "next" } });
  });
  it("rejects partial GraphQL data accompanied by errors", async () => {
    fetchMock.mockResolvedValueOnce({ ...head, errors: [{ message: "checkpoint unavailable" }] });
    await expect(createSuiCheckpointReader("https://sui.test", new AbortController().signal, { nowSec })).rejects.toThrow("GraphQL error");
  });
  it("rejects a stale latest checkpoint", async () => {
    fetchMock.mockResolvedValueOnce(head);
    await expect(createSuiCheckpointReader("https://sui.test", new AbortController().signal, { nowSec: nowSec + 300 })).rejects.toThrow("stale");
  });
  it("fails closed instead of returning a truncated census at the page cap", async () => {
    fetchMock.mockResolvedValueOnce(head);
    for (let i = 0; i < 8; i++) fetchMock.mockResolvedValueOnce(page(true, `cursor${i}`));
    const reader = await createSuiCheckpointReader("https://sui.test", new AbortController().signal, { nowSec });
    await expect(reader.dynamicFields(address)).rejects.toThrow("page cap");
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });
  it("rejects nonadvancing pagination", async () => {
    fetchMock.mockResolvedValueOnce(head).mockResolvedValueOnce(page(true, "same")).mockResolvedValueOnce(page(true, "same"));
    const reader = await createSuiCheckpointReader("https://sui.test", new AbortController().signal, { nowSec });
    await expect(reader.dynamicFields(address)).rejects.toThrow("cursor did not advance");
  });
  it("bounds total dependent reads, including successful single-page censuses", async () => {
    fetchMock.mockResolvedValueOnce(head).mockResolvedValue(page(false, null));
    const reader = await createSuiCheckpointReader("https://sui.test", new AbortController().signal, { nowSec });
    for (let i = 0; i < 23; i++) await reader.dynamicFields(address);
    await expect(reader.dynamicFields(address)).rejects.toThrow("read budget exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(24);
  });
  it("rejects repeated fields instead of double-counting collateral", async () => {
    const field = { address, name: { json: "SUI", type: { repr: "name" } }, value: { __typename: "MoveValue", json: "100", type: { repr: "u64" } } };
    const first = page(true, "next");
    const second = page(false, null);
    fetchMock.mockResolvedValueOnce(head)
      .mockResolvedValueOnce({ data: { object: { dynamicFields: { ...first.data.object.dynamicFields, nodes: [field] } } } })
      .mockResolvedValueOnce({ data: { object: { dynamicFields: { ...second.data.object.dynamicFields, nodes: [field] } } } });
    const reader = await createSuiCheckpointReader("https://sui.test", new AbortController().signal, { nowSec });
    await expect(reader.dynamicFields(address)).rejects.toThrow("duplicate dynamic field");
  });
});
