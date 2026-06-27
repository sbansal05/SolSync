# SolSync

SolSync is a TypeScript SDK and CLI tool that acts as an optimization layer for Solana transactions. It automatically calculates the exact micro-lamport priority fee and Compute Unit limit required to land your transaction in the next block — without overpaying by even a single lamport.
Solana's fee market works at the account level: when a specific program or pool is heavily contested (NFT mint, DeFi protocol), only transactions touching those accounts compete on fees. SolFi queries this localized data, not global averages.


## How It Works

1. Calls `getRecentPrioritizationFees` for your specific writable accounts
2. Computes p50/p75/p90/p95 percentiles across recent slots
3. Applies EMA smoothing (α=0.3) and 3σ spike detection
4. Simulates your transaction to get the exact compute units consumed
5. Returns an optimized `VersionedTransaction` ready to sign and send

## Urgency Levels

| Level | Target | Use Case |
|---|---|---|
| low | p50 | Non-urgent background transactions |
| medium | p75 | Standard dApp transactions (default) |
| high | p90 | Time-sensitive user transactions |
| critical | p95 | Liquidations, arbitrage, MEV |

## Packages

| Package | Description |
|---|---|
| `@solsync/core` | Pure optimization logic — fee sampler, percentile engine, EMA filter, CU optimizer |
| `@solsync/sdk` | `SolSyncClient` class — the main public API |
| `@solsync/cli` | `solsync analyze` CLI command |

