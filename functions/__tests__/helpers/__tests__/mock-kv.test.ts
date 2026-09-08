import { describe, expect, it } from "vitest";
import { makeKV } from "../mock-kv";

describe("makeKV shared key space", () => {
  it("replaces binary bytes with text and its metadata", async () => {
    const kv = makeKV();
    kv.__putBinary("key", new Uint8Array([0, 255]));
    await kv.put("key", "replacement", { metadata: { version: 2 } });
    expect(await kv.get("key")).toBe("replacement");
    expect(new Uint8Array((await kv.get("key", "arrayBuffer"))!)).toEqual(new TextEncoder().encode("replacement"));
    expect(await kv.getWithMetadata("key")).toMatchObject({ value: "replacement", metadata: { version: 2 } });
  });

  it("replaces text and old metadata with binary, then deletes every read form", async () => {
    const kv = makeKV();
    await kv.put("key", "old", { metadata: { version: 1 } });
    kv.__putBinary("key", new TextEncoder().encode("binary"));
    expect(await kv.get("key")).toBe("binary");
    expect(await kv.getWithMetadata("key")).toMatchObject({ value: "binary", metadata: null });
    expect(new Uint8Array((await kv.get("key", { type: "arrayBuffer" }))!)).toEqual(new TextEncoder().encode("binary"));
    await kv.delete("key");
    expect(await kv.get("key")).toBeNull();
    expect(await kv.get("key", "arrayBuffer")).toBeNull();
    expect(await kv.getWithMetadata("key")).toMatchObject({ value: null, metadata: null });
  });

  it("preserves live text inspection/seeding without retaining overwritten binary values", async () => {
    const kv = makeKV();
    const store = kv.__getStore();
    kv.__putBinary("key", new TextEncoder().encode("binary"));
    expect(store.get("key")).toBe("binary");
    store.set("key", "seeded");
    expect(new TextDecoder().decode((await kv.get("key", "arrayBuffer"))!)).toBe("seeded");
    await kv.delete("key");
    expect(store.has("key")).toBe(false);
    expect(store.size).toBe(0);
  });
});
