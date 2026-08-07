# Linear read-only benchmark harness

This package compares `magi-linear-axi` with the official Linear MCP on small, read-only agent tasks. It is deliberately isolated from the Rust package and uses Node **22.12 or newer**, npm, TypeScript, `tsx`, and Vitest.

The harness follows the seeded matrix, raw-trajectory, and report ideas from the upstream `bench-github` methodology and from [AXI](https://axi.md/), but the implementation here is purpose-built for Linear and does not copy upstream source. The benchmark is an audit harness, not a claim that either integration is mutation-proof.

## Safety contract

A command that contacts Linear or starts an agent with Linear access is a **live command**. It will not run unless all three conditions hold:

1. `LINEAR_API_KEY` is present;
2. the command includes the explicit `--confirm-read-only` flag; and
3. `LINEAR_BENCHMARK_READ_ONLY=1` is set.

The key itself **must have Linear Read permission only**. Create or select a least-privilege read-only credential according to your Linear administration policy. The harness never attempts a mutation to test the key's scope; mutation would violate the benchmark's safety contract.

The layers are:

- Snapshot queries go directly to the exact `https://api.linear.app/graphql` endpoint and are rejected locally unless every GraphQL operation is a query. Snapshot preparation is outside measured agent time.
- The `axi` condition exposes only Claude Code's `Bash` tool and a mode-0700, key-free per-case wrapper. The wrapper sends only argv over a private Unix-domain socket to a runner-owned broker. The broker validates the bounded read-only guide before spawning the resolved `magi-linear-axi` binary with `shell:false`; it alone holds the API key, pinned endpoint, private XDG directory, and disposable workspace cwd. The actual binary path is fingerprinted but is not exposed as Claude's callable path. The default binary is `target/release/magi-linear-axi` when present; `MAGI_LINEAR_AXI_BIN` can override it. Every benchmark process receives `LINEAR_API_URL=https://api.linear.app/graphql`, overriding any inherited value. An explicit AXI `--endpoint VALUE` or `--endpoint=VALUE` flag is always rejected before credential injection, including when it names the official endpoint.
- Each case runs in a disposable empty workspace with a private `XDG_CONFIG_HOME` below that workspace, so AXI cannot read an operator's global Linear config. `HOME` remains available for Claude authentication, but it is not used as the AXI config directory.
- The `mcp` condition uses Claude Code's strict MCP configuration with only `https://mcp.linear.app/mcp/readonly`. It disables Bash and allows only the configured Linear MCP namespace.
- The MCP config contains the literal `${LINEAR_API_KEY}` interpolation, never the key value. It is written to a mode-0600 temporary file and removed after the process.
- The trajectory audit separates hard safety from local policy incidents. Hard safety includes wrong tools/namespaces, a non-wrapper executable, endpoint overrides, raw GraphQL mutations, write-shaped AXI/MCP operations, local-mutating setup/config/auth/schema-output operations, and execution-capable shell composition. Pipelines, chaining, command separators, substitutions, line continuations, parentheses, ampersands, and simple redirection such as `2>&1`, `>file`, or `<file` are hard compliance/correctness failures, even when a broker would reject the resulting argv. Malformed or empty Bash input and unrecognized AXI reads remain policy findings. AXI calls must use the exact per-case wrapper path; documented reads are permitted. The audit is an additional layer, while the broker, pinned endpoint, and read-only credential remain the credential/mutation boundary.

The endpoint and the credential scope are the hard boundary. The scanner is an additional audit layer and cannot prove that a remote service or model would never mutate outside the observed trajectory.

## Install and build

From this directory:

```sh
npm install
npm run build
npm test
```

`npm test` uses only fake fixtures and does not contact Linear, Claude Code, or the MCP endpoint. The committed `package-lock.json` is required for repeatable installs.

## Snapshot and task generation

Snapshot once before a benchmark. This is a live read-only command and requires the full safety contract:

```sh
export LINEAR_API_KEY='read-only-key-placeholder'
export LINEAR_BENCHMARK_READ_ONLY=1
npm run snapshot -- --confirm-read-only
```

### Answer-contract experiment

Answer contract is orthogonal to interface condition. `compact` preserves existing condition-neutral prose/fact guidance. `canonical` uses this exact grammar in both AXI and MCP prompts:

- one minified JSON object for one record;
- one minified JSON array for multiple ordered records;
- task-specific keys in exact specified order;
- string values only, with literal Unicode and normal JSON escaping for quotes, backslashes, control characters, and multiline values;
- no whitespace outside string values, preamble, prose, fences, counts, conclusions, missing fields, or extra fields; and
- `{"error":"issue ENG-404 not found"}` for an invalid `ENG-404` lookup.

Examples are `{"identifier":"ENG-10","title":"Improve query latency"}`, `{"name":"Project","status":""}` when a returned field is explicitly empty, and `[{"identifier":"ENG-10","title":"First"},{"identifier":"ENG-11","title":"Second"}]`. Generated schemas map keys to existing required-fact labels; required facts, provenance, linked operation evidence, minimum tool calls, and safety grading do not change. Empty values require explicit named empty-field tool evidence. Model output is measured and persisted byte-for-byte after secret redaction: harness does not post-process, truncate, rewrite, or convert answers. This experiment does not change production CLI output.

Issue #16 phase attribution is still unavailable. Experiment remains justified because valid baseline cohort showed AXI provider output at 269.58 versus 184.96 tokens/run (+45.8%) even after linked tool-result volume fell about 63.1%. Terminal Unicode-character and UTF-8-byte metrics are exact answer-size proxies, not phase-specific token attribution; provider output tokens are reported only with explicit coverage.

`matrix` and `preflight` default to both contracts. `run` requires exactly one `--answer-contract compact|canonical`; `report` accepts `compact`, `canonical`, or `all`. Cohorts require every condition × contract × task × repeat cell under same snapshot, task manifest, model, seed, repeat count, judge settings, harness fingerprint, Claude version, and AXI binary. Canonical preflight additionally requires full deterministic pass; compact retains primitive-reachability semantics.

Adoption status is `adopt` only when complete AXI compact/canonical task-repeat pairs show 100% canonical deterministic pass and fact grounding, complete judge coverage without agreement loss, at least 15% lower terminal characters or covered provider output tokens, no turn/tool-call increase, and no safety, policy, command, API, tool, or infrastructure incident increase. Missing pair, judge, or both size-coverage paths yield `not_evaluable`; complete evidence that misses any gate yields `retain`. Negative results remain publishable aggregate evidence and retain compact as default.

All generated tasks across `single_step`, `multi_step`, `investigation`, and `error_recovery` continue to share one condition-neutral compact final-answer contract. Invalid-issue tasks retain explicit issue-scoped not-found wording. Reports include deterministic/judge agreement, provider output tokens with covered-run counts, terminal Unicode characters/UTF-8 bytes with coverage, turns, tool calls, incidents, and adoption decision in Markdown and CSV. Model final answers remain intact through parsing and result persistence; secret redaction remains applied.

Snapshot preparation captures only bounded, useful facts: viewer ID, team IDs/keys/names, issue identifiers/titles/URLs/state, selected readable comment IDs/bodies, issue relation types/identifiers/titles, and project IDs/names/URLs/status. Issue descriptions and project bodies are not captured. A workspace needs at least one readable team and issue. Projects, comments, relations, and a second issue are optional; the generator substitutes an interface-common search→view task or records an explicit warning when they are unavailable. Shared task prompts describe intent only: an exact-title issue search and, where required, a later direct retrieval. Concrete AXI command syntax appears only in the AXI condition guide; MCP guidance names typed read tools. Every issue-facing task uses the public human `issue.identifier` (for example `ENG-10`) rather than an internal UUID; project lookup intentionally keeps the project UUID because the AXI project read accepts it. The invalid-identifier task remains intentionally invalid.

AXI condition prompts use one per-case broker path, a compact grammar for five permitted task reads, and one consolidated safety rule. `--help` remains broker-valid for diagnostics but is not prompt guidance or a graded operation. After adding the shared compact final-answer contract, regression metadata records the combined fixture prompt at 1,173 characters (approximately 294 tokens using a four-characters-per-token heuristic); the AXI safety grammar still names the wrapper path once.

The current snapshot and task manifest are written under `snapshots/latest.json` and `generated/latest.json`; timestamped copies are retained. These paths are gitignored. The generated pilot is normally eight tasks spanning `single_step`, `multi_step`, `investigation`, and `error_recovery`. Snapshot capture is bounded to at most 25 teams, 25 issues, and 25 projects. Only the first 10 issues receive staged comment/relation detail; each detail request retains at most 10 comments and 10 relations per direction and retains only task-used fields. The viewer retains only its ID; projects retain only ID, name, URL, and status name. It includes exact issue lookup, title/search retrieval, optional comments and project lookup, comparison, relation traversal, interface-common sparse replacements, and an invalid identifier belonging to an existing team.

The snapshot records `searchIssueIdentifier` only after a bounded, query-only workspace probe for each candidate in snapshot order. Each probe uses Linear's actual `title.containsIgnoreCase` substring filter with `first: 2` and requests `pageInfo`; a candidate is accepted only when exactly one matching issue is returned, `hasNextPage` is explicitly false, and the returned issue is that candidate. Candidates whose required identifier or title exceeds AXI's 240-Unicode-code-point default output limit are skipped rather than sliced. Task generation uses that recorded identifier and fails clearly when it is missing, stale, locally ambiguous, or not representable. The snapshot also persists the required `confirmedAbsentIssueIdentifier`: up to 10 deterministic query-only probes filter by the first existing team's key and candidate issue number. Only an explicitly empty connection with `hasNextPage: false` confirms absence; a returned issue is a collision and advances to the next candidate. Request, authentication, transport, malformed-response, and incomplete-page errors fail snapshot capture. Old snapshots without this field are rejected.

The same 240-code-point representability rule applies to every generated exact fact, operation operand, and operation result value. Core issue, project, comment, and relation values must be representable; optional state, URL, status, and related-title values are omitted when they are not. No oversized value is sliced into a fake fact. The comment task is generated only when it can select a nonempty body of at most 240 Unicode code points, matching AXI's default rendering limit; a longer body is never sliced into a purported exact fact. If no comment meets that rule, generation uses the issue-URL replacement and records an explicit warning. The comment task grades only the selected comment ID/body; the base issue identifier is call input, not an answer fact. When an optional project, second issue, or relation is missing or unrepresentable, its distinct grounded replacement requires an exact-title search followed later by a direct retrieval, with deterministic grading requiring the search→view operation order and taking identifier/title/state/URL facts only from the retrieval result. The relation task is an investigation/read task with one minimum tool call and no mandated second related-issue lookup. `compare-issues` and sparse search→view replacements are true two-call multi-step tasks. No task relies on a mutable global count or a “most recent” claim.

Inspect task IDs without network access:

```sh
npm run list
```

Useful path overrides for isolated runs are `--snapshot-file`, `--tasks-file`, and `--results-dir`.

## Run a pilot, matrix, and report

Run one condition/task. The command appends a result and never clears unrelated results:

```sh
npm run run -- \
  --confirm-read-only \
  --condition axi \
  --answer-contract compact \
  --task issue-lookup \
  --no-judge
```

The MCP equivalent is:

```sh
npm run run -- \
  --confirm-read-only \
  --condition mcp \
  --answer-contract canonical \
  --task issue-lookup \
  --no-judge
```

`--no-judge` is useful for local development. Without it, a second standard Claude Code invocation uses the configured model as an LLM judge and receives only bounded/redacted tool names, linked result evidence snippets, the task's dynamic grading facts, the redacted final answer, and deterministic checks. The AXI prompt states the per-case wrapper once and expresses its bounded parity guide as a compact grammar containing only `issue view`, `issue query --search=<TEXT>`, `issue comment list`, `issue relation list`, and `project view`; the equals form keeps a title beginning with `-` in one unambiguous argv value. It requires one exact wrapper invocation per Bash call and forbids shell composition and writes; the MCP prompt remains limited to typed read-only tools. Judges run whenever hard safety is zero, including policy incidents. Run, matrix, and preflight commands reject snapshots older than 30 minutes by default; use the explicit `--max-snapshot-age-minutes <n>` option to choose another positive limit. A long full matrix can outlive that age after its start-time check.

## Timing and reports

`wallTimeMs` keeps its existing comparable boundary: start immediately before per-case broker/config setup, stop after Claude execution/stream parsing and ephemeral MCP-config cleanup, and exclude judge execution, judge artifact writes, result persistence, and final workspace cleanup. Component intervals overlap and are diagnostics, not additive decomposition.

| Field | Included interval | Excluded interval |
| --- | --- | --- |
| `claudeReportedDurationMs` | Claude result event's provider-reported `duration_ms` | Local process spawn, broker setup, post-process parsing |
| `claudeProcessLifetimeMs` | Local Claude spawn attempt through child close/timeout settlement | Broker/config setup before spawn; stream parsing after close |
| `brokerSetupMs` | Per-case temp directory, wrapper/socket creation, listen, and permission setup | Any wrapper request or AXI child execution |
| `wrapperRoundTripMs` | Broker-observed socket connection acceptance through validated response dispatch, summed across wrapper calls | Wrapper process startup before connect and final stdout/stderr writes after dispatch |
| `axiChildLifetimeMs` | AXI spawn attempt through child close, summed across started children | Wrapper-only setup and Claude work outside AXI calls |
| `graphqlAttemptMs` | Each Rust HTTP attempt from request construction through bounded body read and JSON decoding | Retry backoff, config load, rendering |
| `renderMs` | Rust truncation, serialization, and stdout write | GraphQL/config work |
| `streamParseMs` | Local parse of captured Claude JSONL after process settlement | Claude execution and stream delivery |
| `retries` | Additional GraphQL attempts selected after retryable read failures | Initial attempts; retry delay remains visible only in enclosing AXI/Claude/wall intervals |
| `orchestrationOutsidePrimaryMs` | Measured runner time before result construction minus primary wall time and optional judge time | Result append and final cleanup, which occur after this diagnostic is captured |

Each timing metric stores numeric `totalMs` and event `count`; coverage lists dimensions actually observed, including valid zero-duration samples. Missing dimensions remain uncovered and do not become zero. Means divide by covered runs only. Fixed-label timing JSONL lives only below disposable per-case workspace, contains component names and non-negative integer milliseconds, and is deleted with workspace cleanup. Persisted component metadata contains numbers/coverage only. Markdown/CSV reports aggregate every component plus coverage and retry totals; they never include prompts, answers, tool-result text, workspace facts, endpoints, or credentials. Safety boundaries remain per-case: no persistent worker, shared socket, or expanded credential lifetime is introduced.

A small seeded judged pilot across all task categories, both conditions, and both contracts:

```sh
npm run matrix -- \
  --confirm-read-only \
  --category single_step,multi_step,investigation,error_recovery \
  --repeat 1 \
  --seed linear-pilot-1
```

Generate pilot report and require 100% canonical deterministic pass/grounding plus no judge-agreement or incident regression before repeated cohort. `--no-judge` remains available only for local harness development, not adoption evidence.

A fuller repeated judged matrix:

```sh
npm run matrix -- \
  --confirm-read-only \
  --repeat 3 \
  --seed linear-full-1
```

Matrix cases are scheduled as task×repeat blocks, shuffled by recorded seed, with all condition×answer-contract cells randomized but adjacent inside each block. Four default cells (`axi/compact`, `axi/canonical`, `mcp/compact`, `mcp/canonical`) remain paired; adjacency reduces but cannot eliminate live model/service drift. Repeating same seed and filters produces same schedule. One run or matrix invocation gets one `matrixRunId`; pass `--run-id` to set it explicitly. Results append to `results/results.jsonl`; file stores redacted final answers plus judge rationale/status and remains workspace-sensitive, like raw and snapshot artifacts. Raw redacted Claude stream JSONL lives in `results/raw/`. Existing results are never removed; reports remain aggregate-only shareable outputs.

Before full matrix, use guarded preflight. It uses same read-only contract, fresh snapshot/task inputs, AXI broker, selected filters, and one no-judge repeat per task/condition/contract, then prints only new `matrixRunId` and aggregate incident counts. Both contracts fail for hard safety, true infrastructure failure, missing condition-appropriate tool use, failed operation semantics/results, or facts without grounded linked evidence. Canonical cells must also pass exact format and every deterministic fact assertion; compact cells intentionally retain primitive-reachability semantics.

```sh
npm run preflight -- \
  --confirm-read-only \
  --condition axi,mcp \
  --seed linear-preflight-1
```

Generate aggregate Markdown and CSV reports at any time, without network access. By default, a report selects the latest `matrixRunId` instead of mixing append-only runs; use `--run-id <id>` to select a cohort explicitly:

```sh
npm run report
# Optional filters:
npm run report -- --condition axi --category investigation
npm run report -- --answer-contract canonical
```

A report first selects complete latest cohort, or cohort named by `--run-id`, and validates it before applying `--task`, `--category`, `--condition`, or `--answer-contract` display filters. Validation requires one matrix run ID, invariant model/seed/snapshot/task-manifest/judge/harness source/Claude fingerprint metadata, an AXI binary hash whenever AXI is present, matching expected conditions/contracts/task IDs, expected repeat count and judge intent, exactly one result per condition/contract/task/repeat cell, and every expected cell. Reusing an ID for mixed or interrupted run fails clearly instead of producing partial evidence. A single-condition, single-contract `run` remains valid because expected sets contain only selected values. Adoption is assessed from complete validated cohort before display filtering. `writeReports` never silently switches cohorts.

Report rows group by condition+contract and task+condition+contract. They include per-run means for input tokens, provider output tokens only across covered rows, terminal answer Unicode characters and UTF-8 bytes only across observed terminal results, provider cost, **agent wall time**, turns, and tool calls; p50/p95 duration/tool calls; pass, grounding/judge agreement; incidents; and component timing totals/counts/coverage/covered means. Missing output-token, answer-size, cost, or timing measurements stay `n/a`/uncovered, never synthetic zero. Markdown and CSV include adoption status, reasons, reductions, and metric coverage without prompts, answers, tool-result text, workspace facts, endpoints, or credentials.

## Backend details

The measured backend is Claude Code's `stream-json` output. The parser handles assistant text, streaming text deltas, result usage/cost fields, Bash tool uses, MCP tool uses, tool errors, and terminal result status. Exactly one result event with subtype exactly `success` is required; a missing subtype, non-success subtype, duplicate result event, or missing terminal event is a true infrastructure failure for deterministic grading and for the judge. Linked tool-result errors are bounded and classified as expected not-found, command/usage/exit-2, API/auth/config/transport/exit-1, or other tool errors. Expected not-found grading requires explicit issue-scoped language such as `issue ... not found`, `issue ... does not exist`, `no such issue`, or `entity not found: issue`; bare HTTP 404, permission absence, and generic cannot/unable-to-find wording do not qualify. Ordinary linked tool errors are not infrastructure by themselves. A result cannot pass deterministic grading without actual condition-appropriate tool use: an unsupported final-answer guess is a failure even if it contains every expected string.

For operation-constrained tasks, deterministic grading classifies broker-approved AXI argv and typed MCP issue-list/search and issue-get inputs into `issue_search` and `issue_view`. Each required operation records its Claude `toolUseId` and extracted search text or human issue identifier. Requirements carry an exact operand (trim only, case-sensitive) plus values that must appear in one linked, non-error result. A search therefore proves the exact full title produced the expected identifier and title; a following view must use that same expected identifier and return its required view facts. Only the intentional invalid-issue view may instead require a linked issue-scoped not-found error. The exact sequence/count still rejects extra searches, help calls, duplicate calls, or reversed/missing steps, and facts remain scoped to successful linked evidence from their declared operation source. Thus a direct-retrieval fact cannot be rescued by search output when retrieval errors, and safety findings remain separate hard failures rather than being converted into provenance or tool errors.

- **AXI:** `--tools Bash` with a command-scoped `Bash(<per-case-wrapper-path>:*)` permission plus an ephemeral empty strict MCP config; the prompt names only the key-free wrapper. The broker validates issue view/query/comment-list/relation-list, project view, auth whoami, and bounded help/version forms before injecting credentials. `project view` is already a finite scalar/nested-object read with no unbounded connection, so no extra command is needed. Each case runs from a disposable empty temporary workspace, and Claude's process environment is a minimal allowlist with no `LINEAR_API_KEY`. `MAGI_LINEAR_AXI_BIN` is never placed in the MCP config.
- **MCP:** `--strict-mcp-config --mcp-config <temporary-file> --tools "" --allowedTools mcp__linear__* --disallowedTools Bash`; the only server in the file is the exact Linear read-only HTTP endpoint. The judge has an empty tool set and no Linear key.
- **Environment:** Claude receives only PATH/HOME/user/shell/temp/XDG, locale/terminal, proxy/certificate, and Anthropic/Claude auth variables. Benchmark cases force `LINEAR_API_URL=https://api.linear.app/graphql` and set `XDG_CONFIG_HOME` to a private directory under the disposable workspace. `LINEAR_API_KEY` is passed only to MCP; for AXI it is held exclusively by the broker child environment. OpenAI, GitHub, and other unrelated credentials are dropped.
- **Model:** `claude-sonnet-4-6` by default; use `--model` and `--judge-model` to override.
- **Claude executable:** `claude` by default; use `--claude-bin` for a pinned installation.

No API key is printed by the harness. Agent stdout, stderr-derived errors, final answers, and judge output are redacted before artifact persistence. Raw artifacts can still contain sensitive workspace facts, so keep the gitignored directories private and delete them according to your retention policy.

## Threat model and limitations

This harness protects against accidental benchmark mutations and accidental credential persistence by combining environment/flag gating, query-only snapshot guards, strict tool configuration, endpoint selection, trajectory scanning, redaction, and deterministic grading. It does **not**:

- prove that the Linear account has the intended scope without attempting a prohibited mutation;
- prove that the official endpoint or an agent is mutation-proof beyond the configured endpoint and observed trajectory;
- protect a user who deliberately bypasses the harness, changes the endpoint, changes the key, or runs an untracked tool;
- make network access safe if the key has write permission; the operator must supply a read-only key;
- make a bounded snapshot complete for a large workspace; snapshot warns when limits or optional facts are reached;
- guarantee comparable provider cost numbers when Claude Code omits or changes usage fields; or
- remove all workspace sensitivity from gitignored snapshot, generated tasks, `results/results.jsonl`, raw JSONL, or judge artifacts.

Snapshot time is excluded from measured agent wall time. Judge time is excluded from primary agent wall time and recorded separately when a judge runs. Benchmark compares conditions against same generated facts, but live Linear data can change between snapshots and runs. Use same stable workspace and fresh snapshot. Adjacent pairing reduces but cannot eliminate drift; keep snapshot hash, model, seed, filters, repeat count, source hash, AXI binary hash, Claude version, and judge settings invariant. Reports validate full expected cohort before display filtering, so never reuse a `matrixRunId` across separate or partial invocations. Old cohorts lacking answer-contract cells or invariant fingerprints remain invalid rather than merged. Compact preflight proves primitive reachability; canonical preflight additionally proves exact deterministic answer quality, but neither substitutes for judged pilot and repeated cohort.

## Source links and attribution

- [AXI methodology and contract](https://axi.md/)
- [Linear MCP documentation](https://linear.app/docs/mcp)
- [Linear GraphQL API](https://developers.linear.app/docs/graphql/working-with-the-graphql-api)

Methodology inspiration: upstream `bench-github` artifacts and AXI's benchmark guidance. This package is an independent implementation tailored to read-only Linear operations.
