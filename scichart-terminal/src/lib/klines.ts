export interface CandleData {
  time: number; // UTC timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
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
    const raw = (await res.json()) as Array<[number, string, string, string, string, string, ...unknown[]]>;

    return raw.map((k) => {
      const open = parseFloat(k[1]);
      const high = parseFloat(k[2]);
      const low = parseFloat(k[3]);
      const close = parseFloat(k[4]);
      const volume = parseFloat(k[5]);

      return {
        time: Math.floor(k[0] / 1000), // convert ms to seconds
        open,
        high,
        low,
        close,
        volume,
      };
    });
  } catch (err) {
    console.error("Error fetching Binance USDⓈ-M Futures klines:", err);
    return [];
  }
}
