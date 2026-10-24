import type { CandleData } from "./klines.ts";

export interface DailyVwapBar {
  time: number;
  vwap: number;
  sd: number;
  sigmaAdj: number;
  upper1: number;
  lower1: number;
  fibUpper1: number;
  fibUpper2: number;
  fibLower1: number;
  fibLower2: number;
  isNewDay?: boolean;
}

export interface VwapBandsLevels {
  vwap: number;
  upper1: number;
  lower1: number;
  fibUpper1: number;
  fibUpper2: number;
  fibLower1: number;
  fibLower2: number;
  sigma?: number;
  sigmaAdj?: number;
  cfValid?: boolean;
}

/**
 * Computes bar-by-bar Daily VWAP + Cornish-Fisher Fibonacci bands.
 * Exact port of REG-v7-4-light.pine (lines 2204-2255) using Welford's running variance.
 * Resets each day at UTC 00:00:00.
 */
export function computeDailyVwapBars(
  candles: CandleData[],
  fib1 = 1.618,
  fib2 = 2.618,
  sessionDurationSec = 86400,
): DailyVwapBar[] {
  const result: DailyVwapBar[] = [];
  if (!candles || candles.length === 0) return result;

  let currentDay = -1;
  let addSource = 0;
  let addVol = 0;
  let sn = 0;
  let prevVwap = 0;
  const residuals: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = Math.floor(c.time / sessionDurationSec);
    const isNewDay = day !== currentDay && i > 0;

    const hlc3 = (c.high + c.low + c.close) / 3;
    const vol = c.volume > 0 ? c.volume : 1;

    if (day !== currentDay) {
      currentDay = day;
      addSource = hlc3 * vol;
      addVol = vol;
      sn = 0;
      prevVwap = hlc3;
      residuals.length = 0;
    } else {
      addSource += hlc3 * vol;
      addVol += vol;
      const currentVwap = addSource / addVol;
      sn += vol * (hlc3 - prevVwap) * (hlc3 - currentVwap);
      prevVwap = currentVwap;
    }

    const vwap = addVol > 0 ? addSource / addVol : hlc3;
    const sdRaw = addVol > 0 ? Math.sqrt(Math.max(sn / addVol, 0)) : 0;
    const sd = sdRaw > 0 ? sdRaw : Math.max(c.high - c.low, 1.0);

    const resid = hlc3 - vwap;
    residuals.push(resid);
    if (residuals.length > 100) residuals.shift();

    let sigmaAdj = sd;
    if (residuals.length >= 10) {
      const n = residuals.length;
      const mean = residuals.reduce((a, b) => a + b, 0) / n;
      let m2 = 0;
      let m3 = 0;
      let m4 = 0;
      for (const r of residuals) {
        const d = r - mean;
        m2 += d * d;
        m3 += d * d * d;
        m4 += d * d * d * d;
      }
      m2 /= n;
      m3 /= n;
      m4 /= n;
      const sdResid = Math.sqrt(Math.max(m2, 0));
      if (sdResid > 0) {
        const skew = m3 / (sdResid * sdResid * sdResid);
        const kurt = m4 / (sdResid * sdResid * sdResid * sdResid);
        const zp = 1.0;
        const cf =
          zp +
          ((zp * zp - 1) * skew) / 6.0 +
          ((zp * zp * zp - 3 * zp) * (kurt - 3)) / 24.0 -
          ((2 * zp * zp * zp - 5 * zp) * skew * skew) / 36.0;
        if (cf > 0) {
          sigmaAdj = sd * cf;
        }
      }
    }

    result.push({
      time: c.time,
      vwap,
      sd,
      sigmaAdj,
      upper1: vwap + sd,
      lower1: vwap - sd,
      fibUpper1: vwap + fib1 * sigmaAdj,
      fibUpper2: vwap + fib2 * sigmaAdj,
      fibLower1: vwap - fib1 * sigmaAdj,
      fibLower2: vwap - fib2 * sigmaAdj,
      isNewDay,
    });
  }

  return result;
}

/**
 * Latest Daily VWAP snapshot + Cornish-Fisher fat-tail deviation bands.
 * Exact port of REG-v7-4-light.pine (lines 2204-2255) and orderbook-bridge/analytics/vwap_z.py.
 */
export function computeVwapBandsFromCandles(
  candles: CandleData[],
  sessionDurationSec = 86400,
): VwapBandsLevels | null {
  if (!candles || candles.length < 2) return null;
  const bars = computeDailyVwapBars(candles, 1.618, 2.618, sessionDurationSec);
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  return {
    vwap: last.vwap,
    upper1: last.upper1,
    lower1: last.lower1,
    fibUpper1: last.fibUpper1,
    fibUpper2: last.fibUpper2,
    fibLower1: last.fibLower1,
    fibLower2: last.fibLower2,
    sigma: last.sd,
    sigmaAdj: last.sigmaAdj,
    cfValid: true,
  };
}
