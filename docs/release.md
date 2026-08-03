# crates.io release

Release `magi-linear-axi` from clean `main` only.

1. Confirm branch, version `0.1.1` in `Cargo.toml`, matching `Cargo.lock`, and dated `CHANGELOG.md` section. Confirm `v0.1.1` does not exist locally, remotely, or on crates.io.
2. Run locked gates with Rust 1.87:

   ```sh
   cargo +1.87.0 fmt --check
   cargo +1.87.0 check --locked
   cargo +1.87.0 test --locked
   cargo +1.87.0 clippy --all-targets --all-features --locked -- -D warnings
   cargo +1.87.0 build --release --locked
   cargo deny check advisories
   ```

3. Commit release preparation, push `main`, require green CI, then confirm local `HEAD` equals `origin/main` and worktree is clean. Publication must use that exact commit.
4. Inspect package contents and archive. Confirm expected source/docs files, ISC license and notices, no secrets, and no unintended files:

   ```sh
   cargo +1.87.0 package --locked --list
   cargo +1.87.0 package --locked
   tar -tf target/package/magi-linear-axi-0.1.1.crate
   cargo +1.87.0 publish --locked --dry-run
   ```

5. **Irreversible checkpoint:** review CI, dry-run output, package archive, version, changelog, repository, license, and authenticated crates.io account. Never inspect or print Cargo credentials.
6. Publish once:

   ```sh
   cargo +1.87.0 publish --locked
   ```

   Do not blind-retry. Check crates.io status first if command result is unclear.
7. In isolated environment, install exact version and verify:

   ```sh
   INSTALL_ROOT="$(mktemp -d)"
   cargo +1.87.0 install magi-linear-axi --version 0.1.1 --locked --root "$INSTALL_ROOT"
   "$INSTALL_ROOT/bin/magi-linear-axi" --help
   "$INSTALL_ROOT/bin/magi-linear-axi" --version
   trash "$INSTALL_ROOT"
   ```

8. Create immutable annotated tag on published commit and GitHub release from reviewed changelog notes:

   ```sh
   git tag -a v0.1.1 -m "magi-linear-axi v0.1.1"
   git push origin v0.1.1
   gh release create v0.1.1 --verify-tag --title "magi-linear-axi v0.1.1" --notes-file <reviewed-release-notes.md>
   ```
