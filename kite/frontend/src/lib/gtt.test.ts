import { describe, expect, it } from "vitest";
import { roundToTick } from "./gtt";

describe("roundToTick", () => {
  it("rounds to tick multiples without float noise", () => {
    expect(roundToTick(3903.3, 0.1)).toBe(3903.3);
    expect(roundToTick(3903.3, 0.1, 95)).toBe(3708.1); // 3708.135 -> 3708.1
    expect(roundToTick(101.03, 0.05)).toBe(101.05);
    expect(roundToTick(101.02, 0.05)).toBe(101.0);
    expect(roundToTick(0.1 + 0.2, 0.05)).toBe(0.3);
    expect(roundToTick(250.005, 0.01)).toBe(250.01);
  });
  it("returns null for missing prices or ticks", () => {
    expect(roundToTick(NaN, 0.05)).toBeNull();
    expect(roundToTick(100, 0)).toBeNull();
  });
});
