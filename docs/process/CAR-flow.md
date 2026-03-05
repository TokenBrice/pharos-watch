# CAR Flow

Last validated: **2026-03-05**  
Validated versions: `codex-autorunner 1.4.4`, `codex-cli 0.110.0`

## Purpose

This runbook documents the working CAR (Codex Autorunner) flow used for this repo, including setup, ticket-flow bootstrapping, model pinning, monitoring, and common failure recovery.

---

## Prerequisites

1. `python3 --version` works (3.9+).
2. `codex --version` works.
3. `car --version` works.
4. The target repo is a git repo.

---

## Recommended Topology

Use **hub mode** and run ticket flow against a repo cloned/registered inside the hub.

Why:

1. On `car 1.4.4`, ticket flow expects the repo to be present in hub manifest state.
2. Running only `car init --mode repo` can fail to start flow if not hub-registered.

---

## Setup (Validated)

```bash
SRC_REPO="/home/ahirice/Documents/git/stablecoin-dashboard"
HUB="$HOME/car-hub-test"
REPO_ID="stablecoin-dashboard-test"

mkdir -p "$HUB"
car init --mode hub "$HUB"
car hub clone --path "$HUB" --git-url "$SRC_REPO" --id "$REPO_ID"
```

Expected repo path:

```bash
TEST_REPO="$HUB/$REPO_ID"
```

---

## Seed Work Context

In current CAR flow, bootstrap ticket expects `.codex-autorunner/ISSUE.md`.

```bash
cp "$TEST_REPO/docs/plans/2026-03-05-simplification-audit-handover.md" \
   "$TEST_REPO/.codex-autorunner/ISSUE.md"
```

If source file lives outside the cloned repo, copy from absolute source path instead.

---

## Start Hub UI

```bash
car serve --hub "$HUB"
```

Default UI URL is printed by CAR (commonly `http://127.0.0.1:4173` in this environment).

---

## Start Flow

```bash
car flow ticket_flow bootstrap --repo "$TEST_REPO" --hub "$HUB" --force-new
```

Notes:

1. `bootstrap` creates `TICKET-001.md` if needed.
2. `preflight` may report "No tickets found" before bootstrap; that is expected.

---

## Model Pinning (GPT-5.3 xhigh)

For this account/CLI combination, `gpt-5.3-x-high` is not accepted as a direct model id.  
Working equivalent is:

1. model: `gpt-5.3-codex`
2. reasoning: `xhigh`

Set in hub config:

```yaml
repo_defaults:
  codex:
    model: gpt-5.3-codex
    reasoning: xhigh
```

Then start a fresh run:

```bash
car flow ticket_flow start --repo "$TEST_REPO" --hub "$HUB" --force-new
```

---

## Monitoring and Control

Check status:

```bash
car flow ticket_flow status --repo "$TEST_REPO" --hub "$HUB" --json
```

Stop run:

```bash
car flow ticket_flow stop --repo "$TEST_REPO" --hub "$HUB"
```

Resume/start latest:

```bash
car flow ticket_flow start --repo "$TEST_REPO" --hub "$HUB"
```

---

## Observed Flow Behavior (2026-03-05)

1. Ticket flow successfully advanced across generated tickets (`TICKET-001` -> `TICKET-002` -> `TICKET-003`).
2. Worker remained healthy while status reported:
   - `status: running`
   - `worker.status: alive`
3. Event sequence (`last_event_seq`) is a useful liveness signal during long turns.

---

## Common Issues and Fixes

1. **Repo not registered in hub manifest**
   - Symptom: flow start/bootstrap fails with hub-manifest warning.
   - Fix: use `car hub clone ...` or `car hub scan --path "$HUB"` for existing repos.

2. **Invalid model identifier**
   - Symptom: Codex API error for unsupported model name.
   - Fix: use a model from `GET /api/agents/codex/models` in hub server, then set reasoning separately.

3. **Stale run conflict**
   - Symptom: start/resume conflict with prior run state.
   - Fix: inspect status first; use `--force-new` only when prior run is stale or intentionally abandoned.
