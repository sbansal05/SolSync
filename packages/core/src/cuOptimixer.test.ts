import { describe, it, expect, vi } from "vitest";
import { estimateComputeUnits } from "./cuOptimizer";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { buildComputeBudgetInstructions } from "./cuOptimizer";
// Build a fake connection whose simulateTransaction returns whatever we tell it to
function mockConnection(simResult: {
  err: unknown;
  logs: string[] | null;
  unitsConsumed: number | null;
}) {
  return {
    simulateTransaction: vi.fn().mockResolvedValue({
      value: simResult,
    }),
  } as any;
}

// A fake transaction — we never actually send it, just pass it to the mock
const fakeTx = {} as any;

describe("estimateComputeUnits", () => {

  it("returns consumed and recommended when simulation succeeds", async () => {
    const conn = mockConnection({ err: null, logs: [], unitsConsumed: 150_000 });
    const result = await estimateComputeUnits(conn, fakeTx);

    expect(result.consumed).toBe(150_000);
    // 150,000 × 1.15 = 172,500
    expect(result.recommended).toBe(172_500);
    expect(result.bufferPct).toBe(0.15);
  });

  it("falls back to 200,000 when unitsConsumed is null", async () => {
    const conn = mockConnection({ err: null, logs: [], unitsConsumed: null });
    const result = await estimateComputeUnits(conn, fakeTx);

    expect(result.consumed).toBe(200_000);
    // 200,000 × 1.15 = 230,000
    expect(result.recommended).toBe(230_000);
  });

  it("throws with logs when simulation returns an error", async () => {
    const conn = mockConnection({
      err: { InstructionError: [0, "InsufficientFunds"] },
      logs: ["Program log: insufficient funds"],
      unitsConsumed: null,
    });

    // The thrown error message should contain the logs
    await expect(estimateComputeUnits(conn, fakeTx)).rejects.toThrow(
      "insufficient funds"
    );
  });

  it("clamps recommended to 1,400,000 even with buffer applied", async () => {
    // 1,300,000 × 1.15 = 1,495,000 — should be clamped to 1,400,000
    const conn = mockConnection({ err: null, logs: [], unitsConsumed: 1_300_000 });
    const result = await estimateComputeUnits(conn, fakeTx);

    expect(result.recommended).toBe(1_400_000);
  });

  it("uses a custom buffer percentage when provided", async () => {
    const conn = mockConnection({ err: null, logs: [], unitsConsumed: 100_000 });
    const result = await estimateComputeUnits(conn, fakeTx, 0.20);

    // 100,000 × 1.20 = 120,000
    expect(result.recommended).toBe(120_000);
    expect(result.bufferPct).toBe(0.20);
  });

});


describe("buildComputeBudgetInstructions", () => {

  it("returns exactly 2 instructions", () => {
    const result = buildComputeBudgetInstructions(5000, 200_000);
    expect(result).toHaveLength(2);
  });

  it("first instruction is setComputeUnitLimit, second is setComputeUnitPrice", () => {
    const result = buildComputeBudgetInstructions(5000, 200_000);

    // Build the same instructions independently — if our function did its
    // job right, the encoded data bytes should be identical
    const expectedLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const expectedPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 });

    expect(result[0].data.equals(expectedLimit.data)).toBe(true);
    expect(result[1].data.equals(expectedPrice.data)).toBe(true);
  });

  it("both instructions target the ComputeBudgetProgram", () => {
    const result = buildComputeBudgetInstructions(5000, 200_000);

    expect(result[0].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(result[1].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
  });

  it("clamps cuLimit of 0 up to 1, not 0", () => {
    const result = buildComputeBudgetInstructions(5000, 0);
    const expectedAtFloor = ComputeBudgetProgram.setComputeUnitLimit({ units: 1 });

    expect(result[0].data.equals(expectedAtFloor.data)).toBe(true);
  });

  it("clamps cuLimit above 1,400,000 down to the max", () => {
    const result = buildComputeBudgetInstructions(5000, 2_000_000);
    const expectedAtCap = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

    expect(result[0].data.equals(expectedAtCap.data)).toBe(true);
  });

  it("clamps a negative priority fee up to 0", () => {
    const result = buildComputeBudgetInstructions(-500, 200_000);
    const expectedZeroFee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 });

    expect(result[1].data.equals(expectedZeroFee.data)).toBe(true);
  });

});