# Dependency Map Visual Fidelity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Encode dependency weight, direction, and type visually in the contagion graph with progressive disclosure.

**Architecture:** All changes are in `src/components/contagion-graph.tsx`. Enrich `GraphLink` with `type` field, add SVG `<marker>` arrowheads, scale edge width/opacity by weight, add edge hover tooltips, and implement node-hover spotlight with type encoding.

**Tech Stack:** React 19, SVG, d3-force (existing), TypeScript

---

### Task 1: Enrich GraphLink with dependency type

**Files:**
- Modify: `src/components/contagion-graph.tsx:32-34` (GraphLink interface)
- Modify: `src/components/contagion-graph.tsx:87-95` (link building loop)

**Step 1: Add type to GraphLink and populate it**

In the `GraphLink` interface, add a `type` field:

```typescript
interface GraphLink extends SimulationLinkDatum<GraphNode> {
  weight: number;
  type: "wrapper" | "mechanism" | "collateral";
}
```

In the link building loop (~line 92), pass through the dependency type:

```typescript
graphLinks.push({
  source: meta.id,
  target: dep.id,
  weight: dep.weight,
  type: dep.type ?? "collateral",
});
```

**Step 2: Verify build passes**

Run: `npm run build`
Expected: Clean build, no type errors.

**Step 3: Commit**

```bash
git add src/components/contagion-graph.tsx
git commit -m "feat(dependency-map): enrich GraphLink with dependency type"
```

---

### Task 2: Add SVG arrowhead markers and weight-scaled edges

**Files:**
- Modify: `src/components/contagion-graph.tsx` — `<defs>` section and edge rendering

**Step 1: Add arrowhead marker definitions**

Inside the `<defs>` block (after the existing clip paths), add three marker definitions — one per type color. The default (gray) marker is used in the default view; colored markers are used on hover.

```tsx
{/* Arrowhead markers */}
<marker id="arrow-default" viewBox="0 0 10 6" refX="10" refY="3"
  markerWidth="8" markerHeight="5" orient="auto-start-reverse">
  <path d="M0,0 L10,3 L0,6 Z" fill="currentColor" opacity={0.4} />
</marker>
<marker id="arrow-collateral" viewBox="0 0 10 6" refX="10" refY="3"
  markerWidth="8" markerHeight="5" orient="auto-start-reverse">
  <path d="M0,0 L10,3 L0,6 Z" fill="#64748b" />
</marker>
<marker id="arrow-mechanism" viewBox="0 0 10 6" refX="10" refY="3"
  markerWidth="8" markerHeight="5" orient="auto-start-reverse">
  <path d="M0,0 L10,3 L0,6 Z" fill="#f59e0b" />
</marker>
<marker id="arrow-wrapper" viewBox="0 0 10 6" refX="10" refY="3"
  markerWidth="8" markerHeight="5" orient="auto-start-reverse">
  <path d="M0,0 L10,3 L0,6 Z" fill="#8b5cf6" />
</marker>
```

**Step 2: Compute edge endpoints offset by target node radius**

Replace the edge rendering section. For each edge, compute arrow-adjusted endpoints so the arrowhead sits at the target node boundary rather than hidden under it.

Direction convention: **upstream (target in data) → dependent (source in data)**. In the existing data, `source = dependent coin`, `target = upstream coin`. We want arrows from upstream to dependent, so we swap: the SVG line goes from `target` (upstream) to `source` (dependent), with `markerEnd` on the source end.

Actually, let's keep it simpler: just flip the x1/y1 and x2/y2 so the line draws from upstream→dependent, and put the marker at the end.

```tsx
{links.map((link, i) => {
  const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
  const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
  // srcId = dependent, tgtId = upstream (from data model)
  // Arrow direction: upstream → dependent, so line goes tgt → src
  const fromPos = positions.get(tgtId); // upstream
  const toPos = positions.get(srcId);   // dependent
  const toNode = nodes.find((n) => n.id === srcId);
  if (!fromPos || !toPos || !toNode) return null;

  // Offset endpoint by target node radius so arrowhead touches boundary
  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const endX = dist > 0 ? toPos.x - (dx / dist) * (toNode.r + 4) : toPos.x;
  const endY = dist > 0 ? toPos.y - (dy / dist) * (toNode.r + 4) : toPos.y;

  const sw = 1 + link.weight * 5;
  const so = 0.15 + link.weight * 0.45;

  return (
    <line
      key={`${srcId}-${tgtId}-${i}`}
      x1={fromPos.x}
      y1={fromPos.y}
      x2={endX}
      y2={endY}
      stroke="currentColor"
      strokeWidth={sw}
      opacity={so}
      markerEnd="url(#arrow-default)"
    />
  );
})}
```

**Step 3: Verify build and visual**

Run: `npm run build`
Expected: Clean build. Edges now have arrowheads and variable thickness.

**Step 4: Commit**

```bash
git add src/components/contagion-graph.tsx
git commit -m "feat(dependency-map): add arrowheads and weight-scaled edges"
```

---

### Task 3: Add edge hover state and tooltip

**Files:**
- Modify: `src/components/contagion-graph.tsx` — add hoveredEdge state, invisible hit areas, tooltip rendering

**Step 1: Add edge hover state**

Near the existing `hoveredId` state (~line 259), add:

```typescript
const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
```

**Step 2: Add invisible wide hit areas behind each edge**

Before the visible edge `<line>`, render an invisible wider line for hover detection. Wrap both in a `<g>`:

```tsx
{links.map((link, i) => {
  const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
  const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
  const fromPos = positions.get(tgtId);
  const toPos = positions.get(srcId);
  const toNode = nodes.find((n) => n.id === srcId);
  if (!fromPos || !toPos || !toNode) return null;

  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const endX = dist > 0 ? toPos.x - (dx / dist) * (toNode.r + 4) : toPos.x;
  const endY = dist > 0 ? toPos.y - (dy / dist) * (toNode.r + 4) : toPos.y;

  const isEdgeHovered = hoveredEdge === i;
  const sw = 1 + link.weight * 5;
  const so = 0.15 + link.weight * 0.45;

  const typeColor = link.type === "mechanism" ? "#f59e0b"
    : link.type === "wrapper" ? "#8b5cf6"
    : "#64748b";
  const dashArray = link.type === "mechanism" ? "6 3"
    : link.type === "wrapper" ? "2 3"
    : undefined;

  return (
    <g key={`${srcId}-${tgtId}-${i}`}>
      {/* Invisible wide hit area */}
      <line
        x1={fromPos.x} y1={fromPos.y} x2={endX} y2={endY}
        stroke="transparent" strokeWidth={14}
        style={{ cursor: "pointer" }}
        onMouseEnter={() => setHoveredEdge(i)}
        onMouseLeave={() => setHoveredEdge(null)}
      />
      {/* Visible edge */}
      <line
        x1={fromPos.x} y1={fromPos.y} x2={endX} y2={endY}
        stroke={isEdgeHovered ? typeColor : "currentColor"}
        strokeWidth={isEdgeHovered ? sw + 1 : sw}
        opacity={isEdgeHovered ? 0.9 : so}
        strokeDasharray={isEdgeHovered ? dashArray : undefined}
        markerEnd={isEdgeHovered ? `url(#arrow-${link.type})` : "url(#arrow-default)"}
        pointerEvents="none"
      />
    </g>
  );
})}
```

**Step 3: Add edge tooltip rendering**

After the existing node tooltip block, add the edge tooltip:

```tsx
{hoveredEdge !== null && (() => {
  const link = links[hoveredEdge];
  if (!link) return null;
  const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
  const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
  const fromPos = positions.get(tgtId);
  const toPos = positions.get(srcId);
  const fromNode = nodes.find((n) => n.id === tgtId);
  const toNode = nodes.find((n) => n.id === srcId);
  if (!fromPos || !toPos || !fromNode || !toNode) return null;

  const mx = (fromPos.x + toPos.x) / 2;
  const my = (fromPos.y + toPos.y) / 2;
  const tx = Math.min(Math.max(mx + 8, PAD), WIDTH - 140);
  const ty = Math.min(Math.max(my - 20, PAD), HEIGHT - 44);
  const pctText = `${Math.round(link.weight * 100)}%`;
  const typeLabel = link.type;

  return (
    <g pointerEvents="none">
      <rect x={tx} y={ty} width={130} height={38} rx={6}
        fill="var(--color-card, #1c1c1c)" stroke="var(--color-border, #333)" strokeWidth={1} />
      <text x={tx + 8} y={ty + 15} fill="currentColor" fontSize={11} fontWeight={600}>
        {fromNode.symbol} → {toNode.symbol}
      </text>
      <text x={tx + 8} y={ty + 30} fill="currentColor" fontSize={10} opacity={0.7}>
        {pctText} · {typeLabel}
      </text>
    </g>
  );
})()}
```

**Step 4: Verify build**

Run: `npm run build`
Expected: Clean build.

**Step 5: Commit**

```bash
git add src/components/contagion-graph.tsx
git commit -m "feat(dependency-map): add edge hover state with type encoding and tooltip"
```

---

### Task 4: Add node-hover spotlight (highlight connected, fade rest)

**Files:**
- Modify: `src/components/contagion-graph.tsx` — edge and node rendering sections

**Step 1: Compute connected set for hovered node**

Add a `useMemo` that computes, for the currently hovered node, which other node IDs and which edge indices are connected:

```typescript
const { connectedNodes, connectedEdges } = useMemo(() => {
  if (!hoveredId) return { connectedNodes: new Set<string>(), connectedEdges: new Set<number>() };
  const cNodes = new Set<string>();
  const cEdges = new Set<number>();
  links.forEach((link, i) => {
    const srcId = typeof link.source === "string" ? link.source : (link.source as GraphNode).id;
    const tgtId = typeof link.target === "string" ? link.target : (link.target as GraphNode).id;
    if (srcId === hoveredId || tgtId === hoveredId) {
      cNodes.add(srcId);
      cNodes.add(tgtId);
      cEdges.add(i);
    }
  });
  return { connectedNodes: cNodes, connectedEdges: cEdges };
}, [hoveredId, links]);
```

**Step 2: Apply spotlight effect to edges**

In the edge rendering, when a node is hovered (`hoveredId` is set), edges NOT in `connectedEdges` fade to 5% opacity. Connected edges show their type encoding:

```tsx
// Inside the edge rendering loop, determine visibility
const isConnected = connectedEdges.has(i);
const isNodeHovered = !!hoveredId;
const isEdgeDirectHovered = hoveredEdge === i;

// If a node is hovered, connected edges show type; unconnected edges fade
const showType = isEdgeDirectHovered || (isNodeHovered && isConnected);
const edgeOpacity = isNodeHovered && !isConnected && !isEdgeDirectHovered
  ? 0.05
  : isEdgeDirectHovered ? 0.9 : so;
```

Use `showType` to decide stroke color, dash pattern, and marker.

**Step 3: Apply spotlight effect to nodes**

In the node rendering, when a node is hovered and it's not the hovered node itself nor a connected node, dim it to 40% opacity:

```tsx
const isNodeDimmed = hoveredId !== null && hoveredId !== node.id && !connectedNodes.has(node.id);
// Apply: opacity={isNodeDimmed ? 0.4 : (isHovered ? 1 : 0.85)} on the outer <circle>
```

**Step 4: Clear hoveredEdge when hovering a node**

In the node `onMouseEnter`, also clear hoveredEdge:

```tsx
onMouseEnter={() => { setHoveredId(node.id); setHoveredEdge(null); }}
```

**Step 5: Verify build**

Run: `npm run build`
Expected: Clean build.

**Step 6: Commit**

```bash
git add src/components/contagion-graph.tsx
git commit -m "feat(dependency-map): add node-hover spotlight with connected edge/node highlighting"
```

---

### Task 5: Add edge type legend and "Show types" toggle

**Files:**
- Modify: `src/components/contagion-graph.tsx` — legend section, add state

**Step 1: Add showTypes toggle state**

```typescript
const [showTypes, setShowTypes] = useState(false);
```

**Step 2: Integrate showTypes into edge rendering**

When `showTypes` is true, all edges display their type encoding (color + dash + colored marker) permanently, not just on hover. Update the `showType` condition:

```tsx
const showType = showTypes || isEdgeDirectHovered || (isNodeHovered && isConnected);
```

**Step 3: Expand legend to include edge types and toggle**

Increase the legend background height to accommodate the new entries. After the grade legend items, add edge type entries:

```tsx
{/* Edge type legend entries */}
{[
  { label: "Collateral", color: "#64748b", dash: undefined },
  { label: "Mechanism", color: "#f59e0b", dash: "6 3" },
  { label: "Wrapper", color: "#8b5cf6", dash: "2 3" },
].map(({ label, color, dash }, i) => (
  <g key={label} transform={`translate(${WIDTH - PAD - 80}, ${PAD + 5 * 18 + 8 + i * 16})`}>
    <line x1={0} y1={5} x2={16} y2={5} stroke={color} strokeWidth={2} strokeDasharray={dash} />
    <text x={22} y={9} fill="currentColor" fontSize={9} opacity={0.6}>{label}</text>
  </g>
))}
```

Add a clickable "Show types" toggle below the legend:

```tsx
{/* Show types toggle */}
<g
  transform={`translate(${WIDTH - PAD - 80}, ${PAD + 5 * 18 + 8 + 3 * 16 + 4})`}
  style={{ cursor: "pointer" }}
  onClick={() => setShowTypes((v) => !v)}
>
  <rect x={-4} y={-2} width={76} height={16} rx={4}
    fill={showTypes ? "var(--color-accent, #3b82f6)" : "var(--color-muted, #333)"}
    fillOpacity={showTypes ? 0.2 : 0.4} />
  <text x={4} y={10} fill="currentColor" fontSize={9} opacity={0.7} fontWeight={500}>
    {showTypes ? "▸ Types on" : "▹ Show types"}
  </text>
</g>
```

**Step 4: Resize legend background**

Update the legend `<rect>` height from `4 * 18 + 30` to accommodate the new entries:

```tsx
height={5 * 18 + 3 * 16 + 50}
```

Also update `legendBox` in the post-simulation resolver to match the new height:

```typescript
bottom: PAD + 5 * 18 + 3 * 16 + 50,
```

**Step 5: Verify build**

Run: `npm run build`
Expected: Clean build.

**Step 6: Commit**

```bash
git add src/components/contagion-graph.tsx
git commit -m "feat(dependency-map): add edge type legend and show-types toggle"
```

---

### Task 6: Update subtitle and description text

**Files:**
- Modify: `src/components/contagion-graph.tsx` — CardHeader description text

**Step 1: Update the description**

```tsx
<p className="text-xs text-muted-foreground">
  Top {nodes.length} stablecoins by market cap. Arrow thickness shows collateral dependency weight. Hover edges for details. Click nodes for detail page.
</p>
```

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean build.

**Step 3: Commit**

```bash
git add src/components/contagion-graph.tsx
git commit -m "feat(dependency-map): update description text for new visual encodings"
```

---

### Task 7: Final build verification and type-check

**Step 1: Full build**

Run: `npm run build`
Expected: Clean build, no warnings related to the changed file.

**Step 2: Visual spot-check**

Run: `npm run dev` and navigate to `/dependency-map`. Verify:
- Edges have arrowheads pointing from upstream → dependent
- Edge thickness varies by weight
- Hovering an edge shows type color/dash + tooltip
- Hovering a node spotlights connected edges, fades rest
- "Show types" toggle works
- Legend shows grade + edge types
- Drag still works
- Click navigation still works
