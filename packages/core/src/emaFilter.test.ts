import { describe, it, expect } from "vitest";
import { emaSmooth, isSpike } from "./emaFilter";

function toSlots(fees: number[]) {
  return fees.map((fee, i) => ({ slot: 300000 + i, prioritizationFee: fee }));
}

describe("emaSmooth", () => {

  it("returns floor fee of 1000 for empty input", () => {
    expect(emaSmooth([])).toBe(1000);
  });

  it("returns the only value when there is one slot", () => {
    const slots = toSlots([5000]);
    expect(emaSmooth(slots)).toBe(5000);
  });

  it("result is always a whole number (Math.ceil applied)", () => {
    const slots = toSlots([1001, 1002, 1003, 1004, 1005]);
    const result = emaSmooth(slots);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("weights recent slots more than old ones", () => {
    // Slots start low and end high — EMA should be pulled toward the high end
    const slots = toSlots([1000, 1000, 1000, 1000, 50000]);
    const result = emaSmooth(slots, 0.9); // high alpha = heavily weights latest
    expect(result).toBeGreaterThan(1000);
  });

});

describe("isSpike", () => {

  it("returns false when fewer than 10 samples", () => {
    const slots = toSlots([5000, 6000, 5500]);
    expect(isSpike(slots)).toBe(false);
  });

  it("returns false for a stable market", () => {
    // All fees close together — no outlier
    const slots = toSlots([9000, 9100, 9050, 9200, 9000, 9100, 9150, 9050, 9000, 9100]);
    expect(isSpike(slots)).toBe(false);
  });

  it("returns true when the latest slot is a 3σ outlier", () => {
    // 9 stable slots, then a massive spike on the last one
    const stableValues = [1000, 1100, 900, 1050, 950, 1000, 1100, 900, 1000];
    const slots = toSlots([...stableValues, 500000]); // 500k is way beyond 3σ
    expect(isSpike(slots)).toBe(true);
  });

  it("returns false when all fees are the same (stddev is zero)", () => {
    // If stddev is 0, mean + 3σ = mean, so latest == mean is not > mean
    const slots = toSlots([5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]);
    expect(isSpike(slots)).toBe(false);
  });

});