# magi-linear-axi

Agent-native Rust CLI for direct, non-interactive Linear GraphQL operations. It covers issues, teams, users, projects, cycles, milestones, initiatives, labels, documents, raw GraphQL, schema export, and agent session integration without depending on another Linear CLI.

[![Crates.io](https://img.shields.io/crates/v/magi-linear-axi.svg)](https://crates.io/crates/magi-linear-axi)
[![docs.rs](https://docs.rs/magi-linear-axi/badge.svg)](https://docs.rs/magi-linear-axi)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)
[![Rust 1.87+](https://img.shields.io/badge/rust-1.87%2B-orange.svg)](Cargo.toml)

**Showcase:** [open the self-contained HTML overview](docs/showcase.html) locally—no external assets or network dependencies required.

> **Quick path:** install with Cargo, export `LINEAR_API_KEY`, verify with `auth whoami`, then use modeled resource commands. Default output is compact [TOON](https://toonformat.dev/); use `--format json` when a downstream tool requires JSON.

## Read-only benchmark harness

The isolated Node benchmark under [`benchmarks/linear`](benchmarks/linear) compares this CLI with Linear MCP using dynamic snapshot tasks. Its AXI condition never gives Claude or Bash the Linear key: a runner-owned, mode-0700 Unix-socket broker validates bounded read-only argv and injects the pinned endpoint/key only when spawning the resolved binary. The callable wrapper is key-free and temporary. Pipelines, chaining, command separators, substitutions, line continuations, parentheses, ampersands, and redirection are hard compliance/correctness failures. Snapshot generation uses query-only guards, confirms the persisted invalid identifier with a bounded direct lookup, and keeps generated exact values within AXI's 240-Unicode-code-point default output limit without slicing facts. The harness records an exact task-manifest SHA-256 and requires it to match across every cohort cell. See the benchmark README for the offline test contract and live-command safety gates.

## Contents

- [Quick start](#quick-start)
- [AXI contract](#axi-contract)
- [Authentication and configuration](#authentication-and-configuration)
- [Command guide](#command-guide)
- [Raw GraphQL and schema](#raw-graphql-and-schema)
- [Agent integrations and completions](#agent-integrations-and-completions)
- [Reliability, limits, and mutation safety](#reliability-limits-and-mutation-safety)
- [Security boundaries](#security-boundaries)
- [Development](#development)

## Quick start

Requirements: Rust 1.87 or newer with Cargo, network access to Linear, and a [Linear personal API key](https://linear.app/settings/api). API keys remain environment-only.

Install latest published release:

```sh
cargo install magi-linear-axi --locked
magi-linear-axi --version
```

Install from this checkout while developing:

```sh
cargo install --path . --locked
```

Authenticate and verify account:

```sh
export LINEAR_API_KEY='lin_api_...'
magi-linear-axi auth whoami
```

Find team IDs, inspect issues, then create or update one:

```sh
magi-linear-axi team list
magi-linear-axi issue list --team ENG --limit 25
magi-linear-axi issue view ENG-123 --full

magi-linear-axi issue create \
  --team <team-id> \
  --title 'Fix authentication timeout' \
  --description 'Observed behavior and acceptance criteria' \
  --priority 2

magi-linear-axi issue update ENG-123 --title 'Fix login timeout' --priority 1
```

Use raw GraphQL when modeled commands do not cover an operation:

```sh
magi-linear-axi api '{ viewer { id name email } }'
```

Install session-start context for supported coding agents:

```sh
magi-linear-axi setup
```

Run focused help before unfamiliar reads or mutations:

```sh
magi-linear-axi --help
magi-linear-axi issue create --help
magi-linear-axi project update --help
```

## AXI contract

`magi-linear-axi` follows an agent-facing command contract:

- No arguments returns compact home metadata and useful next commands; it does not require authentication or network access.
- Commands never prompt. Supply identifiers, values, files, and workspace through arguments, flags, stdin, or environment.
- API-backed success data and application errors go to stdout. Diagnostics, including retry notices, go to stderr.
- Default structured format is TOON. `--format json` renders API-backed results and post-parse application errors as compact JSON.
- Strings longer than 240 Unicode code points are recursively truncated and include the original code-point count. `--full` disables truncation.
- Exit `0`: success, explicit empty result, or safe no-op. Exit `1`: authentication, configuration, network, API, or output failure. Exit `2`: command or argument usage failure.
- Unknown commands and flags fail before authentication or network access.
- Global options can appear before or after subcommands.

```text
magi-linear-axi [--workspace <slug>] [--endpoint <url>]
                [--format toon|json] [--full]
                <command> [args]
```

Structured application errors contain stable fields. Operational failures use exit code `1`; usage failures use exit code `2`:

```json
{"error":{"type":"auth","code":1,"message":"LINEAR_API_KEY must be set and non-empty"}}
```

```json
{"error":{"type":"usage","code":2,"message":"what input must be corrected"}}
```

Current single-document exceptions: `issue id` and `team id` emit plain identifiers; generated shell completions, help, and version emit plain text; `issue pull-request` passes through `gh` JSON before rendering its Linear result. Parser-level failures occur before output-format resolution and are emitted as structured TOON even when `--format json` was supplied. Do not send these exceptional outputs directly to a strict JSON parser.

## Authentication and configuration

### Environment

| Variable | Purpose | Required |
| --- | --- | --- |
| `LINEAR_API_KEY` | Linear personal API key | All network commands |
| `LINEAR_API_URL` | GraphQL endpoint override | No; defaults to Linear production API |
| `LINEAR_WORKSPACE` | Workspace slug used by browser-opening commands | Only when opening web/app URLs without `--workspace` |

`LINEAR_API_KEY` must be non-empty. It is never loaded from TOML, stored by setup, or printed.

### Endpoint files

Project configuration uses `./.linear.toml`. Global configuration uses:

- `$XDG_CONFIG_HOME/linear/linear.toml` when `XDG_CONFIG_HOME` is set;
- otherwise `~/.config/linear/linear.toml` on macOS/Linux;
- `%APPDATA%\linear\linear.toml` on Windows.

Only `endpoint` is read from files; unknown keys are ignored:

```toml
endpoint = "https://api.linear.app/graphql"
```

Endpoint precedence, highest first:

1. `--endpoint`
2. non-empty `LINEAR_API_URL`
3. project `.linear.toml`
4. global `linear/linear.toml`
5. `https://api.linear.app/graphql`

Workspace precedence is `--workspace` then non-empty `LINEAR_WORKSPACE`. Workspace is not read from config files and is optional except for browser-opening commands. Existing malformed config fails with its path instead of being silently ignored.

Remote endpoints must use HTTPS. Plain HTTP is accepted only for loopback hosts (`localhost`, `127.0.0.1`, and `[::1]`) so hermetic local tests can run without TLS.

## Command guide

### Issues

Issue references accept identifiers such as `ENG-123`. When omitted, relevant commands try to extract an identifier from current Git branch.

| Job | Commands |
| --- | --- |
| Discover | `issue mine`, `issue list`, `issue query` |
| Inspect | `issue view`, `title`, `describe`, `url`, `id` |
| Mutate | `issue create`, `update`, `start`, `delete` |
| Comments | `issue comment list \| add \| update \| delete` |
| Attachments and links | `issue attach`, `issue link` |
| Relations | `issue relation list \| add \| delete` |
| Agent sessions | `issue agent-session list \| view` |
| Local repository helpers | `issue commits`, `issue pull-request` |

```sh
# Filtered reads
magi-linear-axi issue mine --state 'In Progress'
magi-linear-axi issue query --team ENG --search 'authentication' --label bug
magi-linear-axi issue query --assignee <user-id> --project <project-id>
magi-linear-axi issue view ENG-123

# Opt-in compact reads
magi-linear-axi issue query --team ENG --fields compact
magi-linear-axi issue view ENG-123 --fields compact

# Comments
magi-linear-axi issue comment list ENG-123 --fields compact --limit 20
magi-linear-axi issue comment add ENG-123 --body 'Investigation complete.'
magi-linear-axi issue comment update <comment-id> --body 'Corrected update.'
magi-linear-axi issue comment delete <comment-id>

# Links, uploads, and relations
magi-linear-axi issue link ENG-123 https://example.com/runbook --title 'Runbook'
magi-linear-axi issue attach ENG-123 ./evidence.png --title 'Failure screenshot'
magi-linear-axi issue relation list ENG-123 --fields compact --limit 20
magi-linear-axi issue relation add ENG-123 blocks ENG-456
magi-linear-axi issue relation delete ENG-123 blocks <relation-id>

# Open in Linear; workspace slug is required
magi-linear-axi --workspace acme issue view ENG-123 --web
magi-linear-axi --workspace acme issue view ENG-123 --app
```

Compact projections are opt-in: `--fields compact` is supported by issue view, issue mine/list/query, issue comment list, issue relation list, and project view. Compact issue lists return identifier/title plus `pageInfo`. Compact comments and both relation connections default to 50 records (override with `--limit`) and retain `pageInfo`, including `hasNextPage`, so bounded output reports whether records remain. Invalid or unsupported selectors fail during argument parsing with exit `2`, before authentication or network access. Compact relation output omits relation IDs; use default `issue relation list` before deletion.

Representative mocked issue-view regression fixture reduces GraphQL selection from 148 to 87 bytes and rendered JSON from 287 to 134 bytes. These fixed measurements guard payload/output impact before benchmark use.

`--assignee`, `--project`, and `--milestone` filters expect Linear IDs; `--team` accepts team key. Repeat `--state` or `--label` to match multiple values. `issue create` currently sends title, description, team ID, and priority. `issue update` currently sends title, description, priority, and `--unassign`; use raw GraphQL for other issue fields.

Relation deletion currently requires issue, relation type, and relation ID arguments, but Linear deletion uses only relation ID. Run `issue relation list` first, copy exact relation ID, and do not assume first two arguments protect against deleting wrong relation.

Local helper requirements:

- Branch-based issue detection and `issue commits` require `git`.
- `issue pull-request` requires authenticated GitHub CLI (`gh`).
- `--web`/`--app` uses platform opener: `open`, `xdg-open`, or Windows `cmd`.

### Resource families

| Resource | Supported operations | Aliases |
| --- | --- | --- |
| Team | `list`, `create`, `delete`, `id`, `members`, `states`, `autolinks` (team identity only; autolink entries are not returned) | — |
| User | `list` | — |
| Project | `list`, `view`, `create`, `update`, `delete` | `view`: `v` |
| Project update | `list`, `create` | family: `pu`; `list`: `l`; `create`: `c` |
| Cycle | `list`, `view` | family: `cy`; `view`: `v` |
| Milestone | `list`, `view`, `create`, `update`, `delete` | family: `m`; `view`: `v` |
| Initiative | `list`, `view`, `create`, `update`, `archive`, `unarchive`, `delete`, `add-project`, `remove-project` | family: `init`; `list`: `ls`; `view`: `v` |
| Initiative update | `list`, `create` | family: `iu`; `list`: `l`; `create`: `c` |
| Label | `list`, `create`, `delete` | family: `l` |
| Document | `list`, `view`, `create`, `update`, `delete` | family: `document`, `docs`, or `doc`; operations: `l`, `v`, `c`, `u`, `d` |

Representative commands:

```sh
# Teams and users
magi-linear-axi team list
magi-linear-axi team members <team-id>
magi-linear-axi team states <team-id>
magi-linear-axi team create --name 'Platform'
magi-linear-axi user list --limit 100 --all

# Projects and project updates
magi-linear-axi project list --team <team-id> --all
magi-linear-axi project view <project-id> --fields compact
magi-linear-axi project create --name 'API Reliability' --team <team-id> --description 'Reliability work'
magi-linear-axi project update <project-id> --name 'API Resilience' --status <status-id> --target-date 2026-06-30
magi-linear-axi project-update list <project-id> --limit 20
magi-linear-axi project-update create --project <project-id> --body 'Shipped retry controls.' --health onTrack

# Cycles and milestones
magi-linear-axi cycle list <team-id>
magi-linear-axi cycle view <cycle-id>
magi-linear-axi milestone list --project <project-id>
magi-linear-axi milestone create --project <project-id> --name 'Public beta' --target-date 2026-06-30

# Initiatives and updates
magi-linear-axi initiative list --archived
magi-linear-axi initiative create --name 'Reliability' --owner <user-id> --target-date 2026-12-31
magi-linear-axi initiative add-project <initiative-id> --project <project-id>
magi-linear-axi initiative-update list <initiative-id> --limit 20
magi-linear-axi initiative-update create --issue <initiative-id> --body 'Program remains on track.' --health onTrack

# Labels
magi-linear-axi label list --team <team-id>
magi-linear-axi label create --team <team-id> --name 'customer-impact' --description 'Customer-visible issue'
```

Use Linear IDs for mutations and nested resource queries unless focused help explicitly accepts another selector. `--all` is supported only by `team list`, `user list`, `project list`, and `label list`; do not use it with other families. Default `--limit` is 50. Cycle, milestone, and initiative lists currently ignore `--limit` because their GraphQL documents are unpaginated.

### Documents

Document content accepts inline text, UTF-8 file content, or stdin:

```sh
magi-linear-axi document list --project <project-id>
magi-linear-axi document view <document-id> --full
magi-linear-axi document create --title 'Launch plan' --project <project-id> --content '# Launch plan'
magi-linear-axi document create --title 'Runbook' --project <project-id> --content-file ./runbook.md
cat notes.md | magi-linear-axi document create --title 'Notes' --project <project-id> --stdin
magi-linear-axi document update <document-id> --title 'Updated plan' --content-file ./launch.md
magi-linear-axi document delete <document-id>
```

## Raw GraphQL and schema

`api` accepts GraphQL from positional argument or stdin. Repeat `--variable key=value`; values parse as JSON when valid and otherwise remain strings. `--variables-json` accepts one JSON object. Individual `--variable` values override same-name entries from `--variables-json`.

```sh
magi-linear-axi api '{ viewer { id name email } }'

magi-linear-axi api \
  'query($first:Int!){ issues(first:$first){ nodes { identifier title } } }' \
  --variable first=20

magi-linear-axi api \
  'query($filter:IssueFilter){ issues(filter:$filter){ nodes { identifier title } } }' \
  --variables-json '{"filter":{"team":{"key":{"eq":"ENG"}}}}'

cat query.graphql | magi-linear-axi api --format json
magi-linear-axi schema --output linear-schema.json
```

`api --paginate` follows first recursively discovered object containing `nodes` and `pageInfo`, updates `after` with `pageInfo.endCursor`, and merges nodes. Query must accept `$after`; variables must form an object. Raw requests, including raw pagination, are never retried automatically. `api --silent` suppresses successful rendered output, useful only when caller relies on exit status.

Raw GraphQL preserves authentication, endpoint validation, response bounds, and structured errors, but it can execute arbitrary Linear mutations. Prefer modeled commands and inspect raw mutation documents before sending them.

## Agent integrations and completions

`setup` installs all targets when no target flag is supplied:

```sh
magi-linear-axi setup                     # Claude Code + Codex + OpenCode
magi-linear-axi setup --claude --codex    # selected targets only
magi-linear-axi setup --opencode
magi-linear-axi setup --path /tmp/test-home
```

Managed files:

| Target | Files and integration |
| --- | --- |
| Claude Code | `~/.claude/settings.json`, `hooks.SessionStart` |
| Codex | `~/.codex/config.toml`, `~/.codex/hooks.json`, `hooks.SessionStart` |
| OpenCode | `~/.config/opencode/plugins/magi-linear-axi.js`, `experimental.chat.system.transform` |

Setup is explicit, preserving, and idempotent. Each managed file is written atomically; installation across multiple files or targets is not transactional, so an error can leave earlier target updates applied. Setup stores resolved absolute executable path, removes duplicate managed hooks, repairs stale managed paths, and preserves unrelated valid configuration. Malformed target configuration fails before that file is replaced. `--path` changes home root used for generated files; it is primarily useful for isolated installs and tests. Setup does not contact Linear or store API key.

Installable on-demand Agent Skill lives at [`skills/magi-linear-axi/SKILL.md`](skills/magi-linear-axi/SKILL.md). Skill guidance and ambient session hooks are complementary: skill provides detailed operating procedure when invoked; setup provides compact session-start discovery.

Generate shell completions:

```sh
magi-linear-axi completions zsh > ~/.zfunc/_magi-linear-axi
magi-linear-axi completions bash > ~/.local/share/bash-completion/completions/magi-linear-axi
```

## Reliability, limits, and mutation safety

- Modeled read-only requests retry transient connection failures and HTTP `500`, `502`, `503`, and `504` up to three total attempts, with 50 ms then 100 ms backoff.
- Mutations, uploads, raw API calls, raw pagination, and HTTP-200 GraphQL errors never retry automatically.
- Successful response bodies are capped at 10 MiB. HTTP failure previews are sanitized and capped at 512 bytes.
- Uploads are capped at Linear's 100 MiB limit and read into memory before transfer. `--public` changes attachment upload visibility.
- Generic pagination follows first discovered GraphQL connection. Modeled `--all` is supported only for team, user, project, and label lists. Use `api --paginate` only with a compatible query.

For mutations:

1. Read target first and retain stable ID plus identifying fields.
2. Use explicit IDs; do not guess that names resolve to IDs.
3. Send one mutation and inspect returned `success` value.
4. Never blindly retry mutation after success or ambiguous transport failure.
5. Branch on exit status: fix syntax after exit `2`; inspect structured error after exit `1`.

Issue deletion example:

```sh
magi-linear-axi issue view ENG-123 --full
magi-linear-axi issue delete ENG-123
magi-linear-axi issue query --team ENG --search 'Exact retained title' --limit 50
```

`success:true` means Linear accepted delete request. Narrow query exclusion is eventual-consistency evidence, not transactional proof; stale reads and provider-controlled tombstones remain possible.

## Security boundaries

- API key comes only from non-empty `LINEAR_API_KEY`; it is never persisted or included in hooks.
- Configured token values are redacted from bounded transport-error previews.
- Endpoint validation rejects credentials sent over non-HTTPS remote URLs.
- Normal operations are non-interactive and do not invoke a shell. Optional Git, GitHub, and browser helpers launch fixed executables with argument arrays.
- Setup records current executable's absolute path instead of relying on mutable `PATH` resolution.
- Raw GraphQL has full authority granted to API key. Review query and variables before executing mutations.
- Repository is self-contained and never invokes `linear` or `linear-cli`.

## Development

CI and release gates use Rust 1.87.0 with committed lockfile:

```sh
cargo +1.87.0 fmt --check
cargo +1.87.0 check --locked
cargo +1.87.0 test --locked
cargo +1.87.0 clippy --all-targets --all-features --locked -- -D warnings
cargo +1.87.0 build --release --locked
cargo deny check advisories
```

Read-only AXI vs official Linear MCP benchmark harness: see [`benchmarks/linear/README.md`](https://github.com/magimetal/magi-linear-axi/tree/main/benchmarks/linear).

Integration tests use local TCP GraphQL mocks, temporary home directories, and fake credentials; they do not require developer Linear access. CI currently validates Ubuntu. Platform-specific URL opening has macOS, Linux, and Windows code paths.

Maintainer and project references:

- [Release checklist](docs/release.md)
- [Agent Skill](skills/magi-linear-axi/SKILL.md)
- [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [ISC license](LICENSE)
