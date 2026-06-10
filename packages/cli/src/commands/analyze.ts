import { Command } from "commander";
import { Connection, PublicKey } from "@solana/web3.js";
import chalk from "chalk";
import { samplePrioritizationFees } from "@solsync/core/src/feeSampler";
import { computeFeeStats, selectFeeByUrgency } from "@solsync/core/src/percentileEngine";
import type { UrgencyLevel } from "@solsync/core/src/percentileEngine";

export function registerAnalyze(program: Command) {
    program
        .command("analyze")
        .description("Analyze the current priority fee market for specific accounts")
        .requiredOption("--rpc <url>", "Solana RPC endpoint URL")
        .requiredOption("--accounts <keys...>", "Writable account addresses to query")
        .option("--urgency <level>", "low | medium | high | critical", "medium")
        .option("--json", "Output raw json instead of formatted table")
        .action(async (opts) => {
            try {
                const connection = new Connection(opts.rpc, "confirmed");

                const accounts: PublicKey[] = opts.accounts.map(
                    (addr: string) => new PublicKey(addr)
                );

                if (!opts.json) {
                    process.stdout.write(chalk.gray("Fetching fee data..."));
                }

                const slots = await samplePrioritizationFees(connection, accounts);

                if(!opts.json) {
                    process.stdout.write(chalk.green(" done\n\n"));
                }

                const stats = computeFeeStats(slots);
                const urgency = opts.urgency as UrgencyLevel;
                const recommended = selectFeeByUrgency(stats, urgency);
                
                if (opts.json) {
                    console.log(JSON.stringify({ stats, recommended, urgency }, null, 2));
                    return;
                }


                console.log(chalk.cyan.bold(" SolSync Fee Analysis"));
                console.log(chalk.gray(" " + "-".repeat(40)));
                console.log(
                    `${chalk.white("Accounts queried")} ${chalk.yellow(accounts.length.toString())}`
                );
                console.log(
                    ` ${chalk.white("Samples found" )} ${chalk.yellow(stats.sampleCount.toString())}`
                );
                console.log(chalk.gray(" " + "-".repeat(40)));
                console.log( `  ${chalk.white("p50 (low)      ")}  ${stats.p50.toLocaleString()} µ◎/CU`);
                console.log(`  ${chalk.white("p75 (medium)   ")}  ${stats.p75.toLocaleString()} µ◎/CU`);
                console.log( `  ${chalk.white("p90 (high)     ")}  ${stats.p90.toLocaleString()} µ◎/CU`);
                console.log(`  ${chalk.white("p95 (critical) ")}  ${stats.p95.toLocaleString()} µ◎/CU`);
                console.log(chalk.gray("  " + "─".repeat(40)));
                console.log(`  ${chalk.white("Recommended    ")}  ${chalk.green.bold(recommended.toLocaleString())} µ◎/CU  ${chalk.gray("(" + urgency + ")")}`);
                console.log();
            } catch (err) {
                console.error(chalk.red("Error: ") + (err as Error).message);
                process.exit(1);
            }
        });
}