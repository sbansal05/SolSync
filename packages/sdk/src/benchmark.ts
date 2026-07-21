import { Connection, PublicKey } from "@solana/web3.js";
import { SolSyncClient } from "./SolSyncClient";

const HOT_ACCOUNTS = [
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter v6
];

// More realistic flat default — what competitive dApps actually use
const FLAT_DEFAULT = 100_000;

async function main() {
  const connection = new Connection(
    "https://api.mainnet-beta.solana.com",
    "confirmed"
  );

  const client = new SolSyncClient({
    connection,
    urgency: "medium",
    maxMicroLamports: 50_000_000, // raised ceiling so real market data isn't clamped
  });

  const accounts = HOT_ACCOUNTS.map((a) => new PublicKey(a));

  console.log("Running 20 analyze calls against mainnet-beta...");
  console.log(`Flat default baseline: ${FLAT_DEFAULT.toLocaleString()} µ◎/CU\n`);

  const results: Array<{
    recommended: number;
    p75: number;
    p90: number;
    sampleCount: number;
    flatVsSolfi: number;
    spikeDetected: boolean;
  }> = [];

  for (let i = 0; i < 20; i++) {
    try {
      const { stats, recommended, spikeDetected } =
        await client.analyzeOnly(accounts);

      // Positive = flat is cheaper than SolFi (SolFi overshooting)
      // Negative = flat would miss inclusion (SolFi is correctly higher)
      const flatVsSolfi = ((FLAT_DEFAULT - recommended) / recommended) * 100;

      results.push({
        recommended,
        p75: stats.p75,
        p90: stats.p90,
        sampleCount: stats.sampleCount,
        flatVsSolfi,
        spikeDetected,
      });

      console.log(
        `Run ${String(i + 1).padStart(2)}: ` +
        `rec=${String(recommended.toLocaleString()).padStart(12)} µ◎/CU  ` +
        `p75=${String(stats.p75.toLocaleString()).padStart(12)} µ◎/CU  ` +
        `samples=${String(stats.sampleCount).padStart(3)}  ` +
        `flat_vs_solfi=${flatVsSolfi.toFixed(1).padStart(8)}%  ` +
        `spike=${spikeDetected}`
      );

      // Delay to avoid rate limiting on public RPC
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.log(`Run ${String(i + 1).padStart(2)}: ERROR — ${(err as Error).message}`);
    }
  }

  if (results.length === 0) {
    console.log("No successful runs — check your RPC connection.");
    return;
  }

  // Summary stats
  const avgRecommended =
    results.reduce((a, b) => a + b.recommended, 0) / results.length;
  const avgP75 =
    results.reduce((a, b) => a + b.p75, 0) / results.length;
  const avgFlatVsSolfi =
    results.reduce((a, b) => a + b.flatVsSolfi, 0) / results.length;
  const spikes = results.filter((r) => r.spikeDetected).length;
  const runsWhereFlatMissesInclusion = results.filter(
    (r) => FLAT_DEFAULT < r.recommended
  ).length;

  console.log("\n─────────────────────────────────────────────────────");
  console.log("SUMMARY");
  console.log("─────────────────────────────────────────────────────");
  console.log(`Runs completed               : ${results.length}/20`);
  console.log(`Avg recommended fee (SolFi)  : ${Math.round(avgRecommended).toLocaleString()} µ◎/CU`);
  console.log(`Avg p75 from market          : ${Math.round(avgP75).toLocaleString()} µ◎/CU`);
  console.log(`Flat default baseline        : ${FLAT_DEFAULT.toLocaleString()} µ◎/CU`);
  console.log(`Flat vs SolFi (avg)          : ${avgFlatVsSolfi.toFixed(1)}%`);
  console.log(`Runs flat would miss inclusion: ${runsWhereFlatMissesInclusion}/20`);
  console.log(`Spike events detected        : ${spikes}/20`);
  console.log("─────────────────────────────────────────────────────");

  if (avgFlatVsSolfi < 0) {
    console.log(
      `\nConclusion: The flat ${FLAT_DEFAULT.toLocaleString()} µ◎/CU default would miss` +
      ` inclusion on ${runsWhereFlatMissesInclusion}/20 runs.` +
      ` SolFi correctly tracks real market pressure.`
    );
  } else {
    console.log(
      `\nConclusion: Market was calm during this benchmark.` +
      ` SolFi recommendation averaged ${Math.abs(avgFlatVsSolfi).toFixed(1)}% below flat default.`
    );
  }

}

main().catch(console.error);