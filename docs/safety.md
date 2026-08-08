# Safety and limits

## Transport behavior

Modeled read-only requests retry transient connection failures and HTTP 500, 502, 503, and 504 up to three total attempts, with 50 ms then 100 ms backoff. Mutations, uploads, raw API calls, raw pagination, and HTTP-200 GraphQL errors never retry.

Successful response bodies are capped at 10 MiB. HTTP failure previews are sanitized and capped at 512 bytes. Uploads are capped at Linear's 100 MiB limit and read into memory before transfer; `--public` changes attachment visibility.

## Mutation verification

1. Read target first; retain stable ID and identifying fields.
2. Use explicit IDs. Do not infer IDs from names.
3. Send one mutation and inspect returned `success`.
4. Return every intended postcondition or immediately read omitted fields back.
5. Never blindly retry after success or ambiguous transport failure.
6. Branch on status: exit `2` means fix invocation; exit `1` means inspect structured error.

`success:true` is acceptance, not proof all requested fields changed. After deletion, a narrow exclusion query is eventual-consistency evidence, not transactional proof; stale reads and provider tombstones remain possible. Raw GraphQL has full authority granted to API key.

For relation deletion, command accepts issue, relation type, and relation ID, but Linear mutation uses only relation ID. List relations first and copy exact ID; other arguments do not guard against wrong deletion.

## Security boundaries

- Key comes only from non-empty `LINEAR_API_KEY`; never persisted, printed, or included in hooks.
- Transport error previews redact configured token values.
- Remote endpoints require HTTPS; HTTP is accepted only for loopback hosts and is intended for hermetic tests.
- Most operations launch no subprocess. Git/GitHub helpers use executable argument arrays; browser opening uses `open` on macOS, `xdg-open` on Linux, and `cmd /C start` on Windows.
- Setup records resolved absolute executable path, not mutable `PATH` lookup.
- Repository never invokes `linear` or `linear-cli`.

## Read-only benchmark boundary

The benchmark uses a least-privilege read-only key, query-only snapshot preparation, a key-free AXI wrapper/broker, the official Linear read-only endpoint, shell-composition audits, and aggregate-only reports. It does not prove an agent or remote service is mutation-proof outside observed trajectories. Keep snapshots, generated tasks, results, raw JSONL, and judge artifacts private; share aggregate reports only.

See [benchmark documentation](benchmark.md) for results and [harness threat model](https://github.com/magimetal/magi-linear-axi/tree/main/benchmarks/linear) for live-command gates.
