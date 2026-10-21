export interface CandleData {
  time: number // UTC timestamp in seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
  vwap?: number
}

export type TimeframeInterval = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d'

export async function fetchBinanceFuturesKlines(
  symbol = 'XAUUSDT',
  interval: TimeframeInterval = '5m',
  limit = 200
): Promise<CandleData[]> {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Failed to fetch Binance Futures klines: ${res.statusText}`)
    }
    const raw = await res.json()
    let cumVolume = 0
    let cumVolPrice = 0

    return raw.map((k: any) => {
      const open = parseFloat(k[1])
      const high = parseFloat(k[2])
      const low = parseFloat(k[3])
      const close = parseFloat(k[4])
      const volume = parseFloat(k[5])
      const typicalPrice = (high + low + close) / 3

      cumVolume += volume
      cumVolPrice += typicalPrice * volume
      const vwap = cumVolume > 0 ? cumVolPrice / cumVolume : close

      return {
        time: Math.floor(k[0] / 1000), // convert ms to seconds
        open,
        high,
        low,
        close,
        volume,
        vwap: Math.round(vwap * 100) / 100,
      }
    })
  } catch (err) {
    console.error('Error fetching Binance USDⓈ-M Futures klines:', err)
    return []
  }
}

/** Calculate Exponential Moving Average */
export function calculateEMA(data: CandleData[], period: number): { time: number; value: number }[] {
  if (data.length < period) return []
  const k = 2 / (period + 1)
  const results: { time: number; value: number }[] = []

  let ema = data.slice(0, period).reduce((acc, c) => acc + c.close, 0) / period
  results.push({ time: data[period - 1].time, value: ema })

  for (let i = period; i < data.length; i++) {
    ema = data[i].close * k + ema * (1 - k)
    results.push({ time: data[i].time, value: Math.round(ema * 100) / 100 })
  }
  return results
}

/** Legacy alias for backwards compatibility */
export const fetchBinanceKlines = fetchBinanceFuturesKlines
