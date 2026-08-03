# magi-linear-axi

`magi-linear-axi` is modular Rust CLI for direct Linear GraphQL operations with TOON output.

## Install

Install latest published release from crates.io:

```sh
cargo install magi-linear-axi --locked
```

Install from source when developing:

```sh
cargo install --path .
```

## Contract

- Binary: `magi-linear-axi`.
- stdout: TOON by default, strict JSON with `--format json`; AXI errors also structured on stdout.
- stderr: diagnostics only.
- Exit codes: 0 success, 1 runtime/auth/config/network/API failure, 2 usage or parse failure.
- No prompts. Endpoint precedence: `--endpoint` > `LINEAR_API_URL` > project `.linear.toml` > global config > Linear default.
- Workspace precedence: `--workspace` > non-empty `LINEAR_WORKSPACE`; workspace remains optional except browser-opening commands.
- API key source: non-empty `LINEAR_API_KEY` only. Keys are never stored or printed.
- Requires Rust 1.87 or newer.

## Commands

```sh
export LINEAR_API_KEY='lin_api_xxx'
magi-linear-axi auth whoami
magi-linear-axi issue list --format toon
magi-linear-axi api '{ viewer { id name email } }'
magi-linear-axi schema --output schema.json
magi-linear-axi setup --claude --codex --opencode
```

`api` accepts query from stdin when positional query omitted. Variables support `--variables-json` and repeatable `--variable key=value`.

## Development

```sh
cargo fmt --check
cargo test --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo build --release --locked
```
