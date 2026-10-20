import { describe, expect, it } from "vitest";
import { stronglyConnectedComponents } from "../strongly-connected-components";

function components(ids: readonly string[], links: readonly (readonly [string, string])[]) {
  const out = new Map<string, string[]>();
  for (const [from, to] of links) {
    const targets = out.get(from);
    if (targets) targets.push(to); else out.set(from, [to]);
  }
  return [...stronglyConnectedComponents(ids, id => out.get(id) ?? [])];
}

describe("stronglyConnectedComponents", () => {
  it("retains singleton self-loops and emits multiple SCCs in DFS completion order", () => {
    expect(components(["a", "self", "free", "x"], [
      ["a", "b"], ["b", "a"], ["b", "child"], ["self", "self"], ["x", "y"], ["y", "x"],
    ])).toEqual([["child"], ["b", "a"], ["self"], ["free"], ["y", "x"]]);
  });

  it("follows targets beyond the starts but never visits disconnected sources", () => {
    expect(components(["a", "a"], [["a", "b"], ["b", "a"], ["hidden", "hidden"]]))
      .toEqual([["b", "a"]]);
    expect(components([], [["hidden", "hidden"]])).toEqual([]);
  });

  it("lets a first-cycle consumer stop before traversing later disconnected starts", () => {
    const visited: string[] = [];
    for (const members of stronglyConnectedComponents(["a", "b", "later"], id => {
      visited.push(id);
      return id === "a" ? ["b"] : id === "b" ? ["a"] : [];
    })) {
      expect(members).toEqual(["b", "a"]);
      break;
    }
    expect(visited).toEqual(["a", "b"]);
  });

  it("is stack-safe on a long chain ending in a cycle", () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => String(i));
    const out = new Map(ids.slice(0, -1).map((id, i) => [id, [ids[i + 1]]]));
    out.set(ids[ids.length - 1], [ids[ids.length - 2]]);
    const result = [...stronglyConnectedComponents(ids, id => out.get(id) ?? [])];
    expect(result.length).toBe(ids.length - 1);
    expect(result[0]).toEqual([ids[ids.length - 1], ids[ids.length - 2]]);
    expect(result[result.length - 1]).toEqual(["0"]);
  });

  it("matches independent mutual-reachability partitions across every three-node graph and reversed edges", () => {
    const ids = ["a", "b", "c"];
    const pairs = ids.flatMap(from => ids.map(to => [from, to] as const));
    for (let mask = 0; mask < 1 << pairs.length; mask++) {
      const links = pairs.filter((_, bit) => (mask & (1 << bit)) !== 0);
      const reach = ids.map((from, i) => ids.map((to, j) => i === j || links.some(link => link[0] === from && link[1] === to)));
      for (let k = 0; k < ids.length; k++) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = 0; j < ids.length; j++) reach[i][j] ||= reach[i][k] && reach[k][j];
        }
      }
      const remaining = new Set(ids), expected: string[][] = [];
      for (let i = 0; i < ids.length; i++) {
        if (!remaining.has(ids[i])) continue;
        const members = ids.filter((_, j) => reach[i][j] && reach[j][i]);
        for (const member of members) remaining.delete(member);
        expected.push(members);
      }
      for (const [starts, orderedLinks] of [[ids, links], [[...ids].reverse(), [...links].reverse()]] as const) {
        const actual = components(starts, orderedLinks).map(members => members.sort())
          .sort((a, b) => a[0].localeCompare(b[0]));
        expect(actual, `graph ${mask}`).toEqual(expected);
      }
    }
  });
});
