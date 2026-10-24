import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVwapBandsFromCandles, computeDailyVwapBars } from "./vwap.ts";
import type { CandleData } from "./klines.ts";

test("computeVwapBandsFromCandles returns null on empty or single bar input", () => {
  assert.equal(computeVwapBandsFromCandles([]), null);
  assert.equal(
    computeVwapBandsFromCandles([{ time: 1000, open: 100, high: 105, low: 95, close: 100, volume: 50 }]),
    null,
  );
});

test("computeVwapBandsFromCandles accurately calculates VWAP and Fibonacci multiples", () => {
  const baseTime = 1700000000;
  const candles: CandleData[] = [];
  for (let i = 0; i < 20; i++) {
    candles.push({
      time: baseTime + i * 60,
      open: 2000 + i * 2,
      high: 2005 + i * 2,
      low: 1995 + i * 2,
      close: 2002 + i * 2,
      volume: 100,
    });
  }

  const res = computeVwapBandsFromCandles(candles);
  assert.ok(res !== null);
  assert.ok(Number.isFinite(res.vwap));
  assert.ok(res.vwap > 2000);
  assert.ok(res.upper1 > res.vwap);
  assert.ok(res.lower1 < res.vwap);
  assert.ok(res.fibUpper2 > res.fibUpper1);
  assert.ok(res.fibUpper1 > res.upper1);
  assert.ok(res.fibLower2 < res.fibLower1);
  assert.ok(res.fibLower1 < res.lower1);

  // Exact symmetry check: (fibUpper1 - vwap) should equal 1.618 * sigmaAdj
  const sigmaAdj = res.sigmaAdj!;
  assert.ok(sigmaAdj > 0);
  assert.ok(Math.abs((res.fibUpper1 - res.vwap) - 1.618 * sigmaAdj) < 1e-4);
  assert.ok(Math.abs((res.fibUpper2 - res.vwap) - 2.618 * sigmaAdj) < 1e-4);
  assert.ok(Math.abs((res.vwap - res.fibLower1) - 1.618 * sigmaAdj) < 1e-4);
  assert.ok(Math.abs((res.vwap - res.fibLower2) - 2.618 * sigmaAdj) < 1e-4);
});

test("computeDailyVwapBars resets on new day boundary", () => {
  const day1Start = 1700000000 - (1700000000 % 86400); // exact 00:00 UTC
  const day2Start = day1Start + 86400;

  const candles: CandleData[] = [
    { time: day1Start + 60, open: 2000, high: 2005, low: 1995, close: 2000, volume: 100 },
    { time: day1Start + 120, open: 2010, high: 2015, low: 2005, close: 2010, volume: 100 },
    // Day 2 first bar: large price jump
    { time: day2Start + 60, open: 2100, high: 2105, low: 2095, close: 2100, volume: 100 },
  ];

  const bars = computeDailyVwapBars(candles);
  assert.equal(bars.length, 3);
  // Day 1 second bar VWAP is average of 2000 and 2010 -> 2005
  assert.ok(Math.abs(bars[1].vwap - 2005) < 1e-4);
  // Day 2 first bar must reset completely to Day 2's candle (2100), not blended with 2005
  assert.equal(bars[2].isNewDay, true);
  assert.ok(Math.abs(bars[2].vwap - 2100) < 1e-4);
});
