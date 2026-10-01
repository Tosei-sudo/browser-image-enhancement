export declare class Quantizer {
    /** thresholds[k] = s_k; thresholds[255] = +Infinity as a sentinel. */
    private readonly thresholds;
    /** Code for inputs below the first finite threshold (count of -Infinity thresholds). */
    private readonly floor;
    /** Code for inputs at or above the last finite threshold. */
    private readonly lo;
    private readonly hi;
    private readonly ceil;
    private readonly scale;
    private readonly base;
    /** `F` must be non-decreasing. Omit it for plain linear -> 8-bit rounding. */
    constructor(F?: (v: number) => number);
    /** Exact `quantize(F(v))`. NaN gives the lowest reachable code. */
    quantize(v: number): number;
}
//# sourceMappingURL=quantizer.d.ts.map