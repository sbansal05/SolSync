import { FeeSlot } from "./feeSampler";
export interface FeeStats {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
    mean: number;
    max: number;
    stddev: number;
    cv: number;
    sampleCount: number
}
export type UrgencyLevel =  "low" | "medium" | "high" | "critical";

export function computeFeeStats(slots: FeeSlot[]) {
     type fee = FeeSlot['prioritizationFee'];
     const fees: fee[] = slots.map(slot => slot.prioritizationFee);

     fees.sort((a, b) => a-b);

     if(fees.length == 0) {
        return { p50: 1000, p75: 5000, p90: 10000, p95: 25000, p99: 50000, 
             mean: 1000, max: 1000, stddev: 0, cv: 0, sampleCount: 0};
     }

     const p50 = getPercentile(fees, 50);
     const p75 = getPercentile(fees, 75);
     const p90 = getPercentile(fees, 90);
     const p95 = getPercentile(fees, 95);
     const p99 = getPercentile(fees, 99);
     
     const sampleCount: number = fees.length;
     const max: number = Math.max(...fees);
     const mean = fees.reduce((a, b) => a + b, 0) / fees.length;

     const variance = fees.reduce((sum, f) => sum + (f - mean) ** 2, 0) / fees.length;
     const stdDev = Math.sqrt(variance);
     const cv: number = mean === 0 ? 0 : (stdDev / mean);

     return { p50, p75, p90, p95, p99, max, sampleCount, mean,stddev: stdDev,cv};
}

export function selectFeeByUrgency(stats: FeeStats, urgency: UrgencyLevel): number{

    const feeByUrgency: Record<UrgencyLevel , number>  = {
        "low": stats.p50,
        "medium": stats.p75,
        "high": stats.p90,
        "critical": stats.p95

    };

    return feeByUrgency[urgency];
}

function getPercentile(sortedArr: number[], percentile: number):number {
    if(sortedArr.length == 0) return 0;
    
    const index = Math.ceil((percentile/100) * sortedArr.length)- 1;
    const lowerIndex = Math.floor(index);
    const decimal = index - lowerIndex;

    if (lowerIndex >= sortedArr.length  - 1 || decimal === 0) {
        return sortedArr[lowerIndex];
    }

    return sortedArr[lowerIndex] + decimal * (sortedArr[lowerIndex + 1] - sortedArr[lowerIndex]);

}
