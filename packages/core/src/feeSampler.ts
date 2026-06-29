import {Connection, PublicKey} from '@solana/web3.js'

export interface FeeSlot {
    slot: number;
    prioritizationFee: number;
}
interface Cache {
    key: string;
    data: FeeSlot[];
    fetchedAt: number;
}

let _cache : Cache | null = null;

const CACHE_TTL_MS = 1500;

export async function samplePrioritizationFees(
    connection: Connection,
    accountKeys: PublicKey[]
): Promise<FeeSlot[]> {

    const cacheKey = accountKeys
        .map((k) => k.toBase58())
        .sort()
        .join(",");
    
    const now = Date.now();
    if (
        _cache !== null &&
        _cache.key === cacheKey &&
        now - _cache.fetchedAt < CACHE_TTL_MS
    ) {
        console.log("[feeSampler] Cache hit — skipping RPC call");
        return _cache.data;
    }

    console.log("[feeSampler] Fetching from RPC...");

    const raw = await connection.getRecentPrioritizationFees({
        lockedWritableAccounts: accountKeys
    });

    const data = raw
        .filter((f) => f.prioritizationFee > 0) 
        .map((f) => ({
            slot: f.slot,
            prioritizationFee: f.prioritizationFee
        }));

    _cache = {
        key: cacheKey,
        data: data,
        fetchedAt: Date.now(),
    };

    return data;
}
export function _resetCache() {
  _cache = null;
}
