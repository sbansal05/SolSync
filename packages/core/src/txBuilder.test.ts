import { describe, it, expect, vi } from "vitest";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { buildOptimizedTransaction } from "./txBuilder";
import { buildComputeBudgetInstructions } from "./cuOptimizer";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

// Builds a real, valid VersionedTransaction with one SystemProgram
// transfer instruction and NO address lookup tables. This doesn't
// touch the network — everything here is generated locally.
function buildFakeTransaction() {
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;

  // We just need a 32-byte base58 string in the right shape —
  // a generated public key happens to be exactly that format,
  // so it's a convenient stand-in for a real blockhash in tests.
  const fakeBlockhash = Keypair.generate().publicKey.toBase58();

  const transferIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: recipient,
    lamports: 1000,
  });

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: fakeBlockhash,
    instructions: [transferIx],
  }).compileToV0Message(); // no ALTs

  const tx = new VersionedTransaction(message);

  return { tx, payer, fakeBlockhash };
}

// Since our fake transaction has no ALTs, getAddressLookupTable
// should never even be called. We mock it anyway so we can assert that.
function mockConnection() {
  return {
    getAddressLookupTable: vi.fn(),
  } as any;
}

// ─────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────

describe("buildOptimizedTransaction", () => {

  it("places budget instructions at index 0 and 1, original after", async () => {
    const { tx } = buildFakeTransaction();
    const connection = mockConnection();

    const result = await buildOptimizedTransaction(connection, tx, 5000, 200_000);

    // Decompile the RESULT to inspect what actually got built
    const decompiled = TransactionMessage.decompile(result.message);

    expect(decompiled.instructions).toHaveLength(3); // limit + price + transfer
    expect(decompiled.instructions[0].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(decompiled.instructions[1].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(decompiled.instructions[2].programId.equals(SystemProgram.programId)).toBe(true);
  });

  it("the two budget instructions contain the correct fee and CU values", async () => {
    const { tx } = buildFakeTransaction();
    const connection = mockConnection();

    const result = await buildOptimizedTransaction(connection, tx, 5000, 200_000);
    const decompiled = TransactionMessage.decompile(result.message);

    // Build what we EXPECT independently, then compare the raw data bytes —
    // same technique as the cuOptimizer tests from Day 9
    const expected = buildComputeBudgetInstructions(5000, 200_000);

    expect(decompiled.instructions[0].data.equals(expected[0].data)).toBe(true);
    expect(decompiled.instructions[1].data.equals(expected[1].data)).toBe(true);
  });

  it("preserves the original payer and blockhash", async () => {
    const { tx, payer, fakeBlockhash } = buildFakeTransaction();
    const connection = mockConnection();

    const result = await buildOptimizedTransaction(connection, tx, 5000, 200_000);
    const decompiled = TransactionMessage.decompile(result.message);

    expect(decompiled.payerKey.equals(payer.publicKey)).toBe(true);
    expect(decompiled.recentBlockhash).toBe(fakeBlockhash);
  });

  it("never calls getAddressLookupTable when there are no ALTs", async () => {
    const { tx } = buildFakeTransaction();
    const connection = mockConnection();

    await buildOptimizedTransaction(connection, tx, 5000, 200_000);

    expect(connection.getAddressLookupTable).not.toHaveBeenCalled();
  });

});