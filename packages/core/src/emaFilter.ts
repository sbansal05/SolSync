import type { FeeSlot } from "./feeSampler";
import { computeFeeStats } from "./percentileEngine";
export function emaSmooth(
    slots: FeeSlot[],
    alpha = 0.3
): number {

    if(slots.length == 0) {
        return 1000; //floor fee
    }
    //by slot asc(oldest slot first)
    const sorted = [...slots].sort((a, b) => a.slot - b.slot)

    let ema = sorted[0].prioritizationFee;

    for (let i = 1; i < sorted.length; i++) {
        const fee = sorted[i].prioritizationFee;
        ema = alpha * fee + (1 - alpha) * ema;

    }

    return Math.ceil(ema)

}

export function isSpike(
    slots: FeeSlot[],
    threshold = 3
): boolean {

    if (slots.length < 10) return false;

    const sorted = [...slots].sort((a, b) => a.slot - b.slot);
    const fees = sorted.map(s => s.prioritizationFee)

    const stats = computeFeeStats(sorted);
    const mean = stats.mean;
    const stddev = stats.stddev;

    const latest = fees[fees.length - 1];
    return latest > (mean + threshold * stddev)
}

export function selectSmoothedFee(
    slots: FeeSlot[],
    rawFee: number, //percentile fee from day 3
    alpha = 0.3,
    threshold =  3
): number {

    const spike = isSpike(slots, threshold);

    if (spike) {

        const safeSlots = [...slots].sort((a, b) => a.slot - b.slot).slice(0, -1);
        return emaSmooth(safeSlots, alpha)
    }
    const smoothed = emaSmooth(slots, alpha)
    return Math.max(rawFee, smoothed);
}