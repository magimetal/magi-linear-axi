# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add interface-neutral compact-versus-canonical benchmark cells. Canonical answers use exact minified JSON with ordered task schemas, string values, literal Unicode, normal JSON escaping, ordered arrays for multiple records, and explicit issue-scoped not-found errors.
- Add contract-aware scheduling, preflight/grading, strict cohort validation, provider output-token coverage, terminal Unicode-character/UTF-8-byte metrics, and `adopt`/`retain`/`not_evaluable` reporting against the 15% adoption gate.

## [0.2.0] - 2026-08-06

### Added

- Add non-destructive, read-only AXI versus official Linear MCP benchmark harness with dynamic workspace tasks, layered mutation guards, grounded grading, paired seeded runs, and cohort-safe reports.
- Add bounded component latency instrumentation and aggregate coverage reporting for Claude-reported/process time, broker setup, wrapper socket round trips, AXI child lifetime, GraphQL attempts, rendering, stream parsing, retries, and orchestration outside primary wall time. Hermetic fake-Claude/real-AXI/local-GraphQL tests verify retry attribution, isolation, and content-free timing metadata.
- Add opt-in `--fields compact` projections for issue, comment, relation, and project read commands with bounded compact pagination.

### Security

- Add a per-case Unix-domain-socket AXI credential broker: Claude receives a temporary key-free wrapper, while the runner validates bounded read-only argv and injects credentials only into the pinned AXI child. Hard shell composition and redirection findings fail compliance/correctness.

### Fixed

- Correct benchmark issue prompts to use public Linear identifiers, replace sparse optional-resource cases with grounded interface-common search→view tasks, remove pseudo-evidence from comments and teams, tighten entity-scoped not-found grading, add a bounded AXI parity guide, separate hard safety/policy/error classification, add guarded primitive-reachability preflight, and fingerprint benchmark source, AXI binary, Claude versions, and the exact task manifest so stale or dirty cohorts cannot be compared.

- Compress AXI benchmark condition guidance into one wrapper declaration, compact read grammar, and consolidated safety constraints; retain all five permitted reads and record prompt size estimates in regression tests.

- Make fresh benchmark snapshots compatible with Linear's not-found behavior by confirming absent issue identifiers through bounded, team-scoped issue-number connections instead of error-producing direct lookups.

- Harden Unix Claude timeout process-group cleanup and document that result JSONL contains workspace-sensitive redacted answers while reports remain aggregate-only.

- Make benchmark task prompts and grading hints interface-neutral, enforce typed operation order, exact operands, linked successful result values, and intentional issue-scoped errors in deterministic grading, and validate the search source with a bounded workspace-wide title uniqueness probe before task generation.

- Anchor crates.io package include patterns to repository root so nested benchmark dependency metadata is excluded.

- Make benchmark task generation honor AXI's shared 240-Unicode-code-point default output limit without slicing facts, omit unrepresentable optional values, and fail clearly when core issue facts cannot be represented. Snapshot capture now persists a required query-only confirmed-absent identifier using at most ten direct probes, propagates probe errors, rejects stale snapshots, and removes bounded-list-only invalid-identifier generation.
- Add shared condition-neutral compact final-answer benchmark contract, preserve explicit issue-scoped not-found wording, retain long model answers through parsing and persistence, and report deterministic/judge agreement for passed/failed judge results in Markdown and CSV.

## [0.1.1] - 2026-08-03

### Fixed

- Preserve bounded sanitized HTTP failure details and status codes.
- Retry only read requests on transient transport failures/statuses; mutations and uploads execute once.
- Treat missing issues and unsuccessful issue deletion as structured API errors.

## [0.1.0] - 2026-08-03

### Added

- Initial public release of non-interactive `magi-linear-axi` CLI for direct Linear GraphQL operations.
- Issue and resource-family commands for teams, users, projects, updates, cycles, milestones, initiatives, labels, and documents.
- Authentication uses non-empty `LINEAR_API_KEY` only; workspace uses `--workspace` or `LINEAR_WORKSPACE`; credentials are never stored.
- Compact TOON output by default, strict JSON output on request, structured errors, pagination, raw GraphQL, schema inspection, uploads, and setup integrations.
