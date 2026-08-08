# CLI reference

## Contract

- No arguments prints compact home metadata and next commands; no auth or network required.
- Commands never prompt. Pass values through arguments, flags, files, stdin, or environment.
- Success data and application errors go stdout; diagnostics, including retries, go stderr.
- Default output is compact [TOON](https://toonformat.dev/). `--format json` applies to API-backed results and post-parse application errors.
- Strings truncate recursively after 240 Unicode code points; `--full` disables truncation.
- Exit `0`: success, empty result, or safe no-op. Exit `1`: auth, config, network, API, or output failure. Exit `2`: usage failure.
- Unknown commands and flags fail before auth or network. Global options work before or after subcommands.

```text
magi-linear-axi [--workspace <slug>] [--endpoint <url>]
                [--format toon|json] [--full] <command> [args]
```

Application errors have stable fields:

```json
{"error":{"type":"auth","code":1,"message":"LINEAR_API_KEY must be set and non-empty"}}
```

### Output exceptions

Parser-level failures happen before format resolution and emit structured TOON even with `--format json`. `issue identifier` and `team id` emit plain identifiers. Help, version, and completions emit text. `issue pull-request` lets `gh` print JSON before rendering its Linear result. Do not send these exceptional outputs directly to a strict JSON parser.

## Authentication and configuration

| Variable | Purpose |
| --- | --- |
| `LINEAR_API_KEY` | Required, non-empty key for network commands; never read from TOML, stored, printed, or placed in hooks |
| `LINEAR_API_URL` | Optional GraphQL endpoint override |
| `LINEAR_WORKSPACE` | Workspace slug for `--web` and `--app` when `--workspace` is absent |

Project configuration uses `./.linear.toml`. Global configuration uses `$XDG_CONFIG_HOME/linear/linear.toml`, otherwise `~/.config/linear/linear.toml` on macOS/Linux or `%APPDATA%\\linear\\linear.toml` on Windows. Only `endpoint` is read:

```toml
endpoint = "https://api.linear.app/graphql"
```

Endpoint precedence: `--endpoint` → non-empty `LINEAR_API_URL` → project file → global file → Linear production endpoint. Existing malformed files fail with their path. Workspace precedence is `--workspace` → non-empty `LINEAR_WORKSPACE`. Remote endpoints require HTTPS; HTTP is accepted only for loopback hosts and is intended for local tests.

## Issues

Human references look like `ENG-123`. On current `main` (unreleased after v0.2.1), `issue id ENG-123` performs one read-only lookup and returns internal UUID plus human identifier; `issue identifier` only normalizes a human identifier locally. Omitted issue references may derive from current Git branch.

| Job | Commands |
| --- | --- |
| Discover | `issue mine`, `issue list`, `issue query` |
| Inspect | `issue view`, `title`, `describe`, `url`, `id`, `identifier` |
| Mutate | `issue create`, `update`, `start`, `delete` |
| Comments | `issue comment list`, `add`, `update`, `delete` |
| Links and files | `issue link`, `attach` |
| Relations | `issue relation list`, `add`, `delete` |
| Agent sessions | `issue agent-session list`, `view` |
| Repository helpers | `issue commits`, `pull-request` |

```sh
TEAM_KEY='ENG'
magi-linear-axi issue list --team "$TEAM_KEY" --limit 10 --fields compact
magi-linear-axi issue query --team "$TEAM_KEY" --search 'authentication' --fields compact
magi-linear-axi issue view ENG-123 --fields compact
magi-linear-axi issue comment list ENG-123 --fields compact --limit 20
magi-linear-axi issue relation list ENG-123 --fields compact --limit 20
```

`--fields compact` works on issue view/mine/list/query, comment list, relation list, and project view. Compact connections retain `pageInfo`; compact comment and relation lists default to 50 records. Compact relation output omits relation IDs, so use default `issue relation list` before deletion.

Filters `--assignee`, `--project`, and `--milestone` require Linear IDs; `--team` accepts a team key. Repeat `--state` and `--label` to match multiple values.

### Modeled issue mutation limits

| Operation | Sent by modeled command | Accepted but not sent |
| --- | --- | --- |
| Create | `--team`, `--title`, `--description`, `--priority` | `--assignee`, `--state`, `--project`, `--label`, `--parent`, `--start` |
| Update | `--title`, `--description`, `--priority`, `--unassign` | `--team`, `--assignee`, `--estimate`, `--state`, `--project`, `--milestone`, `--cycle`, `--clear-cycle` |

Create flags in accepted-but-not-sent column are silently omitted. Update silently omits unsupported flags when a supported field is also present; unsupported-only update fails before network. `issue comment add` currently sends only issue and `--body`; accepted `--parent`, `--attach`, and `--public` values are not sent. `issue attach --comment` is also accepted but not sent. Use raw GraphQL for these fields.

`success:true` means Linear accepted mutation, not that omitted postconditions applied. Verification is mandatory. Default `issue view` cannot verify `parent` or `labels` because it does not select them; return every intended field from raw mutation or immediately read it back.

```sh
magi-linear-axi issue id ENG-123 --format json
magi-linear-axi api 'mutation IssueCreate($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier team{id key name} parent{id identifier} state{id name} labels{nodes{id name}}}}}' \
  --variables-json '{"input":{"teamId":"<team-uuid>","parentId":"<parent-uuid>","stateId":"<state-uuid>","labelIds":["<label-uuid>"],"title":"Child issue","description":"Acceptance criteria"}}' \
  --format json
```

For multiple siblings, create and verify first child before remaining mutations. Finally query parent `children`, count expected children, and verify dependency relations with `issue relation list`.

Relation deletion ultimately sends only relation ID, even though command accepts issue and relation type too. List relations, copy exact ID, and do not assume other arguments protect against deleting wrong relation.

## Resource families

| Resource | Operations | Aliases |
| --- | --- | --- |
| Team | list, create, delete, id, members, states, autolinks (team identity only; entries are not returned) | — |
| User | list | — |
| Project | list, view, create, update, delete | `view`: `v` |
| Project update | list, create | family: `pu` |
| Cycle | list, view | family: `cy` |
| Milestone | list, view, create, update, delete | family: `m` |
| Initiative | list, view, create, update, archive, unarchive, delete, add-project, remove-project | family: `init` |
| Initiative update | list, create | family: `iu` |
| Label | list, create, delete | family: `l` |
| Document | list, view, create, update, delete | `document`, `docs`, `doc` |

Use Linear IDs for mutations and nested resource queries unless focused help accepts another selector. `--all` applies only to team, user, project, and label lists. Default `--limit` is 50. Cycle, milestone, and initiative lists are currently unpaginated and ignore `--limit`.

Documents accept inline UTF-8 content, files, or stdin:

```sh
PROJECT_ID='replace-with-linear-project-id'
magi-linear-axi document list --project "$PROJECT_ID"
magi-linear-axi document create --title 'Runbook' --project "$PROJECT_ID" --content-file ./runbook.md
cat notes.md | magi-linear-axi document create --title 'Notes' --project "$PROJECT_ID" --stdin
```

Branch detection and `issue commits` require `git`; `issue pull-request` requires authenticated `gh`; `--web`/`--app` requires a workspace and platform URL opener.

## Raw GraphQL and schema

`api` accepts GraphQL as positional input or stdin. Repeat `--variable key=value`; valid JSON values parse as JSON, otherwise remain strings. `--variables-json` accepts one JSON object; individual variables override duplicate names.

```sh
magi-linear-axi api '{ viewer { id name email } }'
magi-linear-axi api 'query($first:Int!){issues(first:$first){nodes{identifier title}}}' --variable first=20
cat query.graphql | magi-linear-axi api --format json
magi-linear-axi schema --output linear-schema.json
```

`api --paginate` follows the first recursively discovered object containing `nodes` and `pageInfo`, updates `after`, and merges nodes. Query must accept `$after`; variables must be an object. Raw requests and raw pagination never retry automatically. `api --silent` suppresses successful output. Raw GraphQL can execute every mutation allowed by key; inspect documents and variables before sending them.

## Agent setup and completions

`setup` installs all targets by default; target flags limit changes:

```sh
magi-linear-axi setup --claude
magi-linear-axi setup --codex --opencode
```

| Target | Managed files |
| --- | --- |
| Claude Code | `~/.claude/settings.json` session-start hook |
| Codex | `~/.codex/config.toml`, `~/.codex/hooks.json` session-start hook |
| OpenCode | `~/.config/opencode/plugins/magi-linear-axi.js` system-transform plugin |

Setup preserves unrelated valid configuration, writes each file atomically, stores resolved absolute executable path, repairs duplicate/stale managed entries, never contacts Linear, and never stores key. Multi-file/multi-target installation is not transactional; earlier writes can remain after a later failure. `--path` selects alternate home root.

```sh
magi-linear-axi completions zsh > ~/.zfunc/_magi-linear-axi
magi-linear-axi completions bash > ~/.local/share/bash-completion/completions/magi-linear-axi
```

See [Agent Skill](../skills/magi-linear-axi/SKILL.md) for detailed agent operating guidance.
