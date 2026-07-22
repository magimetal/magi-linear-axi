<!--THIS IS A GENERATED FILE - DO NOT MODIFY DIRECTLY, FOR MANUAL ADJUSTMENTS UPDATE `AGENTS_CUSTOM.md`-->
# ALWAYS READ THESE FILE(S)
- @AGENTS_CUSTOM.md

# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-22T07:02:57Z
**Commit:** ec6a320
**Branch:** main

## OVERVIEW

`magi-linear-axi` is self-contained Rust 2024 CLI for direct Linear GraphQL operations. Agent-native contract: compact TOON by default, strict JSON on request, non-interactive execution.

## STRUCTURE

```text
magi-axi/
├── src/
│   ├── main.rs              # Thin process entry
│   ├── lib.rs               # Runtime context and exit boundary
│   ├── cli.rs               # Canonical clap schema and dispatch
│   ├── client.rs            # GraphQL transport, upload, pagination
│   ├── commands.rs          # Top-level command operations
│   ├── commands/            # Command families; issue/resource hold core logic
│   ├── config.rs            # Config precedence and atomic writes
│   ├── credentials.rs       # OS keyring-backed workspace credentials
│   ├── output.rs            # TOON/JSON rendering and truncation
│   └── error.rs             # Structured error and exit-code mapping
├── tests/integration.rs     # Real-binary tests with local TCP GraphQL mock
├── skills/magi-linear-axi/  # Installable agent operation guide
└── .github/workflows/ci.yml # Rust 1.85 validation
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add/change flag or command | `src/cli.rs` | Clap definition is source of truth; keep aliases valid |
| Add issue behavior | `src/commands/issue.rs` | Dedicated issue query/mutation dispatcher |
| Add resource-family behavior | `src/commands/resource.rs` | Shared Team/User/Project/etc. routing |
| Add thin resource family | `src/commands/{family}.rs` | Delegate to `resource::run`; avoid duplicate GraphQL plumbing |
| Change raw API/schema/setup/auth | `src/commands.rs` | Mixed top-level operations and module declarations |
| Change HTTP/API behavior | `src/client.rs` | Synchronous `ureq`; GraphQL strings live near command code |
| Change config/auth precedence | `src/config.rs`, `src/credentials.rs` | Project config, environment, then credential store interactions |
| Change output/error contract | `src/output.rs`, `src/error.rs`, `src/lib.rs` | stdout, stderr, truncation, and exit codes are public API |
| Add CLI regression coverage | `tests/integration.rs` | `assert_cmd`, temporary HOME, local `TcpListener` mock |
| Update agent usage examples | `skills/magi-linear-axi/SKILL.md`, `README.md` | Keep aligned with clap definitions |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `main_exit` | function | `src/lib.rs` | Parse, render errors, return process exit code |
| `Cli::execute` | method | `src/cli.rs` | Root command dispatch |
| `CommandContext::from_cli` | method | `src/lib.rs` | Load config, credentials, client, output mode |
| `LinearClient` | struct | `src/client.rs` | Authenticated GraphQL transport |
| `LinearClient::paginate` | method | `src/client.rs` | Merge first discovered GraphQL connection |
| `commands::issue::execute` | function | `src/commands/issue.rs` | Issue-family dispatch |
| `commands::resource::run` | function | `src/commands/resource.rs` | Generic resource-family execution |
| `Config::load` | method | `src/config.rs` | Resolve endpoint/workspace/key settings |
| `CredentialStore` | struct | `src/credentials.rs` | Workspace metadata plus OS keyring operations |
| `Output::render` | method | `src/output.rs` | TOON/JSON serialization and default truncation |
| `AppError` | enum | `src/error.rs` | Stable error categories and exit mapping |

## CONVENTIONS

- Rust edition 2024; MSRV 1.85. Keep `Cargo.lock` committed and validation locked.
- Binary remains `magi-linear-axi`; never depend on or invoke `linear-cli`.
- stdout contains primary machine-readable data. Default TOON; `--format json` emits strict JSON.
- Structured errors also go stdout. Diagnostics only go stderr.
- Exit codes: `0` success/no-op, `1` operational failure, `2` usage/parse failure.
- Commands remain non-interactive. Validate inputs before network calls.
- Configuration resolution: explicit CLI value, environment, `.linear.toml`, global config, default. Relevant environment: `LINEAR_API_URL`, `LINEAR_WORKSPACE`, `LINEAR_API_KEY`.
- Endpoint requires HTTPS except localhost loopback used by tests.
- Default rendering truncates strings after 240 characters; `--full` disables truncation.
- Config/state writes use `config::write_atomic`; setup mutations preserve unrelated content and remain idempotent.
- Unit tests stay beside local logic. End-to-end CLI/API contracts belong in `tests/integration.rs`.

## ANTI-PATTERNS (THIS PROJECT)

- Never log or include API tokens in errors. Preserve client-side token sanitization.
- Never silently ignore recognized flags or accept a flag without implementing behavior.
- Never add prompts, pagers, or TTY-only flow; automation must supply required values explicitly.
- Never send diagnostics or decorative text to stdout; consumers parse it as TOON/JSON.
- Never duplicate resource command plumbing when `resource::run` covers operation.
- Never loosen HTTPS enforcement for non-loopback endpoints.
- Avoid copying raw API-token request assertions from tests into production logging.

## UNIQUE STYLES

- `src/main.rs` delegates entirely to library process boundary, keeping execution testable.
- Most command families are thin adapters over generic `resource` operations; issue commands remain specialized.
- GraphQL documents are embedded in command modules rather than generated or stored separately.
- Credential access shells out to macOS `security` or Linux `secret-tool`; no keyring crate.
- Integration HTTP mocking uses standard-library TCP server, not external mock framework.
- Global command aliases (`cy`, `m`, `init`, `iu`, `l`, `docs`, `doc`, `pu`) are CLI contracts.

## COMMANDS

```bash
cargo fmt --check
cargo test --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo build --release --locked
```

## NOTES

- For command changes, add mock-server coverage proving GraphQL document, variables, auth header, stdout format, and exit code.
- Keep README, clap help, and `skills/magi-linear-axi/SKILL.md` examples synchronized.
- `--paginate` follows first object containing `nodes` plus `pageInfo`; variables must be a JSON object.
- Uploads are capped at Linear's 100 MB limit.
- CI runs Ubuntu only. macOS `security` path lacks CI coverage; non-macOS builds assume Linux `secret-tool`, so Windows credential storage is unsupported.
