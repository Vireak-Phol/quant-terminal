import type { CandleData } from "./klines";

export interface HeavyAbsorptionPoint {
  id: string;
  time: number;
  type: "buyers_absorbed" | "sellers_absorbed";
  price: number; // anchor price (high or low)
  volRatio: number; // e.g. 80, 130, 187
  wickPercent: number;
  isBullishCandle: boolean;
  candle: CandleData;
}

/**
 * Detects Heavy Absorption across candlesticks (matching the TradingView Heavy Absorption indicator style).
 * Identifies high-volume wicks where aggressive buyers are absorbed at highs or aggressive sellers are absorbed at lows.
 */
export function detectHeavyAbsorptions(candles: CandleData[]): HeavyAbsorptionPoint[] {
  if (candles.length < 15) return [];

  const points: HeavyAbsorptionPoint[] = [];
  const lookback = 20;
  const rollingAvgVol: number[] = new Array(candles.length);
  const rollingAvgTr: number[] = new Array(candles.length);
  let sumVol = 0;
  let sumTr = 0;

  for (let i = 0; i < candles.length; i++) {
    sumVol += candles[i].volume;
    const tr = Math.max(candles[i].high - candles[i].low, 0.01);
    sumTr += tr;

    if (i >= lookback) {
      sumVol -= candles[i - lookback].volume;
      const oldTr = Math.max(candles[i - lookback].high - candles[i - lookback].low, 0.01);
      sumTr -= oldTr;
      rollingAvgVol[i] = sumVol / lookback;
      rollingAvgTr[i] = sumTr / lookback;
    } else {
      rollingAvgVol[i] = sumVol / (i + 1);
      rollingAvgTr[i] = sumTr / (i + 1);
    }
  }

  for (let i = 15; i < candles.length; i++) {
    const c = candles[i];
    const avgVol = rollingAvgVol[i] || 1;
    const avgTr = rollingAvgTr[i] || 1;
    const volRatio = Math.round((c.volume / Math.max(avgVol, 1)) * 100);

    const tr = Math.max(c.high - c.low, 0.01);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperRatio = upperWick / tr;
    const lowerRatio = lowerWick / tr;
    const isBullishCandle = c.close >= c.open;

    // 1. Buyers Absorbed (Aggressive buying trapped at high -> upper wick rejection)
    const isBuyAbs =
      (upperRatio >= 0.35 && volRatio >= 70) ||
      (upperRatio >= 0.48 && volRatio >= 55) ||
      (volRatio >= 130 && upperRatio >= 0.28);

    // 2. Sellers Absorbed (Aggressive selling trapped at low -> lower wick rejection)
    const isSellAbs =
      (lowerRatio >= 0.35 && volRatio >= 70) ||
      (lowerRatio >= 0.48 && volRatio >= 55) ||
      (volRatio >= 130 && lowerRatio >= 0.28);

    // 3. High Volume Effort-vs-Result Spike (Absorption within candle body)
    const isVolumeSpike = volRatio >= 175 && tr <= avgTr * 1.15;

    if (isBuyAbs && (!isSellAbs || upperRatio >= lowerRatio)) {
      points.push({
        id: `abs-buy-${c.time}`,
        time: c.time,
        type: "buyers_absorbed",
        price: c.high,
        volRatio,
        wickPercent: Math.round(upperRatio * 100),
        isBullishCandle,
        candle: c,
      });
    } else if (isSellAbs) {
      points.push({
        id: `abs-sell-${c.time}`,
        time: c.time,
        type: "sellers_absorbed",
        price: c.low,
        volRatio,
        wickPercent: Math.round(lowerRatio * 100),
        isBullishCandle,
        candle: c,
      });
    } else if (isVolumeSpike) {
      points.push({
        id: `abs-spike-${c.time}`,
        time: c.time,
        type: isBullishCandle ? "buyers_absorbed" : "sellers_absorbed",
        price: (c.high + c.low) / 2,
        volRatio,
        wickPercent: Math.round((isBullishCandle ? upperRatio : lowerRatio) * 100),
        isBullishCandle,
        candle: c,
      });
    }
  }

  return points;
}
