# magi-linear-axi

Agent-native Rust CLI for direct, non-interactive Linear GraphQL operations. Modeled commands cover issues, teams, users, projects, cycles, milestones, initiatives, labels, documents, comments, relations, and updates; raw GraphQL remains available when needed.

[![Crates.io](https://img.shields.io/crates/v/magi-linear-axi.svg)](https://crates.io/crates/magi-linear-axi) [![docs.rs](https://docs.rs/magi-linear-axi/badge.svg)](https://docs.rs/magi-linear-axi) [![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE)

## CLI or MCP?

| Choose `magi-linear-axi` | Choose official Linear MCP |
| --- | --- |
| Agent can execute shell commands and needs explicit, auditable argv | Client is MCP-native and managed MCP setup matters more |
| Compact TOON, stable exit codes, bounded reads, raw GraphQL, and schema export | Official integration and lower measured latency matter more |
| Published cohort used 38.9% fewer reported tokens and cost 17.0% less | AXI used 14.2% more agent wall time than official MCP in same cohort |

Neither interface is universally best. [Benchmark scope and caveats](docs/benchmark.md).

## Quick start

Requires Rust 1.87+, Cargo, network access, and a [Linear personal API key](https://linear.app/settings/api). Key stays environment-only.

```sh
cargo install magi-linear-axi --locked
export LINEAR_API_KEY='lin_api_your_key'
magi-linear-axi auth whoami
magi-linear-axi team list
```

`--format json` means compact JSON for API-backed results and post-parse application errors; parser-level failures and documented plain-text commands remain outside strict JSON. Default output is compact [TOON](https://toonformat.dev/). Strings truncate after 240 Unicode code points; `--full` disables truncation.

## Common reads

```sh
magi-linear-axi issue mine --fields compact
magi-linear-axi issue query --team ENG --search authentication --fields compact
magi-linear-axi issue view ENG-123 --fields compact
magi-linear-axi project view PROJECT_ID --fields compact
magi-linear-axi api '{ viewer { id name email } }'
```

Use `--format json` for downstream JSON consumers. Run `magi-linear-axi --help` or focused command help before unfamiliar operations.

## Output and safety essentials

- No prompts. Inputs come from args, flags, files, stdin, or environment.
- Success data and application errors go stdout; diagnostics go stderr.
- Exit `0` means success/empty/safe no-op; `1` operational failure; `2` usage failure.
- Read-only modeled requests retry transient failures and HTTP 500/502/503/504 up to three total attempts. Mutations, uploads, raw API, raw pagination, and GraphQL errors never retry.
- API key must be non-empty `LINEAR_API_KEY`; never stored, printed, or placed in hooks.
- Raw GraphQL can mutate anything key permits. Review query, variables, returned `success`, and postconditions. Never blindly retry ambiguous mutations.
- Modeled issue mutations accept fields they do not send. Check [current mutation limits](docs/reference.md#modeled-issue-mutation-limits); verify every intended postcondition.
- Remote endpoints require HTTPS; HTTP is accepted only for loopback hosts.

## Benchmark

Published v0.2.1 compact read-only cohort: 8 tasks × 3 repeats per interface, or 48 compact cells. Full 96-cell matrix also tested an experimental canonical answer contract.

| Measure | AXI | Official MCP |
| --- | ---: | ---: |
| Deterministic / judge passes | 24/24 / 24/24 | 24/24 / 24/24 |
| Safety / policy / unexpected incidents | 0 / 0 / 0 | 0 / 0 / 0 |
| Reported tokens | -38.9% | baseline |
| Reported cost | -17.0% | baseline |
| Agent wall time (MCP mean = 100) | 114.2 | 100 |

Wall time is a relative index, not an absolute duration: for every 100 units of mean MCP time, AXI took 114.2, a difference of 14.2 units. For example, that ratio would mean 114.2 ms versus 100 ms (14.2 ms more), or 11.42 s versus 10 s (1.42 s more). These are illustrations, not measured durations. The published aggregate does not include the absolute mean wall times, so it cannot establish whether the practical delay was milliseconds or seconds; treat the 14.2% difference as directional only.

Aggregate-only directional evidence; raw cohort artifacts are not published, so no universal-superiority or mutation-proof claim. See [results, method, and caveats](docs/benchmark.md), [harness methodology](https://github.com/magimetal/magi-linear-axi/tree/main/benchmarks/linear), and [showcase](docs/showcase.html).

## Documentation

- [CLI reference](docs/reference.md): contract, configuration, commands, raw GraphQL, setup, completions.
- [Safety](docs/safety.md): retries, mutation verification, limits, security boundaries.
- [Development](docs/development.md): checkout install, tests, release gates.
- [Agent Skill](skills/magi-linear-axi/SKILL.md)
- [Changelog](CHANGELOG.md) · [release checklist](docs/release.md) · [license](LICENSE)
