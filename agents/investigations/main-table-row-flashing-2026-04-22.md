## Main table row flashing investigation

- Date: 2026-04-22
- Scope: homepage `StablecoinTable` row backgrounds flashing/changing while scrolling

### Success criteria

- Reproduce or explain the row-background flashing from code.
- Identify the specific selector/component interaction that causes the unstable row colors.
- Document the smallest credible fix direction.

### Findings

The main table combines DOM virtualization with CSS striping that depends on DOM position:

1. `src/components/stablecoin-table.tsx` virtualizes the body with `useVirtualizer()` and renders only the current window of rows.
2. The same component inserts spacer rows (`paddingTop` / `paddingBottom`) before and after the visible window.
3. `src/app/globals.css` applies striping with `.pharos-table-striped tbody tr:nth-child(even)`.

That selector stripes by the row's current DOM position, not by its stable dataset index. In a virtualized table, DOM positions are constantly reused as the scroll window moves, so a given logical row can alternate between odd/even styling while scrolling. The spacer rows also participate in `nth-child(...)`, which offsets parity further whenever the top spacer is present.

### Relevant code

- `src/components/stablecoin-table.tsx:210` initializes the virtualizer.
- `src/components/stablecoin-table.tsx:302` conditionally renders the top spacer row.
- `src/components/stablecoin-table.tsx:310` renders only `virtualItems`.
- `src/app/globals.css:515` stripes rows with `tbody tr:nth-child(even)`.

### Root cause

Unstable stripe/background assignment caused by using `nth-child(even)` on a virtualized `<tbody>` that also includes spacer `<tr>` elements.

### Smallest fix direction

Stop deriving stripe color from DOM child position. Instead, compute striping from the stable row index and apply an explicit class/data-attribute per rendered row, for example:

- `virtualRow.index % 2 === 1` -> striped
- keep spacer rows unstriped

This preserves consistent row backgrounds regardless of virtualization window changes.
