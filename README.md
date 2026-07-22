# magi-linear-axi

`magi-linear-axi` is modular Rust CLI for direct Linear GraphQL operations with TOON output.

## Contract

- Binary: `magi-linear-axi`.
- stdout: TOON by default, strict JSON with `--format json`; AXI errors also structured on stdout.
- stderr: diagnostics only.
- Exit codes: 0 success, 1 runtime/auth/config/network/API failure, 2 usage or parse failure.
- No prompts. `LINEAR_API_KEY` has runtime precedence over stored credentials.
- GraphQL endpoint: `--endpoint`, `LINEAR_API_URL`, then Linear default.

## Commands

```sh
cargo install --path .
magi-linear-axi auth login --key lin_api_xxx --workspace acme
magi-linear-axi issue list --format toon
magi-linear-axi api '{ viewer { id name email } }'
magi-linear-axi schema --output schema.json
magi-linear-axi setup --claude --codex --opencode
```

`api` accepts query from stdin when positional query omitted. Variables support `--variables-json` and repeatable `--variable key=value`.

## Development

```sh
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
cargo build --release --locked
```
