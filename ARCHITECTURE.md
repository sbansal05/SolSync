# SolSync Architecture

> A complete technical reference for how SolSync works internally.
> Read this when you want to understand why a file exists or how data flows through the system.

---

## The Three Decisions

Everything in SolSync exists to answer three questions in order:

```
Decision 1 → What fee per Compute Unit should I pay?
Decision 2 → How many Compute Units should I request?
Decision 3 → How do I put these numbers into the transaction?
```

Every file in `packages/core/src/` maps to one of these decisions.

---

## Folder Structure

```
SolSync/
├── BENCHMARKS.md                  ← real mainnet benchmark results
├── ARCHITECTURE.md                ← this file
├── README.md                      ← quickstart and usage
├── LICENSE
├── package.json                   ← root workspace config
├── pnpm-workspace.yaml            ← declares core, sdk, cli packages
├── pnpm-lock.yaml
├── tsconfig.json                  ← shared TypeScript config (strict: true)
├── .gitignore
│
└── packages/
    │
    ├── core/                      ← all optimization logic (no CLI, no HTTP server)
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts               ← re-exports everything
    │       ├── feeSampler.ts          ← Decision 1: fetch fee data from RPC
    │       ├── feeSampler.test.ts
    │       ├── percentileEngine.ts    ← Decision 1: compute p50–p99 from data
    │       ├── percentileEngine.test.ts
    │       ├── emaFilter.ts           ← Decision 1: EMA smooth + spike detection
    │       ├── emaFilter.test.ts
    │       ├── cuOptimizer.ts         ← Decision 2: simulate tx, get CU count
    │       └── cuOptimizer.test.ts
    │
    ├── sdk/                       ← developer-facing npm package (@solsync/sdk)
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts               ← public API surface (tree-shakeable)
    │       └── SolSyncClient.ts       ← Decision 3: orchestrates all three decisions
    │
    └── cli/                       ← terminal tool (@solsync/cli)
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts               ← Commander.js entrypoint, "solsync" binary
            └── commands/
                └── analyze.ts         ← solsync analyze command (chalk output + --json)
```

---

## Data Flow

This is the exact path data travels every time `client.optimize()` is called:

```
Developer calls client.optimize(tx, writableAccounts)
                    │
                    ▼
┌─────────────────────────────────────────────┐
│           PHASE 1 — Fee Analysis            │
│               (1 RPC call)                  │
│                                             │
│  feeSampler.ts                              │
│  └─ check cache (skip RPC if < 1.5s old)    │
│  └─ getRecentPrioritizationFees(accounts)   │
│  └─ filter zero-fee slots                   │
│  └─ return FeeSlot[]                        │
│                                             │
│  percentileEngine.ts                        │
│  └─ sort fees ascending                     │
│  └─ compute p50/p75/p90/p95/p99             │
│  └─ select fee by urgency level             │
│                                             │
│  emaFilter.ts                               │
│  └─ sort slots oldest → newest              │
│  └─ apply EMA (alpha = 0.3)                 │
│  └─ check for spike (3σ rule)               │
│  └─ spike? → use EMA : use max(p75, EMA)    │
│                                             │
│  OUTPUT: microLamportsPerCU (one number)    │
└─────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────┐
│           PHASE 2 — CU Optimization         │
│               (1 RPC call)                  │
│                                             │
│  cuOptimizer.ts                             │
│  └─ simulateTransaction(tx, {               │
│       replaceRecentBlockhash: true,         │
│       sigVerify: false                      │
│     })                                      │
│  └─ read unitsConsumed (fallback: 200,000)  │
│  └─ apply 15% buffer                        │
│  └─ clamp to 1,400,000 max                  │
│                                             │
│  OUTPUT: computeUnitLimit (one number)      │
└─────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│           PHASE 3 — Transaction Assembly    │
│               (no RPC call)                 │
│                                             │
│  SolSyncClient.ts                           │
│  └─ ComputeBudgetProgram.setComputeUnitLimit│
│  └─ ComputeBudgetProgram.setComputeUnitPrice│
│  └─ prepend both to instruction list        │
│  └─ rebuild VersionedTransaction            │
│  └─ preserve Address Lookup Tables          │
│                                             │
│  OUTPUT: { tx, result }                     │
└─────────────────────────────────────────────┘
             │
             ▼
Developer signs tx and calls connection.sendTransaction(tx)
```

**Total RPC calls per optimization: exactly 2**
**Total latency: ~130ms (30ms fee query + 100ms simulation)**

---

## CLI Data Flow

When `solsync analyze` is run from the terminal:

```
User runs: solsync analyze --rpc <url> --accounts <keys> --urgency high
        │
        ▼
cli/src/index.ts
└─ Commander.js parses flags
└─ calls registerAnalyze(program)
        │
        ▼
cli/src/commands/analyze.ts
└─ creates Connection from --rpc flag
└─ maps --accounts strings → PublicKey[]
└─ calls samplePrioritizationFees()   ← core package
└─ calls computeFeeStats()            ← core package
└─ calls selectFeeByUrgency()         ← core package
        │
        ├─ --json flag → console.log(JSON.stringify(result))
        │
        └─ default → chalk formatted table:
               SolSync Fee Analysis
               ────────────────────────────────────────
               Accounts queried   2
               Samples found      54
               ────────────────────────────────────────
               p50 (low)          8,100 µ◎/CU
               p75 (medium)       22,100 µ◎/CU
               p90 (high)         31,000 µ◎/CU
               p95 (critical)     44,500 µ◎/CU
               ────────────────────────────────────────
               Recommended        22,100 µ◎/CU  (medium)
```

The CLI only uses `core` — it never imports from `sdk`. This keeps the dependency graph clean and the binary small.

---

## Module Reference

### `feeSampler.ts` — Decision 1, Step 1

**What it does:** Queries the Solana RPC for recent priority fees paid on specific accounts. Filters out zero-fee slots. Caches results for 1.5 seconds to prevent rate limiting.

**Key exports:**
```typescript
FeeSlot                      // { slot: number, prioritizationFee: number }
samplePrioritizationFees()   // queries RPC, returns FeeSlot[]
getFallbackFees()            // returns safe defaults when RPC returns empty
```

**Critical detail:** Always pass **writable** accounts only. Read-only accounts create zero fee pressure and return misleading (lower) data.

**Cache key:** Comma-joined string of all account base58 addresses. Same accounts within 1.5s → cache hit, no RPC call.

---

### `percentileEngine.ts` — Decision 1, Step 2

**What it does:** Takes the raw `FeeSlot[]` array and computes statistical percentiles. Maps an urgency level to the correct percentile value.

**Key exports:**
```typescript
FeeStats         // p50/p75/p90/p95/p99/mean/max/stddev/sampleCount
UrgencyLevel     // 'low' | 'medium' | 'high' | 'critical'
computeFeeStats()       // sorts fees, computes all percentiles
selectFeeByUrgency()    // low→p50, medium→p75, high→p90, critical→p95
```

**Percentile formula:**
```
index = ceil(percentile/100 × n) - 1
p90   = sortedFees[ceil(0.90 × n) - 1]
```

**Empty array handling:** Returns safe hardcoded defaults (p50=1000, p75=5000, p90=10000...) so the pipeline never crashes on empty data.

---

### `emaFilter.ts` — Decision 1, Step 3

**What it does:** Smooths fee data using Exponential Moving Average to prevent chasing sudden spikes. Detects outliers using the 3-sigma rule.

**Key exports:**
```typescript
emaSmooth()          // applies EMA, returns one smoothed fee number
isSpike()            // returns true if latest fee is a 3σ outlier
selectSmoothedFee()  // combines both: spike? → EMA : max(percentile, EMA)
```

**EMA formula:**
```
EMA_t = α × fee_t + (1 - α) × EMA_{t-1}
Default α = 0.3
Slots must be sorted oldest → newest before the loop
```

**Spike detection:**
```
mean   = average of all fees
stddev = √(average of squared distances from mean)
spike  = latest fee > mean + 3 × stddev
```

---

### `cuOptimizer.ts` — Decision 2

**What it does:** Simulates the transaction against current chain state to find exact Compute Units consumed. Adds a safety buffer. Clamps to Solana's maximum.

**Key exports:**
```typescript
CUEstimate              // { consumed, recommended, bufferPct }
estimateComputeUnits()  // async — calls simulateTransaction
applyBuffer()           // pure math — consumed × (1 + buffer), clamped
```

**Two mandatory simulation flags:**
```typescript
replaceRecentBlockhash: true  // prevents blockhash expiry failures
sigVerify: false              // transaction is unsigned at this point
```

**Buffer math:**
```
recommended = ceil(consumed × 1.15)
recommended = min(recommended, 1,400,000)
```

---

### `SolSyncClient.ts` — Decision 3

**What it does:** The orchestrator. Calls fee analysis and CU optimization, builds two `ComputeBudget` instructions, prepends them to the original transaction.

**Key exports:**
```typescript
SolSyncClient       // main class
OptimizationResult  // full metadata returned alongside optimized tx
```

**Instruction ordering — critical:**
```
index 0 → SetComputeUnitLimit   ← MUST be first
index 1 → SetComputeUnitPrice   ← MUST be second
index 2+ → original instructions
```

---

### `cli/src/index.ts` — CLI entrypoint

**What it does:** Creates the Commander.js program, sets the binary name to `solsync`, registers all subcommands, parses `process.argv`.

```typescript
#!/usr/bin/env node
program.name('solsync')
program.description('Dynamic Priority Fee & Compute Budget Optimization Engine')
registerAnalyze(program)
program.parse(process.argv)
```

---

### `cli/src/commands/analyze.ts` — analyze subcommand

**What it does:** Implements `solsync analyze`. Takes `--rpc`, `--accounts`, `--urgency`, `--json` flags. Calls core directly (no SDK dependency). Outputs either a chalk-formatted table or raw JSON.

**Flags:**
```
--rpc <url>          required — Solana RPC endpoint
--accounts <keys...> required — writable account public keys
--urgency <level>    optional — low|medium|high|critical (default: medium)
--json               optional — machine-readable output for scripting
```

---

## Key Design Decisions

### Why filter zero-fee slots?
Zero-fee slots are uncontested blocks. Including them skews percentiles downward and causes underpricing during actual congestion.

### Why EMA with alpha=0.3?
Alpha=0.3 gives the latest slot 30% weight while history carries 70%. A single NFT mint spike won't cause SolSync to overpay on the next transaction. Configurable via `emaAlpha`.

### Why 15% CU buffer?
Programs with variable-length loops consume slightly different CUs depending on current state. 15% covers this variance without significant overpay. Configurable via `cuBufferPct`.

### Why does the CLI import core directly, not sdk?
Keeps the CLI binary small and the dependency graph clean. The SDK adds the `SolSyncClient` wrapper — useful for developers integrating programmatically, but unnecessary overhead for a terminal command.

### Why exactly 2 RPC calls?
One for fees (`getRecentPrioritizationFees`), one for simulation (`simulateTransaction`). The fee call is cached — repeated calls within 1.5s cost zero additional network time. Total latency target: under 300ms.

### Why writable accounts only?
Only writable accounts create transaction conflicts. Read-only accounts can be accessed by unlimited concurrent transactions simultaneously — they generate zero fee competition.

---

## Configuration Reference

```typescript
new SolSyncClient({
  connection:       Connection,   // required
  urgency:          'medium',     // low|medium|high|critical → p50/p75/p90/p95
  emaAlpha:         0.3,          // EMA smoothing (0.1 slow → 0.6 reactive)
  cuBufferPct:      0.15,         // CU headroom above simulated usage
  maxMicroLamports: 5_000_000,    // fee ceiling cap
})
```

---

## Test Coverage

```
packages/core/src/
├── feeSampler.test.ts          4 tests  — cache, filtering, fallback, RPC mock
├── percentileEngine.test.ts    8 tests  — percentile math, edge cases, urgency map
├── emaFilter.test.ts           8 tests  — EMA convergence, spike detection, selector
└── cuOptimizer.test.ts         5 tests  — buffer math, clamping, edge cases
                               ──────────
                               25 tests total, all passing
```

Run all tests:
```bash
pnpm test
```

---

## Dependencies

| Package            | Used in       | Purpose                                         |
|--------------------|---------------|-------------------------------------------------|
| @solana/web3.js    | core, sdk     | RPC, VersionedTransaction, ComputeBudgetProgram |
| typescript (strict)| all packages  | Full type safety across all modules             |
| vitest             | core          | Unit + integration tests                        |
| dotenv             | core          | Load RPC URL from .env                          |
| commander          | cli           | CLI argument parsing                            |
| chalk              | cli           | Terminal colour output                          |
| pnpm workspaces    | root          | Monorepo — core, sdk, cli as separate packages  |
