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
├── BENCHMARKS.md              ← real mainnet benchmark results
├── ARCHITECTURE.md            ← this file
├── README.md                  ← quickstart and usage
├── package.json               ← root workspace config
├── pnpm-workspace.yaml        ← declares packages/core and packages/sdk
├── tsconfig.json              ← shared TypeScript config (strict: true)
│
└── packages/
    ├── core/                  ← all optimization logic lives here
    │   └── src/
    │       ├── index.ts           ← re-exports everything
    │       ├── feeSampler.ts      ← Decision 1: fetch fee data from RPC
    │       ├── percentileEngine.ts← Decision 1: compute p50–p99 from data
    │       ├── emaFilter.ts       ← Decision 1: smooth + spike detection
    │       └── cuOptimizer.ts     ← Decision 2: simulate tx, get CU count
    │
    └── sdk/                   ← developer-facing wrapper
        └── src/
            ├── index.ts           ← public API surface
            └── SolSyncClient.ts   ← Decision 3: orchestrates everything
```

---

## Data Flow

This is the exact path data travels every time `client.optimize()` is called:

```
Developer calls client.optimize(tx, writableAccounts)
        │
        ▼
┌─────────────────────────────────────────────┐
│              PHASE 1 — Fee Analysis         │
│                  (1 RPC call)               │
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
│  └─ apply EMA (alpha=0.3)                   │
│  └─ check for spike (3σ rule)               │
│  └─ spike? use EMA : use max(p75, EMA)      │
│                                             │
│  OUTPUT: microLamportsPerCU (one number)    │
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│           PHASE 2 — CU Optimization         │
│                  (1 RPC call)               │
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
│                  (no RPC call)              │
│                                             │
│  SolSyncClient.ts                           │
│  └─ ComputeBudgetProgram.setComputeUnitLimit│
│  └─ ComputeBudgetProgram.setComputeUnitPrice│
│  └─ prepend both to instruction list        │
│  └─ rebuild VersionedTransaction            │
│                                             │
│  OUTPUT: { tx, result }                     │
└─────────────────────────────────────────────┘
        │
        ▼
Developer signs and sends tx
```

**Total RPC calls per optimization: exactly 2**
**Total latency: ~130ms (30ms fee query + 100ms simulation)**

---

## Module Reference

### `feeSampler.ts` — Decision 1, Step 1

**What it does:** Queries the Solana RPC for recent priority fees paid on specific accounts. Filters out zero-fee slots (uncontested blocks). Caches results for 1.5 seconds to prevent rate limiting.

**Key exports:**
```typescript
FeeSlot                      // { slot: number, prioritizationFee: number }
samplePrioritizationFees()   // queries RPC, returns FeeSlot[]
getFallbackFees()            // returns safe defaults when RPC returns empty
```

**Critical detail:** Always pass **writable** accounts only. Read-only accounts create zero fee pressure and return misleading (lower) data.

**Cache key:** A comma-joined string of all account base58 addresses. Same accounts within 1.5s → cache hit, no RPC call.

---

### `percentileEngine.ts` — Decision 1, Step 2

**What it does:** Takes the raw `FeeSlot[]` array and computes statistical percentiles. Maps an urgency level to the correct percentile.

**Key exports:**
```typescript
FeeStats                // p50/p75/p90/p95/p99/mean/max/stddev/sampleCount
UrgencyLevel            // 'low' | 'medium' | 'high' | 'critical'
computeFeeStats()       // sorts fees, computes all percentiles
selectFeeByUrgency()    // low→p50, medium→p75, high→p90, critical→p95
```

**Percentile formula:**
```
index = ceil(percentile/100 × n) - 1
p90   = sortedFees[ceil(0.90 × n) - 1]
```

**Empty array handling:** Returns safe hardcoded defaults (p50=1000, p75=5000, p90=10000...) so the rest of the pipeline never crashes on empty data.

---

### `emaFilter.ts` — Decision 1, Step 3

**What it does:** Smooths the raw fee data using Exponential Moving Average to prevent chasing sudden spikes. Detects outliers using the 3-sigma rule.

**Key exports:**
```typescript
emaSmooth()          // applies EMA, returns smoothed fee
isSpike()            // returns true if latest fee is a 3σ outlier
selectSmoothedFee()  // combines both: spike? EMA : max(percentile, EMA)
```

**EMA formula:**
```
EMA_t = α × fee_t + (1 - α) × EMA_{t-1}
Default α = 0.3
```

**Spike detection:**
```
mean   = average of all fees
stddev = √(average of squared distances from mean)
spike  = latest > mean + 3 × stddev
```

**Why sort oldest-first before EMA:** EMA is time-ordered. Feeding it out of order produces a meaningless result. Always sort by `slot` ascending before the loop.

---

### `cuOptimizer.ts` — Decision 2

**What it does:** Simulates the transaction against the current chain state to find the exact Compute Units consumed. Adds a safety buffer and clamps to Solana's maximum.

**Key exports:**
```typescript
CUEstimate              // { consumed, recommended, bufferPct }
estimateComputeUnits()  // async — calls simulateTransaction
applyBuffer()           // pure math — consumed × (1 + buffer), clamped
```

**Two mandatory flags:**
```typescript
replaceRecentBlockhash: true  // prevents blockhash expiry failures
sigVerify: false              // transaction is unsigned at this point
```

**Buffer math:**
```
recommended = ceil(consumed × 1.15)
recommended = min(recommended, 1,400,000)
```

**Fallback:** If `unitsConsumed` is null (some RPC nodes don't return it), falls back to `200,000` — the Solana default.

---

### `SolSyncClient.ts` — Decision 3

**What it does:** The orchestrator. Calls fee analysis and CU optimization, builds the two `ComputeBudget` instructions, and prepends them to the original transaction.

**Key exports:**
```typescript
SolSyncClient           // main class
OptimizationResult      // full metadata returned alongside optimized tx
```

**Instruction ordering — critical:**
```
[0] SetComputeUnitLimit   ← MUST be first
[1] SetComputeUnitPrice   ← MUST be second
[2] ...original instructions
```

Solana's runtime reads the budget before executing any other instruction. Some validators enforce this order strictly.

**Transaction rebuild:**
```typescript
TransactionMessage.decompile(originalTx.message)
// → prepend budget instructions
// → preserve Address Lookup Tables
// → recompile to VersionedTransaction
```

---

## Key Design Decisions

### Why filter zero-fee slots?
Zero-fee slots are uncontested blocks — no one needed to pay a priority fee. Including them skews percentiles downward and causes underpricing during actual congestion.

### Why EMA with alpha=0.3?
Alpha=0.3 gives the last slot ~30% weight while history carries 70%. A single NFT mint spike won't cause SolSync to overpay on the next transaction. Alpha is configurable (0.1=very smooth, 0.6=very reactive).

### Why 15% CU buffer?
Programs with variable-length loops (iterating over token accounts, order books) consume slightly different CUs depending on current state. 15% covers this variance without significant overpay. Configurable via `cuBufferPct`.

### Why exactly 2 RPC calls?
One for fees (`getRecentPrioritizationFees`), one for simulation (`simulateTransaction`). The fee call is cached — repeated calls within 1.5s cost zero additional network time. Total latency target: under 300ms.

### Why writable accounts only?
Only writable accounts create transaction conflicts. Read-only accounts can be accessed by unlimited concurrent transactions simultaneously — they generate zero fee competition.

---

## Configuration Reference

```typescript
new SolSyncClient({
  connection:       Connection,    // required — your RPC connection
  urgency:          'medium',      // low|medium|high|critical → p50/p75/p90/p95
  emaAlpha:         0.3,           // EMA smoothing (0.1 slow → 0.6 reactive)
  cuBufferPct:      0.15,          // CU headroom above simulated usage
  maxMicroLamports: 1_000_000,     // fee ceiling cap
  spikeThreshold:   3,             // σ multiplier for spike detection
  cacheTtlMs:       1500,          // fee cache duration in ms
  cuFallback:       200_000,       // CU limit when simulation returns null
  feeFloor:         1_000,         // minimum µ◎/CU — never go below this
})
```

---

## Test Coverage

```
packages/core/src/
├── feeSampler.test.ts       4 tests  — cache, filtering, fallback, RPC mock
├── percentileEngine.test.ts 8 tests  — percentile math, edge cases, urgency map
├── emaFilter.test.ts        8 tests  — EMA convergence, spike detection, selector
└── cuOptimizer.test.ts      5 tests  — buffer math, clamping, edge cases
                            ──────────
                            25 tests total, all passing
```

---

## Dependencies

| Package            | Purpose                                         |
|--------------------|-------------------------------------------------|
| @solana/web3.js    | RPC, VersionedTransaction, ComputeBudgetProgram |
| typescript (strict)| Full type safety across all modules             |
| vitest             | Unit + integration tests                        |
| dotenv             | Load RPC URL from .env                          |
| pnpm workspaces    | Monorepo — core and sdk as separate packages    |
