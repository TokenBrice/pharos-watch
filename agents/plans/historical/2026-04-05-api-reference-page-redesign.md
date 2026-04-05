# API Reference Page Redesign — Design Spec

**Date:** 2026-04-05
**Scope:** Redesign `/about/api/` from single-column with horizontal pill nav to two-column layout with sticky sidebar for desktop, drawer nav for mobile.

## Audience

External developers building integrations against `api.pharos.watch`. They arrive cold, need to orient quickly, find endpoints by path, copy response shapes, and understand auth requirements.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Layout | Two-column (sidebar + content with inline code) | Sidebar solves the core navigation problem for 12 sections / 58 endpoints. Three-column overkill — Pharos endpoints are mostly GET-only JSON, no complex request bodies. |
| Sidebar scope | Reference body only | Hero/onboarding section stays full-width. Sidebar appears once the endpoint reference begins. External devs benefit from the full-width context-setting header before diving into dense docs. |
| Endpoint heading style | Method badge + monospace path | `GET /api/stablecoins` as the visual anchor, not prose titles. Devs scan for paths. |
| Method badges | Colored pills (GET=green, POST=amber) | In both sidebar TOC and content headings. Universal convention. |
| Copy buttons | On all code blocks | One-click copy for response examples, URLs, curl snippets. Table-stakes for developer docs. |
| Collapsible endpoints | No | Makes Cmd+F unreliable. With a good sidebar, collapsing adds friction without clear benefit. |
| Search/filter | Not in scope | 58 endpoints with a well-organized sidebar is scannable enough. Can add later if needed. |

## Page Structure

### Zone 1 — Onboarding Header (full-width)

No structural changes. Keeps the existing layout:

1. Breadcrumb (`Dashboard / About / API Reference`)
2. Title + Quick Facts card (grid layout)
3. Three lane cards (External API, Website lane, Ops lane)
4. Amber "Need a Key?" CTA
5. "Before You Call The API" intro section

This zone renders at `max-w-[76rem]` as today with no sidebar.

### Zone 2 — Reference Body (two-column)

Replaces the current `LongformScrollspyNav` horizontal pill bar + stacked sections.

**Layout:** `lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-6` inside the same `max-w-[76rem]` container.

#### Left: Sidebar (`ApiReferenceSidebar`)

- **Position:** `sticky top-0` with independent scroll (`overflow-y-auto`, `max-h-screen`)
- **Structure:** Two-level TOC
  - **Level 1:** Section groups (Surface Split, Public API Auth, Stablecoin IDs, Response Headers, etc.) — displayed as collapsible headings. Concept sections (non-endpoint) show as plain text links. Endpoint group sections (Public Endpoints, Admin Endpoints) expand to show child endpoints.
  - **Level 2:** Individual endpoints within Public/Admin groups — shown as `METHOD /path` with colored method badge, monospace font, truncated with ellipsis if too long.
- **Active state:** Scrollspy via IntersectionObserver highlights the current section/endpoint. Active item gets a left accent border + brighter text + subtle background.
- **Collapse behavior:** "Public Endpoints" and "Admin Endpoints" groups are collapsible (they contain 32 and 26 child endpoints respectively). Concept sections (Surface Split, Auth, IDs, etc.) are plain links with no children — they scroll directly to the section. The endpoint group containing the active item auto-expands; clicking a group heading toggles it manually. Clicking an endpoint scrolls to it and updates the URL hash.
- **Scroll into view:** When scrollspy updates the active item, the sidebar auto-scrolls to keep the active item visible.

#### Right: Main Content

Existing section/endpoint rendering with these changes:

- **Endpoint headings:** Replace the current `<span>` with prose title → method badge pill + monospace path as the primary `<h3>`. Format: `[GET] /api/stablecoins` where the badge is a colored pill.
- **Code blocks:** Add a copy button (top-right of the code block header bar). Uses `navigator.clipboard.writeText()` with a brief "Copied!" feedback state.
- **Everything else:** Section cards, parameter tables, prose blocks, lists — unchanged structurally, just inherit the new column width.

### Mobile Behavior (below `lg` breakpoint)

- Sidebar is hidden (`hidden lg:block`)
- A compact sticky bar appears at the top of Zone 2 showing:
  - Current section name (updated by scrollspy)
  - Hamburger button that opens the full sidebar TOC in a shadcn `Sheet` (slide-from-left drawer)
- The drawer contains the same sidebar component, just rendered in the Sheet body
- Selecting an item in the drawer closes the Sheet and scrolls to the target

## Components

### New Components

| Component | File | Responsibility |
|---|---|---|
| `ApiReferenceSidebar` | `src/components/api-reference-sidebar.tsx` | Client component. Renders the two-level collapsible TOC with method badges, scrollspy, and active-state tracking. Accepts sections data as props. |
| `ApiReferenceMobileNav` | `src/components/api-reference-mobile-nav.tsx` | Client component. Sticky bar with current section display + Sheet drawer containing the sidebar. |
| `CopyButton` | `src/components/copy-button.tsx` | Client component. Small icon button that copies text to clipboard with "Copied!" feedback. Reusable beyond this page. |
| `MethodBadge` | Inline in sidebar/page or small shared component | Renders colored `GET`/`POST` pill. Green for GET, amber for POST. |

### Modified Components/Files

| File | Changes |
|---|---|
| `src/app/about/api/page.tsx` | Replace `LongformScrollspyNav` usage with the new two-column layout. Zone 1 stays full-width, Zone 2 uses the grid with sidebar. Update endpoint `<h3>` to use method badge + path. |
| `src/lib/api-reference-doc.ts` | Add HTTP method extraction from endpoint titles (parse `GET /api/...` or `POST /api/...` from `### ` headings). Add method field to subsection type. |
| `src/components/longform-scrollspy-nav.tsx` | No changes — it's used elsewhere. Just stop importing it in the API page. |

### Removed from API Page

- `LongformScrollspyNav` import and usage (horizontal pill bar)
- The `EndpointIndex` "Jump Within This Section" card (sidebar replaces this)

## Method Badge Colors

Using Tailwind classes with static strings (per project gotcha — no dynamic construction):

| Method | Badge classes |
|---|---|
| `GET` | `bg-emerald-500/15 text-emerald-400 border-emerald-500/25` |
| `POST` | `bg-amber-500/15 text-amber-400 border-amber-500/25` |

## Scrollspy Approach

Reuse the same `IntersectionObserver` pattern from `LongformScrollspyNav` but adapted for the sidebar:

- Observe all section and subsection elements by their `id`
- `rootMargin: "-10% 0px -70% 0px"` to trigger in the top third of the viewport
- On intersection change, update the active ID state
- Sidebar uses the active ID to: highlight the item, expand its parent group, scroll into view

## Data Flow

No new data fetching. The existing `loadApiReferenceDocument()` server function parses `docs/api-reference.md` and returns sections with subsections. The only parser change is extracting the HTTP method from subsection titles (they already follow `### \`GET /api/...\`` format).

The sidebar and mobile nav receive the same `navSections` prop derived from the document, extended with a `method` field per endpoint subsection.

## What Does NOT Change

- `docs/api-reference.md` — no changes to the markdown source
- Zone 1 content/layout (hero, lanes, CTA, intro)
- Overall page URL and metadata
- Section/subsection `id` slugs and hash-based deep linking
- `LongformScrollspyNav` component itself (used on other pages)
- Code block rendering (just adding a copy button overlay)
- Table rendering
- Inline markdown rendering (links, code, bold)
