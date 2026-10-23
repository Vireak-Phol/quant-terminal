export interface CandleData {
  time: number; // UTC timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  /** Aggressor volume delta (taker buy − taker sell), base-asset units. */
  delta?: number;
}

export type TimeframeInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export async function fetchBinanceFuturesKlines(
  symbol = "XAUUSDT",
  interval: TimeframeInterval = "1m",
  limit = 200
): Promise<CandleData[]> {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch Binance Futures klines: ${res.statusText}`);
    }
    // [openTime, o, h, l, c, volume, closeTime, quoteVol, trades, takerBuyBaseVol, takerBuyQuoteVol, ignore]
    const raw = (await res.json()) as Array<[number, string, string, string, string, string, number, string, number, string, ...unknown[]]>;

    return raw.map((k) => {
      const open = parseFloat(k[1]);
      const high = parseFloat(k[2]);
      const low = parseFloat(k[3]);
      const close = parseFloat(k[4]);
      const volume = parseFloat(k[5]);
      // Taker-buy volume is the aggressor-buy side, so delta = buy − sell
      // = takerBuy − (volume − takerBuy). Same definition the bridge uses live.
      const takerBuy = parseFloat(k[9]);
      const delta = Number.isFinite(takerBuy) ? 2 * takerBuy - volume : undefined;

      return {
        time: Math.floor(k[0] / 1000), // convert ms to seconds
        open,
        high,
        low,
        close,
        volume,
        delta,
      };
    });
  } catch (err) {
    console.error("Error fetching Binance USDⓈ-M Futures klines:", err);
    return [];
  }
}
