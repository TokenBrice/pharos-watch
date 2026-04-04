---
name: changelog-collect
description: Autonomously generate a weekly changelog entry from git history. Collects commits for a date range, clusters by theme, writes editorial summary, and outputs a ready-to-commit ChangelogEntry file.
user_invocable: true
---

## Changelog Collection Skill

Generate a complete changelog entry for a given period. Defaults to the last 7 days.

### Invocation

```
/changelog-collect                  # last 7 days
/changelog-collect 2026-03-17 2026-03-24  # explicit range
```

### Workflow

1. **Parse dates**: If two arguments are provided, use them as `from` and `to` (ISO YYYY-MM-DD). Otherwise default to 7 days ago -> today.

2. **Collect commits**:
   ```bash
   git log --oneline --since="<from>" --until="<to>" --format="%h %s"
   ```

3. **Count**: Record total commit count.

4. **Cluster by theme**: Group commits by analyzing prefixes (`feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `ci`) and scopes (parenthesized text after prefix). Identify 5-8 thematic clusters such as:
   - Coverage / data expansion
   - Pipeline / sync reliability
   - UI / UX improvements
   - Risk tooling / scoring
   - Infrastructure / CI / deploys
   - Testing / quality
   - Documentation

5. **Write headline**: Write a single `headline` sentence (≤ 120 chars) that captures the 2-3 most significant changes in the release. This is the thesis the reader sees before the detail bullets — it should answer "what's the big deal this week?" in plain language. Examples:
   - "Yield intelligence rebuilt from the ground up, API auth goes live, and a 100+ fix security audit lands."
   - "Four new DEX APIs feed pricing consensus, Safety Score hits v6.0, and live reserves double to 114 coins."

6. **Write editorial summary**: For each cluster, write one `SummaryItem`:
   - `label`: 2-4 word punchy theme name (e.g. "Broader coverage", "Stronger pipelines")
   - `description`: One concise sentence summarizing the cluster's impact
   - Voice: confident, product-update style. Not technical jargon -- user-facing impact.
   - Omit clusters with fewer than 3 commits unless they represent a notable user-facing change.

7. **Build commit list**: Collect all commits as `CommitRef[]` with 7-char `hash` and first-line `message`.

8. **Generate entry file**: Write the `ChangelogEntry` to `src/data/changelogs/YYYY-MM-DD.ts` (using the `to` date as filename). Follow this exact structure:

   ```ts
   import type { ChangelogEntry } from "./types";

   export const entry: ChangelogEntry = {
     dateRange: { from: "<from>", to: "<to>" },
     headline: "<one-sentence thesis>",
     summary: [
       { label: "...", description: "..." },
       // ...
     ],
     stats: { totalCommits: <N> },
     commits: [
       { hash: "<7-char>", message: "<first line>" },
       // ...
     ],
   };
   ```

9. **Update barrel**: Add an import line and array entry to `src/data/changelogs/index.ts`:
   - Import: `import { entry as e<YYYYMMDD> } from "./<YYYY-MM-DD>";`
   - Add `e<YYYYMMDD>` to the `all` array.
   - The barrel's `.sort()` handles ordering -- just append to the array.

10. **Verify**: Run `npm test -- src/data/changelogs/` to ensure tests still pass.

11. **Commit**:
    ```bash
    git add src/data/changelogs/
    git commit -m "docs(changelog): add changelog for <from> to <to>"
    ```

### Output

The skill produces a committed changelog entry file. No human review step -- the entry is ready to push.

### Quality Guidelines

- Summary bullets should read like a product update, not a git log. Focus on user-facing impact.
- When many commits share a scope (e.g. `fix(pricing): ...`), combine them into one bullet about pricing reliability rather than listing each fix.
- Keep labels short and parallel in structure (noun phrases: "Broader coverage", not "We broadened coverage").
- Include 5-8 summary items. Fewer feels thin; more feels noisy.
- The commit list is exhaustive -- every commit in the range appears in `commits[]`.
