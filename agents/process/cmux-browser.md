# cmux Browser Automation

> Upstream docs: https://cmux.com/docs/browser-automation

The `cmux browser` command group provides full browser automation from within a cmux terminal session. It replaces `agent-browser` as the primary tool for interacting with web pages that can't be consumed via API or `WebFetch`.

## When to Use

| Scenario | Tool |
|---|---|
| Structured API data (CoinGecko, DefiLlama, Etherscan) | API endpoint via `fetch` / `WebFetch` |
| Static page that `WebFetch` handles fine | `WebFetch` |
| JS-heavy page, 403 from `WebFetch`, or DOM interaction needed | `cmux browser` |
| Visual verification / screenshot capture | `cmux browser screenshot` |
| Form submission, authentication flows | `cmux browser` (fill, click, state save/load) |

## Quick Reference

### Surface Lifecycle

```bash
# Open a page (returns surface ID, e.g. surface:11)
cmux browser open https://example.com

# Target subsequent commands at that surface
cmux browser surface:11 <subcommand>
# or
cmux browser --surface surface:11 <subcommand>

# Close when done
cmux browser surface:11 tab close
```

### Navigation

```bash
cmux browser surface:ID navigate https://example.com
cmux browser surface:ID back
cmux browser surface:ID forward
cmux browser surface:ID reload
cmux browser surface:ID url          # get current URL
```

### Waiting

```bash
cmux browser surface:ID wait --load-state complete --timeout-ms 15000
cmux browser surface:ID wait --selector "#checkout"
cmux browser surface:ID wait --text "Order confirmed"
cmux browser surface:ID wait --url-contains "/dashboard"
cmux browser surface:ID wait --function "window.__appReady === true"
```

### Inspection

```bash
# Accessibility tree (full)
cmux browser surface:ID snapshot --compact

# Accessibility tree (interactive elements only — useful for forms/navigation)
cmux browser surface:ID snapshot --interactive --compact

# Page metadata
cmux browser surface:ID get title
cmux browser surface:ID get text "selector"
cmux browser surface:ID get value "selector"

# Element state
cmux browser surface:ID is visible "selector"
cmux browser surface:ID is enabled "selector"
cmux browser surface:ID is checked "selector"

# Find by accessibility role
cmux browser surface:ID find role button --name "Submit"
cmux browser surface:ID find role link --name "Learn more"

# Screenshot
cmux browser surface:ID screenshot --out /tmp/screenshot.png
```

### DOM Interaction

```bash
cmux browser surface:ID click "selector"
cmux browser surface:ID click "selector" --snapshot-after   # captures state after click
cmux browser surface:ID dblclick "selector"
cmux browser surface:ID hover "selector"
cmux browser surface:ID focus "selector"
cmux browser surface:ID check "selector"
cmux browser surface:ID uncheck "selector"
cmux browser surface:ID scroll-into-view "selector"
cmux browser surface:ID scroll --direction down --amount 500
```

### Text Input

```bash
cmux browser surface:ID type "selector" --text "hello"   # simulates keystrokes
cmux browser surface:ID fill "selector" --text "hello"    # sets value directly
cmux browser surface:ID press Enter
cmux browser surface:ID select "selector" "value"
```

### JavaScript

```bash
cmux browser surface:ID eval "document.title"
cmux browser surface:ID addinitscript "console.log('injected at page start')"
cmux browser surface:ID addscript "console.log('injected now')"
cmux browser surface:ID addstyle "body { background: red; }"
```

### Debugging

```bash
cmux browser surface:ID console list
cmux browser surface:ID errors list
cmux browser surface:ID screenshot --out /tmp/debug.png
```

### Session & State

```bash
cmux browser surface:ID cookies get
cmux browser surface:ID cookies set name value
cmux browser surface:ID cookies clear
cmux browser surface:ID storage local set key value
cmux browser surface:ID storage session set key value
cmux browser surface:ID state save /tmp/session.json
cmux browser surface:ID state load /tmp/session.json
```

### Tabs

```bash
cmux browser surface:ID tab list
cmux browser surface:ID tab new https://example.com
cmux browser surface:ID tab switch 2
cmux browser surface:ID tab close
```

### Frames & Dialogs

```bash
cmux browser surface:ID frame "selector"     # target an iframe
cmux browser surface:ID dialog accept
cmux browser surface:ID dialog dismiss
```

## Common Patterns

### Navigate, Wait, Inspect

```bash
cmux browser open https://pharos.watch
# returns surface:ID
cmux browser surface:ID wait --load-state complete --timeout-ms 15000
cmux browser surface:ID snapshot --interactive --compact
cmux browser surface:ID get title
```

### Fill and Submit a Form

```bash
cmux browser surface:ID fill "#email" --text "user@example.com"
cmux browser surface:ID fill "#password" --text "$PASSWORD"
cmux browser surface:ID click "button[type='submit']" --snapshot-after
cmux browser surface:ID wait --text "Welcome"
```

### Debug a Failed Interaction

```bash
cmux browser surface:ID console list
cmux browser surface:ID errors list
cmux browser surface:ID screenshot --out /tmp/failure.png
```

### Persist and Restore Session

```bash
cmux browser surface:ID state save /tmp/session.json
# later…
cmux browser surface:ID state load /tmp/session.json
```

## Notes from Testing

Verified working in this repo's cmux terminal session (2026-03-24):

- `open`, `navigate`, `wait --load-state`, `get title`, `url` — all work
- `snapshot --compact` and `snapshot --interactive --compact` — return clean accessibility trees
- `screenshot --out` — captures PNG to disk, readable via `Read` tool
- `eval` — works for simple JS expressions; numeric return values may need `String()` wrapping
- `click` with `--snapshot-after` — returns post-mutation accessibility tree inline
- `find role <role> --name` — works; name must match the actual accessible name from the snapshot
- `tab close` — cleanly disposes the surface
- `eval` on complex pages (e.g. pharos.watch with heavy JS) may throw `js_error` — use `snapshot` or `get text` as alternatives for DOM queries on those pages
