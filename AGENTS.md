# AGENTS.md

## Purpose

`magi-linear-axi` is self-contained Rust 2024 CLI for direct Linear GraphQL operations. It must never depend on or invoke `linear-cli`; `~/Dev/_third-party/linear-cli` is behavior reference only.

## Contracts

- Binary: `magi-linear-axi`.
- Agent-facing stdout: valid TOON by default; strict JSON with `--format json`.
- Structured errors also go to stdout. Diagnostics only on stderr.
- Exit codes: `0` success/no-op, `1` operational failure, `2` usage failure.
- Commands must remain non-interactive. Validate before network calls.
- Never silently ignore recognized flags.
- Secrets: `LINEAR_API_KEY` or OS credential store; never log tokens.

## Structure

- `src/cli.rs`: canonical clap command contract.
- `src/client.rs`: Linear GraphQL transport, upload, pagination.
- `src/commands/`: command-family implementations.
- `src/config.rs`, `src/credentials.rs`: config and auth precedence.
- `src/output.rs`, `src/error.rs`: AXI output contracts.
- `tests/integration.rs`: real-binary and mock-HTTP contracts.
- `skills/magi-linear-axi/SKILL.md`: installable agent skill.

## Required checks

```sh
cargo fmt --check
cargo test --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo build --release --locked
```

For command changes, add mock-server coverage proving GraphQL document, variables, auth header, stdout format, and exit code. Keep README/help/skill examples aligned with clap definitions.
