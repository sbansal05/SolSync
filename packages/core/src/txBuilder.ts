import { AddressLookupTableAccount, Connection, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { buildComputeBudgetInstructions } from "./cuOptimizer";

export async function buildOptimizedTransaction(
    connection: Connection,
    originalTx: VersionedTransaction,
    priorityFeePerCU: number,
    cuLimit: number,
): Promise<VersionedTransaction> {

    const lookupTableAccounts: AddressLookupTableAccount[] = [];

    for (const lookup of originalTx.message.addressTableLookups) {
        const result = await connection.getAddressLookupTable(lookup.accountKey);
        if (result.value) {
            lookupTableAccounts.push(result.value);
        }
    }

    const decompiled = TransactionMessage.decompile(originalTx.message, {
        addressLookupTableAccounts: lookupTableAccounts,
    });

    const budgetInstructions = buildComputeBudgetInstructions(priorityFeePerCU, cuLimit);

    const finalInstructions = [
        ...budgetInstructions,
        ...decompiled.instructions,
    ];

    const newMessage  = new TransactionMessage({
        payerKey: decompiled.payerKey,
        recentBlockhash: decompiled.recentBlockhash,
        instructions: finalInstructions
    }).compileToV0Message(lookupTableAccounts);


    return new VersionedTransaction(newMessage);


}