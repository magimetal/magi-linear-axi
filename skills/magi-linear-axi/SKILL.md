---
name: magi-linear-axi
description: Use when an agent must read or change Linear issues, teams, users, projects, project updates, cycles, milestones, initiatives, labels, or documents; verify Linear authentication; run raw Linear GraphQL; inspect schema; or install AXI context integrations.
---

# magi-linear-axi

Use `magi-linear-axi` for non-interactive Linear operations. Never invoke `linear` or `linear-cli`.

## Operating contract

```sh
magi-linear-axi [--workspace <slug>] [--format toon|json] [--full] <family> <command> [args]
```

- Default stdout is compact TOON. Use `--format json` only when strict JSON parsing is needed.
- Success data and structured errors go to stdout. Diagnostics go to stderr.
- Exit `0` means success, `1` operational/API failure, `2` invalid usage.
- Commands never prompt. Supply required IDs, names, text, files, and workspace explicitly.
- `--full` disables normal long-string truncation.
- Global options may appear before or after subcommands.
- Prefer family commands below. Use `api` only when no family command covers operation.
- Run `magi-linear-axi <family> <command> --help` before unfamiliar mutations.

## Authentication and workspace

Set `LINEAR_API_KEY` in environment. Key must be non-empty for network commands. Never store or print it.

```sh
export LINEAR_API_KEY='lin_api_...'
magi-linear-axi auth whoami
magi-linear-axi --workspace acme auth whoami
```

Workspace precedence: `--workspace` > non-empty `LINEAR_WORKSPACE`; workspace required only for browser-opening commands.

## Issues

Issue argument accepts public identifier such as `ENG-123`. `issue id ENG-123` returns that human identifier, not Linear's internal UUID. While #21 remains open, resolve internal issue UUIDs through raw GraphQL. Issue create/update support is intentionally narrower than every advertised flag:

| Operation | Modeled support | Raw GraphQL required or limitation |
| --- | --- | --- |
| Create | `--team`, `--title`, `--description`, `--priority` | `--assignee`, `--state`, `--project`, `--label`, `--parent`, `--start`; accepted flags can be silently omitted |
| Update | `--title`, `--description`, `--priority`, `--unassign` | `--team`, `--assignee`, `--estimate`, `--state`, `--project`, `--milestone`, `--cycle`, `--clear-cycle`; unsupported-only update is rejected as `update requires at least one field` |
| Resolve public issue identifier | Existing issue references and `issue id` | — |
| Resolve internal issue UUID | — | Raw GraphQL until #21 is resolved |

Issue field support above is current in v0.2.1. `success:true` only proves Linear accepted mutation; it does not prove requested fields omitted from mutation response were applied. Advertised-field omissions are tracked in #5; internal UUID resolution is tracked in #21. Do not infer either issue is fixed.

```sh
# Read-only discovery for team, workflow-state, label, and parent-issue UUIDs
magi-linear-axi team list --all --format json
magi-linear-axi team states <team-uuid> --format json
magi-linear-axi label list --team <team-uuid> --all --format json
magi-linear-axi api 'query($id:String!){issue(id:$id){id identifier}}' --variable id=ENG-123 --format json
```

```sh
# One atomic issueCreate with explicit variables and response verification fields
magi-linear-axi api 'mutation IssueCreate($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier team{id key name} parent{id identifier} state{id name} labels{nodes{id name}}}}}' \
  --variables-json '{"input":{"teamId":"<team-uuid>","parentId":"<parent-uuid>","stateId":"<state-uuid>","labelIds":["<label-uuid>"],"title":"Child issue","description":"Acceptance criteria"}}' \
  --format json
```

For raw create, mandatory verification covers `id`, `identifier`, `team`, `parent`, `state`, and `labels`; never treat `success:true` alone as proof. Return every intended postcondition or immediately read back any omitted field. Default `issue view` cannot verify `parent` or `labels` because it does not select them, so use raw GraphQL for those read-backs.

For sibling batches:

1. Create one child.
2. Verify its team, parent, state, and labels.
3. Only then create remaining siblings.
4. Query parent `children`, count expected children, and verify dependency relations with `issue relation list`.

When issue argument is omitted, commands try public identifier from current Git branch.

```sh
# Discover and inspect with compact projections
magi-linear-axi issue list --team ENG --limit 25 --fields compact
magi-linear-axi issue query --search='authentication' --state 'In Progress' --label bug --fields compact
magi-linear-axi issue mine --state 'In Progress' --fields compact
magi-linear-axi issue view ENG-123 --fields compact
magi-linear-axi issue title ENG-123
magi-linear-axi issue describe ENG-123
magi-linear-axi issue url ENG-123
magi-linear-axi issue id ENG-123

# Create, update, and delete
magi-linear-axi issue create --team <team-id> --title 'Fix authentication' --description 'Observed behavior and acceptance criteria' --priority 2
magi-linear-axi issue update ENG-123 --title 'Revised title' --description 'Revised description' --priority 1
magi-linear-axi issue update ENG-123 --unassign
magi-linear-axi issue delete ENG-123
```

Delete safety: inspect target first and retain identifier, team, and exact title; run one delete mutation; then use a narrowly scoped `issue query --team <KEY> --search='<retained title>'` exclusion check. `success:true` means provider accepted request. Never retry delete after success or ambiguous transport failure. Query exclusion is eventual-consistency evidence, not transactional proof; absence from an unfiltered first page is not definitive. Direct reads may be stale, null, or HTTP error, and provider-controlled tombstone behavior cannot be guaranteed by local tests. Read retries: statuses 500/502/503/504 and no-status transient transport failures, at most 3 attempts with 50ms then 100ms backoff. Mutations, uploads, raw API calls (including `--paginate`), and HTTP-200 GraphQL errors do not retry. HTTP error detail is sanitized and previewed to first 512 bytes with `[truncated]` marker.

```sh
# Comments
magi-linear-axi issue comment list ENG-123 --fields compact --limit 20
magi-linear-axi issue comment add ENG-123 --body 'Investigation complete.'
magi-linear-axi issue comment update <comment-id> --body 'Corrected update.'
magi-linear-axi issue comment delete <comment-id>

# Links, files, and relations
magi-linear-axi issue link ENG-123 https://example.com/runbook --title 'Runbook'
magi-linear-axi issue attach ENG-123 ./evidence.png --title 'Failure screenshot'
magi-linear-axi issue relation list ENG-123 --fields compact --limit 20
magi-linear-axi issue relation add ENG-123 blocks ENG-456
magi-linear-axi issue relation delete ENG-123 blocks <relation-id>

# Local repository helpers
magi-linear-axi issue commits ENG-123
magi-linear-axi issue pull-request ENG-123
magi-linear-axi --workspace acme issue view ENG-123 --web
```

For filters, `--assignee` and project/milestone values currently expect Linear IDs; team accepts key. Repeat `--state` and `--label` for multiple values. Prefer `--search='<TEXT>'` so the complete search remains one argument, including text beginning with `-`.

For agent read workflows, prefer `--fields compact` for issue view/mine/list/query, comment list, relation list, and project view. Use default projections only when compact output omits a required field. `issue mine`, `issue list`, and `issue query` are bounded to 50 records by default and return `pageInfo`. Compact comment/relation reads are likewise bounded, default to 50, accept `--limit`, and preserve `pageInfo`. Use the smallest task-sufficient limit and inspect `pageInfo.hasNextPage` before treating results as complete. Compact relation output omits relation IDs, so use default relation list before deletion. Invalid or unsupported selectors exit `2` before authentication/network.

## Teams and users

```sh
magi-linear-axi team list
magi-linear-axi team id <team-id>
magi-linear-axi team members <team-id>
magi-linear-axi team states <team-id>
magi-linear-axi team autolinks <team-id>
magi-linear-axi team create --name 'Platform'
magi-linear-axi team delete <team-id>
magi-linear-axi user list --limit 100 --all
```

Use Linear UUIDs for team mutations and nested queries unless command explicitly accepts team key.

## Projects and project updates

```sh
magi-linear-axi project list --team <team-id> --limit 50
magi-linear-axi project list --all
magi-linear-axi project view <project-id> --fields compact
magi-linear-axi project create --name 'API Reliability' --team <team-id> --description 'Reliability work'
magi-linear-axi project update <project-id> --name 'API Resilience' --status <status-id> --target-date 2026-06-30
magi-linear-axi project delete <project-id>

magi-linear-axi project-update list <project-id> --limit 20
magi-linear-axi project-update create --project <project-id> --body 'Shipped retry controls.' --health onTrack
```

## Cycles and milestones

```sh
magi-linear-axi cycle list <team-id>
magi-linear-axi cycle view <cycle-id>

magi-linear-axi milestone list --project <project-id>
magi-linear-axi milestone view <milestone-id>
magi-linear-axi milestone create --project <project-id> --name 'Public beta' --description 'Beta exit criteria' --target-date 2026-06-30
magi-linear-axi milestone update <milestone-id> --name 'Public launch' --target-date 2026-07-15
magi-linear-axi milestone delete <milestone-id>
```

## Initiatives and initiative updates

```sh
magi-linear-axi initiative list
magi-linear-axi initiative list --archived
magi-linear-axi initiative view <initiative-id>
magi-linear-axi initiative create --name 'Reliability' --description 'Reduce customer-impacting failures' --owner <user-id> --target-date 2026-12-31
magi-linear-axi initiative update <initiative-id> --name 'Platform reliability' --health onTrack
magi-linear-axi initiative archive <initiative-id>
magi-linear-axi initiative unarchive <initiative-id>
magi-linear-axi initiative delete <initiative-id>
magi-linear-axi initiative add-project <initiative-id> --project <project-id>
magi-linear-axi initiative remove-project <initiative-project-link-id>

magi-linear-axi initiative-update list <initiative-id> --limit 20
magi-linear-axi initiative-update create --issue <initiative-id> --body 'Program remains on track.' --health onTrack
```

## Labels

```sh
magi-linear-axi label list --team <team-id>
magi-linear-axi label create --team <team-id> --name 'customer-impact' --description 'Customer-visible issue'
magi-linear-axi label delete <label-id>
```

## Documents

Document content can come from `--content`, `--body-file`/`--content-file`, or stdin.

```sh
magi-linear-axi document list --project <project-id> --limit 50
magi-linear-axi document view <document-id>
magi-linear-axi document create --title 'Launch plan' --project <project-id> --content '# Launch plan'
magi-linear-axi document create --title 'Runbook' --project <project-id> --content-file ./runbook.md
cat notes.md | magi-linear-axi document create --title 'Notes' --project <project-id> --stdin
magi-linear-axi document update <document-id> --title 'Updated launch plan' --content-file ./launch.md
magi-linear-axi document delete <document-id>
```

## Raw GraphQL and schema

Pass query as argument or stdin. `--variable key=value` parses JSON values when valid; otherwise value is string.

```sh
magi-linear-axi api '{ viewer { id name email } }'
magi-linear-axi api 'query($first:Int!){ issues(first:$first){ nodes { identifier title } } }' --variable first=20
magi-linear-axi api 'query($filter:IssueFilter){ issues(filter:$filter){ nodes { identifier title } } }' --variables-json '{"filter":{"team":{"key":{"eq":"ENG"}}}}'
cat query.graphql | magi-linear-axi api --paginate --format json
magi-linear-axi api 'mutation($id:String!){ issueDelete(id:$id){ success } }' --variable id=ENG-123 --silent
magi-linear-axi schema --output linear-schema.json
```

`--paginate` follows connection `pageInfo.endCursor`; use only for queries returning a paginated connection.

## Setup, completions, and discovery

```sh
# Install all Claude Code, Codex, and OpenCode context integrations
magi-linear-axi setup

# Install selected integrations
magi-linear-axi setup --claude --codex

# Shell completion
magi-linear-axi completions zsh > ~/.zfunc/_magi-linear-axi

# Discover exact current surface
magi-linear-axi --help
magi-linear-axi issue --help
magi-linear-axi issue create --help
magi-linear-axi project update --help
```

## Agent execution rules

1. Read before mutating: list/view target and retain returned IDs.
2. Use explicit IDs for mutations; do not guess names resolve to IDs.
3. Prefer one mutation per invocation and inspect `success` in output.
4. On exit `2`, fix syntax from `--help`; do not retry unchanged.
5. On exit `1`, inspect structured `error.type` and `error.message`; do not expose credentials.
6. Use `--format json` only when downstream tooling requires JSON. Otherwise retain TOON for token efficiency.
7. Keep final answers concise and fact-focused. Do not impose a canonical JSON answer schema unless the caller explicitly requests one.
