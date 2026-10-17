# Agent Artifacts

Guidance for where agent-produced material belongs now that historical planning artifacts are no longer kept in a dedicated repository archive.

## Source Of Truth

Application source-of-truth documentation lives in `/docs/` and `README.md`. Put durable maintenance guidance in the closest existing verified doc, or create a focused page under `/docs/` when the guidance is repeatable and worth preserving.

Historical plans, one-off audits, exploratory research, point-in-time calibration reports, screenshots, and handoff notes are not product documentation. Keep them in the ignored `/agents/` scratch area unless the user explicitly asks to preserve them. If a historical note becomes useful long term, distill the durable rule or decision into `/docs/` rather than carrying the full artifact forward.

## Where To Put Durable Material

| Material                                        | Destination                                                    |
| ----------------------------------------------- | -------------------------------------------------------------- |
| Repeatable process guidance                     | `docs/process/`                                                |
| Route-specific maintenance guidance             | Route doc or a dedicated subdirectory under `docs/`            |
| Operator remediation procedure                  | `docs/runbooks/`                                               |
| Product, API, pipeline, or methodology behavior | Existing feature/methodology doc plus structured changelog when applicable |
| Architectural decisions                         | [Architectural decisions](#architectural-decisions) → [ADR collection](../architecture.md#architectural-decision-records) |

## Architectural decisions

- **Admission:** a cross-domain constraint, or one that changes write authority, interface meaning, or the authoritative runtime. Domain rulings, methodology versions, release targets, incident counts, and deploy steps stay in owning docs, structured history, or runbooks.
- **Numbering:** next ID = highest existing `#### ADR-N` + 1; never reuse 11–18 (absent from repository history) or renumber existing records.
- **Approval:** the maintainer's merge to protected main. Agents add, amend, or supersede ADR text only when asked, and call ADR text changes out separately in the commit body/PR.
- **Amend vs. supersede:** amend in place for precision, scope, enforcement wording, or falsified clauses; supersede only for true reversals, retaining a tombstone and reciprocal `superseded by` / `supersedes` relations. A falsified premise gets a reciprocal `premise falsified by ADR-N` line on the earlier record in the same change.
- **Status line:** one line after the heading, separated by a blank line, with segments only when non-default: `**Status:** … · **Relations:** … · **Enforcement:** … · **Evidence:** … · **Acceptance:** …`. Never put status text in the `####` heading; anchors derive from it.
- **Evidence:** a verified doc or commit SHA, never ignored `agents/` scratch alone; if missing, write "approval record unavailable".
- **Acceptance close-out:** whoever ships a record with production gates records `Acceptance:` pending/accepted/failed plus evidence; unknown stays `not recorded`.
- **Cron ceilings:** alias/accounting-only changes adding no logical work, fetch surface, or connection pressure get a dated note on `CRON_GROWTH_HEADROOM_POLICY`, not a new ADR; other ceiling crossings still require an ADR per [Cron Trigger Budget Policy](./cron-trigger-policy.md#current-growth-gate).
- **Required co-updates:** in the same change, update quick-nav, reciprocal relation lines, the owning doc, and `docs/doc-ownership.json` ADR background anchors for governed code areas. Update root `AGENTS.md` only if a hard rule changes; `CLAUDE.md` remains a one-line `@AGENTS.md` import.
- **Forbidden in records:** release targets, incident telemetry, and per-application notes.

## Cleanup Rule

Before deleting a historical artifact, check whether any verified doc, test, source comment, or user-facing changelog still references it. Migrate only the durable content needed by current maintainers, then update the reference to the new `/docs/` page or remove it if the note was historical context only.

Do not create new committed planning-archive or calibration-snapshot material. Temporary investigation output should stay local, untracked, or in `/agents/`. Reviewed methodology decisions belong in the owning feature document and structured changelog; the evidence report remains scratch output.

## Campaign Index And Handoff

Use campaign ledgers, dispatch packets, retention records, and task-ID commit bodies only for substantial work spanning sessions or requiring coordinated agent handoffs. A bounded fix or review, including a focused delegated check, needs implementation when authorized, focused validation, and a concise closeout with changes or findings, checks, and unresolved work. Do not create a scratch directory, plan, or ledger just to satisfy the campaign template.

Name new campaign directories `agents/<YYYY-MM-DD>-<slug>/`. Each campaign README is its closure index and carries one row per top-level artifact or task output with these fields:

| Field | Meaning |
| --- | --- |
| `path` | Repository-relative scratch path |
| `kind` | Plan, evidence, generated output, report, or handoff |
| `owner` | Human, team, or assigned session responsible for closure |
| `status` | `active`, `blocked`, `ready-to-release`, `complete`, or `superseded` |
| created / lastReviewed | ISO dates |
| `source/plan` | Stable plan, task IDs, source pin, or other authority |
| `durable destinations` | Verified docs, changelog, source, or `none` |
| `retention` | Review date or event through which the artifact stays useful |
| `safe-to-remove condition` | Explicit gate plus required owner confirmation |

Reserve `outputs/` for reproducible generated material and `evidence/` for reviewed notes. A complete campaign summary must reconcile every task ID, including deferred and superseded work. Use this plan and handoff template:

```md
# <Campaign> — <date>

Owner: <human/team>    Status: active|blocked|ready-to-release|complete|superseded
Created: YYYY-MM-DD    Last reviewed: YYYY-MM-DD
Goal: <bounded outcome and invariants>
Source of truth: <tracked source/docs; scratch is evidence only>

## Global constraints
- <files outside scope, behavior/byte/API invariants, no formatter rule>
- <credential, migration, deployment, and concurrent-tree constraints>

## Task ledger
| ID | Task / exact files | Owner/session | Status | Depends on | Verify | Result |
| A1 | <paths and change> | <agent> | pending | — | <commands + expected result> | — |

## Dispatch packet (repeat per task)
Task: <ID and one-line objective>
Files: <allowlist, including new/deleted files>
Inputs: <brief/report/source refs>
Do not touch: <explicit exclusions>
Verification: <focused commands and invariant/byte/parity expectation>
Return: status, changed files, diff/LOC delta, verification output, blocker, next step.

## Wave gates
<serial/parallel rules, disjointness proof, generated-artifact gates, release gate>

## Closeout / handoff
- Every task ID: <complete|deferred|superseded|blocked>, with reason and owner.
- Actual changed files and net LOC: <recorded from Git>.
- Verification: <commands, commit SHAs, CI/deploy URLs, operational acceptance state>.
- Durable decisions distilled to: <tracked docs/changelog paths>.
- Scratch retention: <keep until/date or safe-to-remove condition>.
- Next action and owner: <one sentence>.
```

## Pinned On-Chain Evidence

Use `npm run research:dwellir-rpc --` (or `node scripts/maintenance/dwellir-rpc.mjs`) for pinned supplemental evidence reads. `--provider dwellir` is the default; select `alchemy`, `drpc`, or `public` explicitly to use another documented read surface. `scripts/lib/pinned-rpc-providers.mjs` reuses the canonical Dwellir, chain-identity, and public/supply endpoint registries; research-only native/provider additions do **not** change runtime provider order, archive eligibility, or log-history declarations. Keep generated evidence in ignored `agents/`.

Set the selected keyed provider's canonical **`DWELLIR_API_KEY`**, **`ALCHEMY_API_KEY`**, or **`DRPC_API_KEY`** in the process environment or repo-root `.env.local` (environment wins); `public` needs no credential. The file is parsed without executing it. Dwellir uses `X-Api-Key`; Alchemy uses a bearer header; existing dRPC paid EVM network mappings use the documented [`Drpc-Key` header](https://drpc.org/docs/gettingstarted/firstrequest) on keyless `ogrpc?network=...`. Solana uses dRPC's [documented route](https://drpc.org/docs/solana-api/blocksinfo/getBlock), `https://lb.drpc.live/solana`, with the same header. Research-only dRPC additions use the exact public hosts documented in its [Chainlist](https://drpc.org/chainlist), without credentials: a public host is not proof of an unverified paid `network=` alias or archive entitlement. Recorded URLs are always keyless, provider echoes are credential-redacted, redirects are rejected, and credentials are never sent to a different provider. There is no automatic provider fallback or alternate credential spelling. Valid identity-matched JSON-RPC errors returned with unsuccessful HTTP status retain `reason: "rpc-error"`, `httpStatus`, `rpcCode`, and `rpcMessage`; for example dRPC code 35 reports missing paid-plan access rather than a generic HTTP 400. No result on an unsuccessful HTTP status is admitted.

```bash
npm run research:dwellir-rpc -- --chain ethereum --method eth_call \
  --params '[{"to":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","data":"0x18160ddd"}]' \
  --block 24000000 --out agents/usdc-supply-evidence.json

npm run research:dwellir-rpc -- --chain ethereum --method eth_getLogs \
  --params '[{"address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","fromBlock":"0x16e3600","toBlock":"0x16e39e8"}]' \
  --block 24001000 --out agents/usdc-log-evidence.json
```

Every read requires `--block`. EVM state methods accept a decimal/hex number or a 32-byte hash; existing parameter pins must match and symbolic tags such as `latest` are rejected, not silently replaced. Hash pins resolve to a numeric state-call tag with header-hash validation. EVM block-header reads use the same pin. Log filters require explicit numeric `fromBlock`/`toBlock` (the end must match `--block`) or matching `blockHash`. Inclusive Dwellir ranges use each entry's `maxLogBlockSpan` from `shared/lib/dwellir-chains.ts`: 1,000 blocks on Monad, 1,024 on Astar, and 10,000 on other verified log hosts, including Ethereum's `api-ethereum-mainnet`. Providers or entries without span metadata retain a conservative 500-block fallback. Chunks preserve provider/range order; a range cap is not a retention or completeness guarantee. Dwellir also caps log results per call: a `-32602` error containing `exceeds max results` splits the affected chunk again, using a valid suggested range upper bound or otherwise bisecting. Subchunks recurse down to a single block; if that block still exceeds the cap, `reason: "result-cap"` withholds the entire result. Split attempts, result-cap errors, and completed subchunks remain in the diagnostics. Any other failed chunk likewise withholds all results; completed chunk counts are not complete evidence.

Supported EVM methods are `eth_call`, `eth_getBalance`, `eth_getStorageAt`, `eth_getCode`, `eth_getTransactionCount`, `eth_getLogs`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getTransactionReceipt`, and `eth_getTransactionByHash`. The two transaction methods require exactly `["<0x 32-byte transaction hash>"]` and an explicit `--block`; the returned object's `blockNumber` must equal the pinned header's number, and its `blockHash` must match the header hash (including a hash-valued `--block`). The helper rereads the canonical header by number after the transaction read and withholds evidence on a reorg or pin mismatch (`block-changed` or `block-pin-mismatch`). A null receipt/transaction remains `state: "empty"` with reason `empty-result-not-proof-of-absence`, never a positive absence claim. Transaction methods are standalone only: `batch` rejects them, just as it rejects log reads.

`eth_call` also accepts `[call, matchingBlock, stateOverrideSet]`, standalone or in a batch, on providers that implement [state overrides](https://drpc.org/docs/ethereum-api/executingtransactions/eth_call). The helper retains the third object unchanged and normalizes only the matching block tag; symbolic/mismatched pins still fail. Such records and affected batch members carry `simulation: true`: overrides describe a hypothetical execution against pinned base state, **not observed balances, supply, authority, or a real redemption receipt**. Provider rejection withholds the result; supported EVM transport does not promise override support on every chain/provider.

`--method batch --params '[{"method":"eth_getBalance","params":["0x..."]},...]'` accepts 1–100 EVM reads sharing one pin, excluding logs and transaction methods. Requests split into ten-member batches, match responses by ID, and retain input order; an error in any member withholds all results. Each member records its own empty/ok state. All network requests, including result-cap subchunks, are serialized with at least 100 ms spacing per response member (10 responses/second). Only result-cap subdivision retries automatically; other failures are not retried or hidden by provider fallback.

For Aptos/Movement, use `--method 'GET /accounts/<address>/resource/<type>' --params '{}' --block <ledger_version>`; other ledger-pinnable account/module/resource GET paths are supported. `--block` means **ledger version**, not block height, and a supplied `ledger_version` must match. The helper looks up the containing block for height/hash/timestamp provenance. Pruned versions fail closed. For Starknet, use `--method starknet_call --params '{"request":{"contract_address":"0x...","entry_point_selector":"0x...","calldata":[]}}' --block <number>`; the pin must fit `Number.MAX_SAFE_INTEGER`, and a supplied numeric `block_id.block_number` must match.

`--provider public` enables canonical keyless EVM endpoints, including Fraxtal, Kaia (`kaia` aliases the catalog's `klaytn`), Hemi, Plume, Filecoin's EVM API, and Rootstock. Corn's research-only Maizenet surface (chain 21000000) uses the [official node guide](https://docs.usecorn.com/docs/developers/Network/Run_a_Node) endpoint `https://maizenet-rpc.usecorn.com`; registration does not guarantee DNS/service availability. `eth_getTransactionCount` is pinnable like other EVM state methods (for example, BSC nonce evidence). Endpoint registration is **not** an archive entitlement: a pruned or unavailable state read remains `error`, and empty historical logs remain non-evidence for an absence or complete census. Filecoin EVM headers do not certify archived Lotus message-metadata availability; Lotus TipSet/parent-state semantics are not EVM parity.

For Hedera, select `--provider public --method eth_call --params '[{"to":"0x...","data":"0x..."}]' --block <number>` (or `--method 'POST /contracts/call' --params '{"to":"0x...","data":"0x..."}'`). The helper uses the canonical mirror REST API, reads `/blocks/<number>` before/after, and sends an explicit block to `/contracts/call`; it records the exact nanosecond consensus timestamp as `consensusTimestamp` alongside UTC block time. This is the mirror node's [historical contract-call API](https://github.com/hiero-ledger/hiero-mirror-node/discussions/13478), not a current-state call dressed with a nearby header.

Solana (`--provider alchemy` or `drpc`) supports finalized [`getBlock`](https://solana.com/docs/rpc/http/getblock), `getTransaction` (the returned slot must equal `--block`), and `getBlocks` (numeric range end must equal `--block`, serialized 500-slot chunks). Example: `--provider alchemy --chain solana --method getBlock --params '[378967388,{"transactionDetails":"full","encoding":"json","maxSupportedTransactionVersion":1}]' --block 378967388`. For an execution census, list produced slots with `getBlocks`, then read every returned block in full; a missing/pruned block or unsupported transaction version is an error, never an empty execution history. The helper does not certify retention or completeness of an address/whole-program census.

Sui with `--provider public` supports **checkpoint-scoped state** through the [official GraphQL endpoint and `Checkpoint.query`](https://docs.sui.io/develop/accessing-data/graphql/query-with-graphql): `--method sui_getObject --params '["0x..."]' --block <checkpoint>` or `--method suix_getBalance --params '["0x...","0x2::sui::SUI"]' --block <checkpoint>`. Fixed read-only queries run under the explicit checkpoint; arbitrary queries/mutations are not accepted. Digest/time is read before/after and all GraphQL errors withhold partial data. Each field has its own retention policy (live object-set/balance reads typically retain roughly one hour); old/pruned checkpoints fail closed, never fall back to latest. The provenance includes the exact GraphQL query/variables. Dwellir's advertised legacy Sui JSON-RPC surface supports `sui_getCheckpoint --params '["1000"]' --block 1000` and `sui_getTransactionBlock --params '["<digest>",{"showEffects":true}]' --block <checkpoint>` with transaction/checkpoint membership checks, but its current-state/object-version methods return `unsupported`. [JSON-RPC is being decommissioned](https://docs.sui.io/develop/accessing-data/graphql/graphql-rpc); use the public GraphQL state path rather than assuming legacy endpoint availability.

For **historical Solana account state**, `--provider alchemy --method getAccountInfo --params '["<pubkey>",{"encoding":"base64"}]' --block <slot>` uses Alchemy's paid [Account Archive](https://www.alchemy.com/docs/solana/account-archive): the helper injects its documented exact `slot` selector and requires `result.context.slot` to match. Archive coverage starts July 2025; paid entitlement and exact account coverage must be available. Vote accounts and, conservatively, all `Sysvar...` accounts are excluded. Null account values remain `empty` (not proof of absence), and missing entitlement/history remains an error without latest fallback. `minContextSlot` and update-history cursors are rejected as substitutes for the exact snapshot. Other providers' standard account/token/program APIs remain `unsupported`: [`getAccountInfo`](https://solana.com/docs/rpc/http/getaccountinfo) has no standard historical-slot selector, and `minContextSlot` is only a lower bound. Read a mint/token account through the exact-slot account archive and decode its observed bytes; do not substitute current `getTokenSupply` or extrapolate account samples into a complete execution census.

Alchemy Solana research uses the Account Archive's documented keyless host `https://solana-mainnet.g.alchemy.com/v2/`, overriding the shared runtime `sol-mainnet` annotation only in this helper. Both its archive and execution requests retain bearer-header authentication; no credential is placed in the recorded URL. A successful exact account read still requires account identity/ABI and complete controller/execution evidence before curation can close a scoped gap.

TRON `triggerconstantcontract` is recognized but returns `state: "unsupported"` / `reason: "unsupported-pinned-state"` without sending a state read. Its [HTTP API](https://developers.tron.network/reference/triggerconstantcontract) simulates current/solidified state, not a chosen historical block; even TRON's [numeric/hash JSON-RPC call objects](https://developers.tron.network/reference/eth_call) execute latest state. A pin-capable provider API is the missing prerequisite; attaching a nearby header would fabricate provenance.

The JSON record contains chain, provider, keyless endpoint, effective method/params, requested pin, block number/hash/UTC timestamp, result, and `observedAt`; Move adds `ledgerVersion`, Solana adds `slot`, Sui adds `checkpoint`, REST reads add the keyless request URL, and range reads retain chunk diagnostics. Headers are read before and after results; changed headers withhold evidence. Number/version fields use decimal strings to preserve integer precision. Top-level `state` is `ok`, `empty`, `error`, or `unsupported`; non-ok records name a machine-readable `reason`, while log chunk diagnostics may also use `state: "split"` for a subdivided result-cap attempt. Unsupported chain/provider combinations name `unsupported-chain-provider`; recognized unpinnable state APIs name `unsupported-pinned-state`. Neither sends a read or fabricates evidence. JSON-RPC errors retain the provider's code and message (with credential redaction). Empty logs are **not proof of absence**, especially on hosts with incomplete history. Failed/unsupported reads have `result: null`, never a synthetic zero or empty list.

Cite the provenance record's keyless URL, block/hash, block timestamp, and observation time; never cite a `latest` read as evidence. A pin identifies what was read, not an independent provider-parity proof. Usage errors exit 2, runtime failures and unsupported capabilities exit 1, help exits 0; optional `--out` writes the same JSON emitted on stdout.

If `--out` cannot be written, stdout instead reports `state: "error"` / `reason: "output-write-failed"` with `result: null` and exit 1; it never reports a successfully persisted evidence record.

For related **production D1 diagnostics**, follow [Remote D1 Inspection](../worker-infrastructure.md#remote-d1-inspection): run `npx --no-install wrangler d1 execute stablecoin-db --remote --json --command "SELECT ..."` with `worker/` as the working directory. Never use `--file` for remote inspection. `--config worker/wrangler.toml` is a valid global option when invoked from the root, but the canonical worker-cwd form avoids relative-config/auth-context ambiguity; a 7403 account-unauthorized failure supplies no rows and is not evidence of missing or zero production state. A successful live SELECT is observation-time database evidence, not an on-chain pin or proof that a quarantined value may be released.

## Agent Skills

Project-local skill directories should contain Pharos-specific workflows only. Keep generic design, browser, vendor, or personal workflow skills in the user's global agent config instead of this repository.

`.codex/skills/<name>/` is the canonical physical skill tree. `.agents/skills` points to `../.codex/skills`; `.claude/skills/<name>/` mirrors canonical files/directories through relative symlinks. Only Codex display metadata at `agents/openai.yaml` is allowlisted; all other companions, including `scripts/` and `references/`, must be mirrored. Run `npm run check:agent-skills` (part of `check:structural`) to validate parity, links, frontmatter, and duplicate physical bodies; use `node scripts/maintenance/sync-agent-skills.mjs --write` to create or repair Claude facade symlinks.

Canonical shared skill bodies must use repo-relative paths such as `.codex/skills/<name>/references/...` or normal repo source paths. Do not use `$CODEX_HOME` paths in a skill that Claude symlinks. The canonical directory listing is the source of truth; do not maintain a skill-name roster here.

Use one compact skill-entry structure: **Trigger And Exclusions** (precise frontmatter plus scope), **Classify The Operation** (choose the requested branch before loading context), **Mandatory Core** (only always-required anchors and safety rules), **Branch Reads And Actions** (owner anchors read only for the selected operation), **Checks Owned By The Verifier** (applicable gates and who runs them), and **Completion Evidence** (observed results, skipped checks and blockers). Keep specialized hard stops in the entry; conditional reading must never hide an always-applicable rule. Put detailed reviewer or rehearsal contracts in existing companions and link them from their branch. In delegated work, writers hand checks to the assigned verifier; the parent owns final integration and validation.

Skill bodies must not hard-code snapshots of current repo state (counts, methodology versions, enum lists, skill rosters). State the rule and point at the owning source file instead; when an enumeration is embedded for reading convenience, mark it with "the source file wins" so agents re-verify before relying on it.

Skill parity is structural proof, not evidence that embedded source paths, commands, or policy claims are current. Before following or changing an instruction, verify its literal path and current owner in source; methodology version ownership follows ADR-3 in `docs/architecture.md`. Fix canonical bodies only, preserving the symlink facade rather than creating duplicate physical copies. Durable contracts must link to owning source or verified docs, never rely on an expired scratch task ID.

Release and CI skills must link to [Pre-push readiness](../testing.md#pre-push-readiness) for local feedback guidance and hosted readiness authority, not introduce a local receipt mandate. Deployment policy, workflow YAML, and automation registries retain their own authority. Keep protected-main authorization, failed-leaf diagnosis, generated-artifact staging behavior, and deployment-versus-operational evidence explicit at the point of action.

Symlinks pointing outside this repository are unsupported. `check:agent-skills` also validates nested canonical companions and rejects broken or external symlink targets.

## Harness Configuration

Repo-local omp settings live in `.omp/config.yml` (tracked). It sets `task.isolation.enabled: false` and `tools.approvalMode: yolo`. Model roles are delegated to global configuration; the repository does not pin a model fleet. Read the tracked overlay for repository policy and discover effective capabilities in the current session without copying personal configuration into the repository.

| Capability | omp | Claude Code | Codex CLI |
| --- | --- | --- | --- |
| Context/config | `.omp/config.yml`; root/scoped `AGENTS.md`/`CLAUDE.md` | Tracked `.claude/settings.json`; root/scoped `CLAUDE.md`/`AGENTS.md` | Root/scoped `AGENTS.md`; no project `config.toml` |
| Hooks | Supported; none configured | Tracked SessionStart + PreToolUse hooks | Ignored `.codex/hooks.json` (opt-in install; enable in Codex) |
| Skills | Discovers `.agents/skills` → `.codex/skills` | `.claude/skills` symlink facade | Canonical `.codex/skills` |
| MCP | Discover session-provided tools | Discover session-provided tools | Discover session-provided tools |
| Subagents | Native `task` when exposed | Native agents when exposed | Native delegation when exposed |
| Isolation/approval | Overlay: isolation disabled, yolo | Effective session permissions | Effective session sandbox and approval policy |
| Web search | Use the available web-search capability | `WebSearch` when enabled | Built-in web search when enabled |
| Primary-source fetch | Native fetch/HTTP capability; shell client fallback | `WebFetch`; shell client fallback | Built-in fetch or shell client fallback |
| Browser inspection | Browser capability when configured | Browser/Playwright integration when configured | Browser MCP/automation when configured |
| Read-only reviewer | Native reviewer with an explicit no-write contract, when available | Native reviewer with an explicit no-write contract, when available | Native reviewer with an explicit no-write contract, when available |

Skills describe these operations by capability and link here instead of embedding harness-specific branches. When delegation is unavailable, perform the bounded discovery and skeptical verification passes sequentially and disclose that review was not independent. Prior explicit authorization remains valid for its stated cohort and action; request a new decision only for uncovered scope or a required row-specific approval. If a capability is unavailable, use the next safe read-only option; never move credentials into URLs or process arguments, and never infer write/delegation authority from tool availability.

## Claude Workflow Orchestrators

Batch orchestration now lives in canonical skills as capability-level fan-out instructions.
Compliance, whole-corpus stablecoin data, and documentation maintenance are routed through their respective skills.
Retired adapters are not preserved; durable guidance belongs in `docs/`, and scratch output belongs in `agents/`.

## Recurring Maintenance

`.github/workflows/agent-maintenance-candidates.yml` runs the deterministic annotation queue, AI-summary staleness queue, and curation digest each Monday. It opens or updates one review issue with bounded excerpts and links to the full per-run artifacts and run history. Immutable per-run artifacts retain the full annotation/AI-summary Markdown and JSON, curation digest, and command logs for 90 days, covering monthly review plus a missed month. The workflow is advisory: it does not edit stablecoin data, summaries, annotations, funding records, or review provenance.

Annotation intake and its curated corpus remain permanent editorial history after retirement of the live chart overlay. Preserve all dispositions, deferrals, legacy backups, and downloaded snapshots; neither an editor appointment nor queue completion is a prerequisite for removing the overlay. A candidate never publishes itself. The 90-day Actions retention is a recovery window, not perpetual storage for the reviewer-owned handoff.

Annotation collection overlaps 14 days and follows cursors serially, bounded to 25 pages and 30 seconds per source with a six-second body deadline per page. It records complete/incomplete source windows without declaring editorial coverage. Download retained artifacts and run `npm run candidates:annotations -- --replay agents/annotation-history` for offline oldest-first review. `annotations-refresh` owns explicit candidate-ID decisions in ignored `agents/annotation-review.json` (`promote`, `drop`, or `defer`, with review time and reason); generation/replay never writes decisions. Legacy date-only `last_swept_at` is preserved but neither suppresses events nor advances. Retain the review file, queues, and required history together at handoff; an incomplete source window cannot establish completed review coverage.

Pre-launch and funding research remain deliberate operator workflows because they require current external-source verification and explicit approval. Candidate producers should automate discovery and triage, not editorial or financial decisions.

## Plugins And MCP

Pharos currently has no repository-owned plugin or MCP server. Keep it that way until the repository needs a shareable bundle or a live external integration that skills and scripts cannot provide. Saved workflows must not load tools from a user's plugin-cache path; installed global plugins are optional capabilities, not project dependencies.

## Local Hook Setup

Tracked hooks are intentionally limited to deterministic Git policy under `.githooks/` and stateless Claude hook configuration in `.claude/settings.json`. The pre-commit hook runs `npm run sync:staged-artifacts`, regenerating and staging the committed generated artifacts marked `autoStage` that the staged sources affect; its selection, abort, and bypass semantics are owned by [Scripts](../scripts.md#operational-notes). Codex executable hooks remain an explicit local opt-in because they can run shell commands outside normal tool approval:

```bash
PHAROS_INSTALL_CODEX_HOOKS=1 npm run agent:setup
```

The setup command writes ignored `.codex/hooks.json`; it never changes global configuration. The former `agent:doctor` posture check was removed; agent-infrastructure drift is reviewed by hand. Root `AGENTS.md` is the single authored instruction file; `CLAUDE.md` is a one-line `@AGENTS.md` import.

Canonical Codex matchers include `Bash` and `apply_patch`, retaining captured `exec_command` compatibility. `npm run agent:setup` reports installed/current configuration and recorded per-hook enablement only. Feature or managed-policy overrides and actual invocation remain unverified until a safe call in the active harness; use `/hooks` to review disabled hooks. Disabled or unrecorded state does not change setup's installation exit status. Hooks remain a per-checkout opt-in; rerun the opt-in command in each worktree.

Hook paths resolve from tool workdir (relative to session cwd), then session cwd, then repository root. Policy checks use normalized paths and symlink ancestors and include patch move destinations. Remote SQL `--file` inspection reads the exact effective cwd; Single-operand `cd` in an all-`&&` chain and Wrangler `--cwd` are supported. Ambiguous grouped, branching, semicolon-separated, or environment-dependent cwd writes must use a direct invocation with explicit workdir. Ordinary groups, `if`, and `while` commands are inspected; quoted examples and comments are inert. These hooks are bounded policy checks, not exhaustive shell enforcement.

Shell pipelines into a recognized shell (including `env`, `command`, `exec`, and other supported executable wrappers) inspect literal stdin scripts from simple `echo` and `printf` producers. Guarded scripts are denied in both pre-tool and permission-request hooks; unsupported or dynamic producers carrying guarded keywords fail closed. Benign literal scripts, read-only commands, and quoted examples that remain data inside the script are allowed. This remains a bounded policy check, not a shell sandbox.

Shell hook payloads accept both `command` and `cmd` fields and pass them through the same pre-tool and permission-request policy checks.

Set `PHAROS_HOOK_DIAGNOSTICS=1` or pass `--diagnostics` to append one safe JSONL record per hook invocation.
The default diagnostic file is `agents/hook-diagnostics.jsonl`; set `PHAROS_HOOK_DIAGNOSTICS_FILE` for another local path. Diagnostic writes reject protected paths, symlink destination files, multiply linked files, and nonregular files; unavailable diagnostics never change the hook decision or exit status. Hook-state reporting preserves `#` characters inside quoted TOML keys.
Records contain a timestamp, harness, event, tool name, decision, rule, the count of protected paths touched, and a short command digest - never command text or secrets.

Diagnostics are permanent local troubleshooting support, off by default and separate from the authoritative hook policy. The operator owns a bounded investigation window: record the destination, retention purpose and end date, then unset the opt-in to stop accrual. Archive needed campaign evidence under its recorded retention before rotating or removing scratch JSONL; ignored files are not automatically disposable. Tracked hook settings must not enable diagnostics globally, upload rows, or require append success.
