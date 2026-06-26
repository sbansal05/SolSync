import { describe, it, expect, vi, beforeEach } from "vitest";
import { samplePrioritizationFees, _resetCache } from "./feeSampler";
import { PublicKey } from "@solana/web3.js";

// We create a fake connection object instead of a real one.
// Real connections hit the network — unit tests must never do that.
// We cast it to `any` so TypeScript doesn't complain about the fake.
function makeMockConnection(feeEntries: { slot: number; prioritizationFee: number }[]) {
  return {
    getRecentPrioritizationFees: vi.fn().mockResolvedValue(feeEntries),
  } as any;
}

const accounts = [new PublicKey("11111111111111111111111111111111")];

// Reset the cache before every test so they don't interfere with each other
beforeEach(() => {
  _resetCache();
});

describe("samplePrioritizationFees", () => {

  it("returns empty array when RPC returns empty", async () => {
    const conn = makeMockConnection([]);
    const result = await samplePrioritizationFees(conn, accounts);
    expect(result).toEqual([]);
  });

  it("filters out zero-fee slots", async () => {
    const conn = makeMockConnection([
      { slot: 1, prioritizationFee: 0 },    // should be removed
      { slot: 2, prioritizationFee: 5000 }, // should stay
      { slot: 3, prioritizationFee: 0 },    // should be removed
      { slot: 4, prioritizationFee: 8000 }, // should stay
    ]);

    const result = await samplePrioritizationFees(conn, accounts);

    expect(result).toHaveLength(2);
    // None of the returned entries should have a zero fee
    result.forEach(entry => {
      expect(entry.prioritizationFee).toBeGreaterThan(0);
    });
  });

  it("returns cached result on second call without hitting RPC again", async () => {
    const conn = makeMockConnection([
      { slot: 1, prioritizationFee: 5000 },
    ]);

    await samplePrioritizationFees(conn, accounts);
    await samplePrioritizationFees(conn, accounts); // second call

    // getRecentPrioritizationFees should have only been called once
    expect(conn.getRecentPrioritizationFees).toHaveBeenCalledTimes(1);
  });

  it("fetches fresh data after cache expires", async () => {
    vi.useFakeTimers();

    const conn = makeMockConnection([
      { slot: 1, prioritizationFee: 5000 },
    ]);

    await samplePrioritizationFees(conn, accounts);

    // Advance time by 2 seconds — past the 1.5s cache TTL
    vi.advanceTimersByTime(2000);

    await samplePrioritizationFees(conn, accounts);

    // Should have called RPC twice — once fresh, once after expiry
    expect(conn.getRecentPrioritizationFees).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

});