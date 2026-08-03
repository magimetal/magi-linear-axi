# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]


## [0.1.0] - 2026-08-03

### Added

- Initial public release of non-interactive `magi-linear-axi` CLI for direct Linear GraphQL operations.
- Issue and resource-family commands for teams, users, projects, updates, cycles, milestones, initiatives, labels, and documents.
- Authentication uses non-empty `LINEAR_API_KEY` only; workspace uses `--workspace` or `LINEAR_WORKSPACE`; credentials are never stored.
- Compact TOON output by default, strict JSON output on request, structured errors, pagination, raw GraphQL, schema inspection, uploads, and setup integrations.
