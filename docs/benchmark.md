# Benchmark

## Published compact read-only aggregate

| Measure | AXI CLI | Official Linear read-only MCP | Readout |
| --- | ---: | ---: | --- |
| Deterministic pass | 24/24 | 24/24 | parity |
| LLM judge pass | 24/24 | 24/24 | parity |
| Reported tokens | -38.9% | baseline | AXI lower |
| Reported cost | -17.0% | baseline | AXI lower |
| Agent wall time | +14.2% | baseline | AXI slower |
| Safety / policy / unexpected incidents | 0 / 0 / 0 | 0 / 0 / 0 | none observed |

This is aggregate-only evidence, not universal superiority and not a mutation-proof claim. Official managed MCP may suit MCP-native clients; it was faster in this measured cohort. Choose based on client, control, output contract, and latency needs.

## Method

- Scope: 8 read-only tasks × 3 repeats per interface; 48 compact cells. The full 96-cell matrix also included experimental canonical answer-contract cells.
- Interfaces: `magi-linear-axi` and official Linear read-only MCP.
- Tasks covered single-step, multi-step, investigation, and error recovery.
- Both interfaces used same generated facts and deterministic grading plus LLM judge.
- Wall time excludes judge execution and judge artifacts.
- Reported token and cost deltas use provider-reported aggregate measurements; published artifact does not expose token-component arithmetic. Wall time is agent wall time.

Canonical was tested, not adopted as CLI output mode. It produced shorter terminal answers but increased aggregate output tokens, cost, and turns; compact remains published contract.

## Provenance and caveats

Numbers come from committed v0.2.1 aggregate [showcase](showcase.html). Raw cohort artifacts are intentionally uncommitted because they contain workspace-sensitive facts; published evidence lacks run metadata and is not independently replayable from repository alone. Treat deltas as directional evidence. Live provider, model, workspace, snapshot, and service drift can change results. Read-only key scope remains operator responsibility. Harness safeguards observed commands but cannot prove remote mutation impossibility.

- [Benchmark harness, measurement contract, and threat model](https://github.com/magimetal/magi-linear-axi/tree/main/benchmarks/linear)
- [AXI methodology](https://axi.md/)
- [Linear MCP documentation](https://linear.app/docs/mcp)
- [Linear GraphQL API](https://developers.linear.app/docs/graphql/working-with-the-graphql-api)
