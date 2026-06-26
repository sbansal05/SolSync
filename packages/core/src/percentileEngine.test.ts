import { describe, it, expect } from "vitest";
import { computeFeeStats, selectFeeByUrgency } from "./percentileEngine";

// Helper to turn a plain number array into FeeSlot objects
function toSlots(fees: number[]) {
  return fees.map((fee, i) => ({ slot: 300000 + i, prioritizationFee: fee }));
}

describe("computeFeeStats", () => {

  it("computes correct percentiles for known input", () => {
    const slots = toSlots([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
    const stats = computeFeeStats(slots);

    // With 10 values, p90 index = ceil(0.9 * 10) - 1 = 8 → value is 9000
    expect(stats.p90).toBe(9000);
    expect(stats.max).toBe(10000);
    expect(stats.sampleCount).toBe(10);
  });

  it("returns non-zero fallback defaults for empty input", () => {
    const stats = computeFeeStats([]);

    // These should be sensible defaults, not zero
    expect(stats.p50).toBeGreaterThan(0);
    expect(stats.p75).toBeGreaterThan(0);
    expect(stats.p90).toBeGreaterThan(0);
    expect(stats.sampleCount).toBe(0);
  });

  it("p50 <= p75 <= p90 <= p95 <= p99 always holds", () => {
    const slots = toSlots([500, 600, 700, 800, 1000, 1200, 5000, 50000, 200000, 500000]);
    const stats = computeFeeStats(slots);

    expect(stats.p50).toBeLessThanOrEqual(stats.p75);
    expect(stats.p75).toBeLessThanOrEqual(stats.p90);
    expect(stats.p90).toBeLessThanOrEqual(stats.p95);
    expect(stats.p95).toBeLessThanOrEqual(stats.p99);
  });

  it("CV is higher for a volatile market than a stable one", () => {
    const stable   = toSlots([9000, 9100, 9050, 9200, 9000, 9100, 9150, 9050, 9000, 9100]);
    const volatile = toSlots([500, 600, 700, 800, 1000, 1200, 5000, 50000, 200000, 500000]);

    const stableStats   = computeFeeStats(stable);
    const volatileStats = computeFeeStats(volatile);

    expect(volatileStats.cv).toBeGreaterThan(stableStats.cv);
  });

});

describe("selectFeeByUrgency", () => {

  const slots = toSlots([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
  const stats = computeFeeStats(slots);

  it("low maps to p50", () => {
    expect(selectFeeByUrgency(stats, "low")).toBe(stats.p50);
  });

  it("medium maps to p75", () => {
    expect(selectFeeByUrgency(stats, "medium")).toBe(stats.p75);
  });

  it("high maps to p90", () => {
    expect(selectFeeByUrgency(stats, "high")).toBe(stats.p90);
  });

  it("critical maps to p95", () => {
    expect(selectFeeByUrgency(stats, "critical")).toBe(stats.p95);
  });

});