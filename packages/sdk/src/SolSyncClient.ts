import { samplePrioritizationFees } from "@solsync/core/src/feeSampler";
import { computeFeeStats, selectFeeByUrgency, UrgencyLevel, FeeStats} from "@solsync/core/src/percentileEngine";
import { selectSmoothedFee, isSpike } from "@solsync/core/src/emaFilter";
import { estimateComputeUnits } from "@solsync/core/src/cuOptimizer";
import { buildOptimizedTransaction } from "@solsync/core/src/txBuilder";
import { ComputeBudgetProgram, Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";

export interface SolSyncClientConfig {
    connection: Connection;
    urgency?: UrgencyLevel;
    emaAlpha?: number;
    cuBufferPct?: number;
    maxMicroLamports?: number;
}

const FEE_FLOOR = 1000;

export interface OptimizationResult {
    priorityFeePerCU: number;
    computeUnitLimit: number;
    stats: FeeStats;
    spikeDetected: boolean;
    urgency: UrgencyLevel;
}

export interface AnalyzeResult {
    stats: FeeStats;
    recommended: number;
    spikeDetected: boolean;
}

export class SolSyncClient {
    private connection: Connection;
    private urgency: UrgencyLevel;
    private emaAlpha: number;
    private cuBufferPct: number;
    private maxMicroLamports: number;

    constructor(config: SolSyncClientConfig) {
        this.connection = config.connection;
        this.urgency = config.urgency ?? "medium";
        this.emaAlpha = config.emaAlpha ?? 0.3;
        this.cuBufferPct = config.cuBufferPct ?? 0.15;
        this.maxMicroLamports = config.maxMicroLamports ?? 5_000_000;
    }

    async optimize(
        originalTx: VersionedTransaction,
        writableAccounts: PublicKey[],
        opts?: { urgency?: UrgencyLevel }
    ): Promise<{ tx: VersionedTransaction; result: OptimizationResult}> {

        const urgency = opts?.urgency ?? this.urgency;

        const slots  = await samplePrioritizationFees(this.connection, writableAccounts);
        const stats = computeFeeStats(slots);
        const rawFee = selectFeeByUrgency(stats, urgency);
        const smoothedFee = selectSmoothedFee(slots, rawFee, this.emaAlpha);


        const finalFee = Math.max(FEE_FLOOR, Math.min(smoothedFee, this.maxMicroLamports));
        
        const preliminaryTx = await buildOptimizedTransaction(
            this.connection,
            originalTx,
            finalFee,
            200_000
        )
        const CUEstimate = await estimateComputeUnits(
            this.connection,
            preliminaryTx,
            this.cuBufferPct
        );

        const tx = await buildOptimizedTransaction(
            this.connection,
            originalTx,
            finalFee,
            CUEstimate.recommended
        );

        const result : OptimizationResult = {
            priorityFeePerCU: finalFee,
            computeUnitLimit: CUEstimate.recommended,
            stats,
            spikeDetected: isSpike(slots),
            urgency,
        };

        return { tx, result};
    }

    async analyzeOnly(writableAccounts: PublicKey[]): Promise<AnalyzeResult> {
        const slots = await samplePrioritizationFees(this.connection, writableAccounts);
        const stats = computeFeeStats(slots);
        const rawFee = selectFeeByUrgency(stats, this.urgency);
        const recommended = Math.max(
            FEE_FLOOR,
            Math.min(selectSmoothedFee(slots, rawFee, this.emaAlpha), this.maxMicroLamports)
        );

        return { stats, recommended, spikeDetected: isSpike(slots) };

    }

    async estimateCost(tx: VersionedTransaction): Promise<number> {
        const message = tx.message;
        let units: number | null = null;
        let microLamports: bigint | null = null;

        for (const ix of message.compiledInstructions) {
            const programId = message.staticAccountKeys[ix.programIdIndex];
            if (!programId.equals(ComputeBudgetProgram.programId)) continue;

            const data = Buffer.from(ix.data);
            const discriminator = data[0];

            if (discriminator === 2) {
                units = data.readUInt32LE(1);
            }

            if (discriminator === 3) {
                microLamports = data.readBigUInt64LE(1);
            }
        }

        if (units === null || microLamports === null) {
            throw new Error(
                "Transaction has no ComputeBudget instructions - did you build it with .optimize first?"
            );
        }

        const totalLamports = (Number(microLamports) * units) / 1_000_000;
        return totalLamports / 1_000_000_000;

    }
}