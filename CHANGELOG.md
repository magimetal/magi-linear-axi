# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add non-destructive, read-only AXI versus official Linear MCP benchmark harness with dynamic workspace tasks, layered mutation guards, grounded grading, paired seeded runs, and cohort-safe reports.

### Security

- Add a per-case Unix-domain-socket AXI credential broker: Claude receives a temporary key-free wrapper, while the runner validates bounded read-only argv and injects credentials only into the pinned AXI child. Hard shell composition and redirection findings fail compliance/correctness.

### Fixed

- Correct benchmark issue prompts to use public Linear identifiers, replace sparse optional-resource cases with grounded interface-common search→view tasks, remove pseudo-evidence from comments and teams, tighten entity-scoped not-found grading, add a bounded AXI parity guide, separate hard safety/policy/error classification, add guarded primitive-reachability preflight, and fingerprint benchmark source, AXI binary, Claude versions, and the exact task manifest so stale or dirty cohorts cannot be compared.

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
