<!--THIS IS A GENERATED FILE - DO NOT MODIFY DIRECTLY, FOR MANUAL ADJUSTMENTS UPDATE `AGENTS_CUSTOM.md`-->
# ALWAYS READ THESE FILE(S)
- @AGENTS_CUSTOM.md

# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-03T18:43:37Z
**Commit:** 94a2345
**Branch:** main

## OVERVIEW

`magi-linear-axi` is self-contained Rust 2024 CLI for direct Linear GraphQL operations. Agent-facing contract: compact TOON by default, strict JSON on request, structured errors, non-interactive execution.

## STRUCTURE

```text
magi-axi-linear/
├── src/
│   ├── main.rs              # Thin process entry
│   ├── lib.rs               # Runtime context and exit boundary
│   ├── cli.rs               # Canonical clap schema and dispatch
│   ├── client.rs            # GraphQL transport, upload, pagination
│   ├── commands.rs          # Raw API, schema, auth, config, setup, home
│   ├── commands/            # Issue logic and shared resource-family routing
│   ├── config.rs            # Layered config resolution and atomic writes
│   ├── output.rs            # TOON/JSON rendering and truncation
│   ├── output.rs            # TOON/JSON rendering and truncation
│   └── error.rs             # Structured error and exit-code mapping
├── tests/integration.rs     # Real-binary tests with local TCP GraphQL mock
├── skills/magi-linear-axi/  # Installable agent operation guide
├── docs/release.md          # crates.io release gates and irreversible steps
└── .github/workflows/ci.yml # Rust 1.87.0 validation
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add/change flag or command | `src/cli.rs` | Clap definition is source of truth; aliases are public contracts |
| Add issue behavior | `src/commands/issue.rs` | Dedicated issue query/mutation dispatcher |
| Add resource-family behavior | `src/commands/resource.rs` | Shared Team/User/Project/etc. routing |
| Add thin resource family | `src/commands/{family}.rs` | Delegate to `resource::run`; avoid duplicate GraphQL plumbing |
| Change raw API/schema/setup/auth | `src/commands.rs` | Top-level operations plus setup integration generation |
| Change HTTP/API behavior | `src/client.rs` | Synchronous `ureq`; GraphQL strings live near command code |
| Change config precedence | `src/config.rs` | Endpoint file layers, environment/CLI overrides, parse failures |
| Change output/error contract | `src/output.rs`, `src/error.rs`, `src/lib.rs` | stdout, stderr, truncation, exit codes are public API |
| Add CLI regression coverage | `tests/integration.rs` | `assert_cmd`, temporary HOME, local `TcpListener` mock |
| Prepare crates.io release | `docs/release.md` | Clean-main checklist, package inspection, publish/tag sequence |
| Update agent usage examples | `skills/magi-linear-axi/SKILL.md`, `README.md` | Keep aligned with clap definitions |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `main_exit` | function | `src/lib.rs` | Parse, render errors, return process exit code |
| `Cli::execute` | method | `src/cli.rs` | Root command dispatch |
| `CommandContext::from_cli` | method | `src/lib.rs` | Load environment key, config, client, output mode |
| `LinearClient::paginate` | method | `src/client.rs` | Merge first discovered GraphQL connection |
| `commands::setup` | function | `src/commands.rs` | Install Claude, Codex, OpenCode context integrations |
| `commands::issue::execute` | function | `src/commands/issue.rs` | Issue-family dispatch |
| `commands::resource::run` | function | `src/commands/resource.rs` | Generic resource-family execution |
| `Config::load` | method | `src/config.rs` | Merge config layers and reject malformed files |
| `Output::render` | method | `src/output.rs` | TOON/JSON serialization and default truncation |
| `AppError` | struct | `src/error.rs` | Stable error categories and exit mapping |

## CONVENTIONS

- Rust edition 2024; MSRV 1.87. CI and release gates pin Rust 1.87.0. Keep `Cargo.lock` committed and validation locked.
- Binary remains `magi-linear-axi`; never depend on or invoke `linear-cli`.
- stdout contains primary machine-readable data. Default TOON; `--format json` emits strict JSON.
- Structured errors also go stdout. Diagnostics only go stderr.
- Exit codes: `0` success/no-op, `1` operational failure, `2` usage/parse failure.
- Commands remain non-interactive. Validate inputs before network calls.
- Endpoint config loads global `~/.config/linear/linear.toml`, then project `.linear.toml`; malformed existing files fail with their path.
- Final endpoint precedence: CLI, environment, project, global, Linear default. Workspace uses CLI then non-empty environment; API key requires non-empty `LINEAR_API_KEY`.
- Endpoint requires HTTPS except localhost loopback used by tests.
- Default rendering truncates strings after 240 characters; `--full` disables truncation.
- Config/state writes use `config::write_atomic`; setup mutations preserve unrelated content and remain idempotent.
- Setup records absolute `current_exe` paths. OpenCode integration uses `experimental.chat.system.transform`, runs from session directory, and appends bounded CLI context.
- Unit tests stay beside local logic. End-to-end CLI/API/setup contracts belong in `tests/integration.rs`.

## ANTI-PATTERNS (THIS PROJECT)

- Never log or include API tokens in errors. Preserve client-side token sanitization.
- Never silently ignore recognized flags or accept a flag without implementing behavior.
- Never add prompts, pagers, or TTY-only flow; automation supplies required values explicitly.
- Never send diagnostics or decorative text to stdout; consumers parse it as TOON/JSON.
- Never replace per-field config overlays with whole-file precedence or silently accept malformed config.
- Never generate setup hooks with PATH-dependent executable names; integrations require resolved absolute path.
- Never duplicate resource command plumbing when `resource::run` covers operation.
- Never loosen HTTPS enforcement for non-loopback endpoints.

## UNIQUE STYLES

- `src/main.rs` delegates entirely to library process boundary, keeping execution testable.
- Most command families are thin adapters over generic `resource` operations; issue commands remain specialized.
- GraphQL documents are embedded in command modules rather than generated or stored separately.
- Integration HTTP mocking uses standard-library TCP server, not external mock framework.
- Setup installs JSON hooks for Claude/Codex and generated JavaScript system-transform plugin for OpenCode.
- Global command aliases (`cy`, `m`, `init`, `iu`, `l`, `docs`, `doc`, `pu`) are CLI contracts.

## COMMANDS

```bash
cargo +1.87.0 fmt --check
cargo +1.87.0 test --locked
cargo +1.87.0 clippy --all-targets --all-features --locked -- -D warnings
cargo +1.87.0 build --release --locked
```

## NOTES

- For command changes, add mock-server coverage proving GraphQL document, variables, auth header, stdout format, and exit code.
- For setup changes, prove idempotence, preservation of unrelated config, absolute executable path, and target-specific hook shape.
- Keep README, clap help, and `skills/magi-linear-axi/SKILL.md` examples synchronized.
- Follow `docs/release.md` exactly for packaging/publication; publish and tag steps are intentionally irreversible.
- `--paginate` follows first object containing `nodes` plus `pageInfo`; variables must be a JSON object.
- Uploads are capped at Linear's 100 MB limit.
- CI runs Ubuntu only; authentication uses environment-only API keys.
