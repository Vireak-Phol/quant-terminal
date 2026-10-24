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

/** Minimal surface of SharedSocket needed here (keeps this module test-friendly). */
interface KlineSocket {
  request<T>(action: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

interface KlinesReply {
  type: "klines";
  ok: boolean;
  error?: string;
  provider?: string;
  candles?: Array<{
    time: number; open: number; high: number; low: number; close: number;
    volume: number; delta: number | null;
  }>;
}

/**
 * Chart seed candles for the ACTIVE venue, fetched through the bridge so the venue
 * (and its credentials, for OANDA) stays server-side. If the bridge is unreachable
 * and the venue is Binance, fall back to Binance public REST directly so the chart is
 * never empty. There is deliberately no fallback for OANDA: showing Binance candles
 * under an OANDA label would mislead.
 */
export async function fetchChartKlines(
  socket: KlineSocket,
  venueName: string,
  symbol: string,
  interval: TimeframeInterval,
  limit = 1000,
): Promise<{ candles: CandleData[]; source: "bridge" | "binance-direct"; error?: string }> {
  try {
    const r = await socket.request<KlinesReply>("get_klines", { tf: interval, limit }, 20_000);
    if (r.ok && Array.isArray(r.candles)) {
      return {
        source: "bridge",
        candles: r.candles.map((c) => ({
          time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
          volume: c.volume, delta: c.delta ?? undefined,
        })),
      };
    }
    throw new Error(r.error || "bridge returned no candles");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (venueName === "binance") {
      console.warn(`klines via bridge failed (${msg}); falling back to Binance REST`);
      return { candles: await fetchBinanceFuturesKlines(symbol, interval, limit), source: "binance-direct" };
    }
    console.error(`klines via bridge failed for ${venueName}: ${msg}`);
    return { candles: [], source: "bridge", error: msg };
  }
}

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
