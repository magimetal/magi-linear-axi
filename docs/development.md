# Development

## Checkout install

Requirements: Rust 1.87+, Cargo, and committed lockfile.

```sh
git clone https://github.com/magimetal/magi-linear-axi.git
cd magi-linear-axi
cargo install --path . --locked
```

## Verification

```sh
cargo +1.87.0 fmt --check
cargo +1.87.0 check --locked
cargo +1.87.0 test --locked
cargo +1.87.0 clippy --all-targets --all-features --locked -- -D warnings
cargo +1.87.0 build --release --locked
cargo deny check advisories
```

Integration tests use local TCP GraphQL mocks, temporary homes, and fake credentials; they do not need Linear access. CI currently validates Ubuntu.

## Benchmark harness

Read-only AXI-versus-MCP harness lives in [`benchmarks/linear`](https://github.com/magimetal/magi-linear-axi/tree/main/benchmarks/linear) and requires Node 22.12+ for local development. Offline harness tests use fake fixtures:

```sh
cd benchmarks/linear
npm ci
npm test
```

Live runs require explicit read-only gates and a least-privilege credential; follow harness README exactly.

## Release

See [`release.md`](release.md) for clean-main gates, package inspection, dry-run, publish, install verification, and tag sequence. Do not publish or tag from a dirty or unreviewed commit.
