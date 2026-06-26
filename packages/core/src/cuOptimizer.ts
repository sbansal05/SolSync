import { ComputeBudgetProgram, Connection, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";

export interface CUEstimate {
    consumed: number,
    recommended: number,
    bufferPct: number
}

const MAX_COMPUTE_LIMITS = 1_400_000;
const FALLBACK_CU = 200_000;

export async function estimateComputeUnits(
    connection: Connection, 
    transaction: VersionedTransaction, 
    bufferPct = 0.15) : Promise<CUEstimate> {

        const sim = await connection.simulateTransaction(transaction, {
            replaceRecentBlockhash: true,
            sigVerify: false
        });

        if(sim.value.err) {
            const logs = sim.value.logs?.join("\n") ?? "no logs available";
            throw new Error (
                `Transaction simulation failed:\n${JSON.stringify(sim.value.err)}\n\nLogs:\n${logs}`
            );

        }

        const consumed = sim.value.unitsConsumed ?? FALLBACK_CU;

        const recommended = Math.min(
            Math.ceil(consumed * (1 + bufferPct)),
            MAX_COMPUTE_LIMITS
        );

        return { consumed, recommended, bufferPct}
}

export function buildComputeBudgetInstructions(
    priorityFeePerCU: number,
    cuLimit: number
): TransactionInstruction[] {

    const safeLimit = Math.min(Math.max(1, cuLimit), MAX_COMPUTE_LIMITS);
    const safeFee = Math.max(0, priorityFeePerCU)
    const limit  = ComputeBudgetProgram.setComputeUnitLimit({ units: safeLimit})
    const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: safeFee})

    let transactionInstruction= [limit, price];
    return transactionInstruction;


}