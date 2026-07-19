# SolSync

SolSync is a TypeScript SDK and CLI tool that acts as an optimization layer for Solana transactions. It automatically calculates the exact micro-lamport priority fee and Compute Unit limit required to land your transaction in the next block — without overpaying by even a single lamport.

Solana's fee market works at the account level: when a specific program or pool is heavily contested (NFT mint, DeFi protocol), only transactions touching those accounts compete on fees. SolSync queries this localized data, not global averages.

![License](https://img.shields.io/badge/license-MIT-green)
![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Built With](https://img.shields.io/badge/built%20with-TypeScript-3178c6)

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [API Documentation](#api-documentation)
- [CLI Reference](#cli-reference)
- [Packages](#packages)
- [Benchmarks](#benchmarks)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

---

## Features

- **Account-level fee sampling** — queries `getRecentPrioritizationFees` for your specific writable accounts, not network-wide averages
- **Statistical percentile targeting** — p50/p75/p90/p95 mapped to urgency levels (low/medium/high/critical)
- **EMA smoothing** — exponential moving average (α=0.3) prevents fee chasing during sudden spikes
- **3σ spike detection** — automatically falls back to EMA when the latest slot is a statistical outlier
- **Compute Unit simulation** — calls `simulateTransaction` to find the exact CUs consumed, adds a 15% safety buffer
- **VersionedTransaction assembly** — prepends `SetComputeUnitLimit` and `SetComputeUnitPrice` at index 0 and 1, preserves Address Lookup Tables
- **1.5s RPC cache** — prevents redundant calls within the same transaction-building flow
- **CLI tool** — `solsync analyze` for terminal-based fee market inspection

---

## Requirements

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- A Solana RPC endpoint (public or private — [Helius](https://helius.dev), [QuickNode](https://quicknode.com), or public endpoints)

---

## Installation

**SDK:**
```bash
pnpm add @solsync/sdk
```

**CLI (global):**
```bash
pnpm add -g @solsync/cli
```

**From source:**
```bash
git clone https://github.com/yourusername/solsync
cd solsync
pnpm install
pnpm build
```

---

## Usage

### SDK — Full optimization

```typescript
import { SolSyncClient } from "@solsync/sdk";
import { Connection, PublicKey } from "@solana/web3.js";

const client = new SolSyncClient({
  connection: new Connection("https://api.mainnet-beta.solana.com"),
  urgency: "medium",
});

// Pass your existing unsigned VersionedTransaction + the accounts it writes to
const { tx, result } = await client.optimize(originalTx, writableAccounts);

// Sign and send the optimized transaction
tx.sign([payer]);
const sig = await connection.sendTransaction(tx);

console.log(result.priorityFeePerCU);  // e.g. 273,954 µ◎/CU
console.log(result.computeUnitLimit);  // e.g. 518 CU
console.log(result.spikeDetected);     // true if EMA was used
```

### SDK — Fee analysis only (no transaction needed)

```typescript
const { stats, recommended, spikeDetected } = await client.analyzeOnly([
  new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
]);

console.log(stats.p75);      // market p75 fee
console.log(recommended);    // what SolSync recommends
console.log(spikeDetected);  // whether EMA kicked in
```

### SDK — Estimate cost of an already-optimized transaction

```typescript
const solCost = await client.estimateCost(optimizedTx);
console.log(solCost); // e.g. 0.000000090 SOL
```

---

## Configuration

All options are passed to the `SolSyncClient` constructor:

| Option | Type | Default | Description |
|---|---|---|---|
| `connection` | `Connection` | required | Your Solana RPC connection |
| `urgency` | `'low' \| 'medium' \| 'high' \| 'critical'` | `'medium'` | Fee percentile target |
| `emaAlpha` | `number` | `0.3` | EMA smoothing factor (0.1 = slow, 0.6 = reactive) |
| `cuBufferPct` | `number` | `0.15` | CU safety buffer above simulated usage |
| `maxMicroLamports` | `number` | `5_000_000` | Fee ceiling cap in µ◎/CU |

**Urgency levels:**

| Level | Target | Use Case |
|---|---|---|
| `low` | p50 | Non-urgent background transactions |
| `medium` | p75 | Standard dApp transactions |
| `high` | p90 | Time-sensitive user transactions |
| `critical` | p95 | Liquidations, arbitrage, MEV |

---

## API Documentation

### `SolSyncClient`

#### `optimize(originalTx, writableAccounts, opts?)`

Full pipeline: fee analysis → CU simulation → transaction assembly.

```typescript
const { tx, result } = await client.optimize(
  originalTx,          // VersionedTransaction — unsigned
  writableAccounts,    // PublicKey[] — accounts your tx writes to
  { urgency: 'high' } // optional per-call override
);
```

Returns `{ tx: VersionedTransaction, result: OptimizationResult }`.

`OptimizationResult`:
```typescript
{
  priorityFeePerCU: number;   // fee set in µ◎/CU
  computeUnitLimit: number;   // CU limit set
  stats: FeeStats;            // full statistical breakdown
  spikeDetected: boolean;     // true if EMA was used instead of percentile
  urgency: UrgencyLevel;      // which urgency level was used
}
```

#### `analyzeOnly(writableAccounts)`

Fee analysis only — no transaction or simulation required.

```typescript
const { stats, recommended, spikeDetected } =
  await client.analyzeOnly(writableAccounts);
```

#### `estimateCost(tx)`

Reads the ComputeBudget instructions from an optimized transaction and returns the total priority fee in SOL.

```typescript
const solCost = await client.estimateCost(tx); // number in SOL
```

---

## CLI Reference

### `analyze`

Analyze the live priority fee market for specific accounts.

```bash
solsync analyze \
  --rpc https://api.mainnet-beta.solana.com \
  --accounts 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 \
  --urgency high
```

**Options:**

| Flag | Description | Default |
|---|---|---|
| `--rpc <url>` | Solana RPC endpoint URL | required |
| `--accounts <keys...>` | One or more writable account addresses | required |
| `--urgency <level>` | low \| medium \| high \| critical | `medium` |
| `--json` | Output raw JSON instead of formatted table | false |

**Examples:**

```bash
# Multiple accounts
solsync analyze \
  --rpc https://api.mainnet-beta.solana.com \
  --accounts 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 \
             JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 \
  --urgency medium

# JSON output for scripting
solsync analyze --rpc $RPC_URL --accounts <pubkey> --json | jq .recommended
```

---

## Packages

| Package | Description |
|---|---|
| `@solsync/core` | Pure optimization logic — fee sampler, percentile engine, EMA filter, CU optimizer, tx builder |
| `@solsync/sdk` | `SolSyncClient` class — the main public API |
| `@solsync/cli` | `solsync analyze` CLI command |

---

## Benchmarks

On 20 consecutive runs against Raydium AMM v4 and Jupiter v6 on mainnet-beta:

| Metric | Value |
|---|---|
| Avg recommended fee | 868,326 µ◎/CU |
| Flat default baseline | 100,000 µ◎/CU |
| Runs flat default would miss inclusion | 20 / 20 |
| Spike events detected | 0 / 20 |

A hardcoded 100,000 µ◎/CU fee would have missed inclusion on every single run. See [BENCHMARKS.md](./BENCHMARKS.md) for full per-run data and analysis.

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the complete data flow diagram, module reference, and design decisions.

---

## Roadmap

- [ ] `solsync optimize` CLI command — optimize a base64-encoded transaction directly from the terminal
- [ ] `solsync monitor` — real-time fee monitoring with configurable poll interval
- [ ] Jito bundle support — tip calculation alongside priority fee
- [ ] React hook — `useSolSyncFee(accounts)` for frontend dApps
- [ ] Rust CLI port — for latency-critical MEV environments

---

## FAQ

**Q: Why pass writable accounts and not all accounts?**
Only writable accounts create transaction contention. Read-only accounts can be accessed by unlimited concurrent transactions simultaneously and generate zero fee pressure. Passing them returns misleadingly low fee data.

**Q: Why does the recommended fee sometimes seem high?**
Check `result.spikeDetected`. If `true`, the latest slot had a statistical outlier (3σ above mean) and EMA was used instead of the raw percentile. The market may genuinely be congested — try `urgency: 'low'` for non-urgent transactions.

**Q: The fee sampler returns 0 samples — is something broken?**
No. Zero samples means the queried accounts had no contested transactions in the recent slot window. This is a valid market state. SolSync returns safe fallback defaults in this case.

**Q: Why are there two calls to `buildOptimizedTransaction` in `optimize()`?**
The first call uses a 200,000 CU placeholder to simulate a structurally complete transaction with budget instructions included. The second call uses the real CU estimate from that simulation. Simulating the original transaction before budget instructions are prepended produces an inaccurate CU count.

**Q: Can I use this with legacy transactions?**
Currently SolSync is built around `VersionedTransaction` (V0 format). Legacy transaction support is on the roadmap.

---

## Contributing

Contributions are welcome. To get started:

```bash
git clone https://github.com/yourusername/solsync
cd solsync
pnpm install
pnpm build
pnpm test
```

Please open an issue before submitting a PR for large changes. Make sure `pnpm test` passes and new code has corresponding tests before submitting.

---

## Changelog


**v0.1.0** — Initial release
- Fee sampler with 1.5s cache and zero-fee filtering
- Percentile engine (p50/p75/p90/p95)
- EMA smoothing and 3σ spike detection
- CU optimizer with simulation and 15% buffer
- VersionedTransaction assembler with ALT support
- `SolSyncClient` SDK
- `solsync analyze` CLI command

---

## License

MIT — see [LICENSE](./LICENSE) for details.
