# Real-Time Market Microstructure Terminal Bridge

High-performance Python market data, order-book synchronization, and quantitative analytics engine for **Binance USDⓈ-M Futures XAUUSDT** (`TRADIFI_PERPETUAL`).

---

## 1. Architecture Overview

```
                      [ Binance USDⓈ-M Futures ]
               (REST: fapi.binance.com / WS: fstream.binance.com)
                                |
               +----------------+----------------+
               |                                 |
        REST Snapshots & Klines          WebSocket Streams
   (/fapi/v1/depth?limit=1000)      (xauusdt@depth@100ms, aggTrade,
   (/fapi/v1/klines?interval=5m)     kline_1m, markPrice@1s)
               |                                 |
               +----------------+----------------+
                                |
                   [ BinanceFuturesProvider ]
                                |
        +-----------------------+-----------------------+
        |                                               |
  [ LocalOrderBook ]                          [ Trade Stream ]
  - U <= lastUpdateId <= u                              |
  - pu == prev_u sequence check                         |
  - Zero-qty removal                                    |
  - Exact Decimal tick math                             |
        |                                               |
        v                                               v
[ LiquidityZoneDetector ]                   [ AbsorptionEngine ]
- Multi-criteria thresholding               - Aggressive flow vs price response
- Adjacent price clustering                 - Volatility normalization
- Full lifecycle state machine              - Confidence scoring (0.0 - 1.0)
        |                                               |
        +-----------------------+-----------------------+
                                |
                      [ TerminalBridge ]
                    (ws://0.0.0.0:8765)
                                |
                     [ React Trading Terminal ]
           (Lightweight-Charts v5, Canvas Overlays, DOM Ladder)
```

---

## 2. Verified Instrument Specifications

| Parameter | Value |
|---|---|
| **Exchange** | Binance USDⓈ-M Futures (`fapi.binance.com`) |
| **Stream Endpoint** | `wss://fstream.binance.com/stream` |
| **Symbol** | `XAUUSDT` |
| **Contract Type** | `TRADIFI_PERPETUAL` |
| **Status** | `TRADING` |
| **Base Asset** | `XAU` (Fine Troy Ounces) |
| **Quote / Settlement Asset** | `USDT` |
| **Price Precision / Tick Size** | 2 decimals (`$0.01`) |
| **Quantity Precision / Step Size** | 3 decimals (`0.001` oz) |
| **Min Quantity** | `0.001` oz |
| **Min Notional** | `5.00` USDT |

---

## 3. Order-Book Synchronization & Gap Recovery

The engine implements the official Binance Futures depth management protocol:
1. **Stream Connection**: Connects to `wss://fstream.binance.com/stream?streams=xauusdt@depth@100ms/...`.
2. **Buffering**: Incoming depth events are buffered in memory while the REST snapshot is fetched.
3. **Snapshot Fetch**: Full 1000-level depth snapshot fetched from `GET /fapi/v1/depth?symbol=XAUUSDT&limit=1000`.
4. **Reconciliation**:
   - Discards any buffered events where `u < lastUpdateId`.
   - The first processed event must satisfy `U <= lastUpdateId <= u`.
   - For all subsequent events, `pu` must match the previous event's `u`.
5. **Sequence Gap Detection**: If `pu != prev_u`, the book immediately transitions to `DESYNCHRONIZED`, raises `SequenceGapError`, and triggers asynchronous resynchronization with a fresh snapshot.
6. **Zero-Quantity Deletion**: Price levels are removed when quantity drops to zero.

---

## 4. Analytical Microstructure Features

### Feature A: Resting Liquidity Zones (Bookmap-Inspired)
- **Detection**: Evaluates top 100+ book levels against:
  1. Absolute quantity ($\ge 15.0$ oz)
  2. Notional value ($\ge \$50,000$)
  3. Rolling relative size ($\ge 2.0\times$ mean level size)
- **Clustering**: Groups adjacent price levels within configurable tick tolerance (`$0.05` on gold) into cohesive zones.
- **Lifecycle Tracking**:
  - `active`: Liquidity displayed.
  - `reduced`: Displayed quantity decreased by $>15\%$.
  - `removed`: Liquidity pulled / cleared.
  - `replenished`: Liquidity reappeared at existing zone.

### Feature B: Absorption Bubbles (DeepChart-Inspired)
- **Input Dimensions**: Aggressive taker volume (`isBuyerMaker`), execution price, observation window, local volatility ($Z$-score / standard deviation), and resting wall proximity.
- **Distinction**: A large trade is not automatically absorption. Absorption requires aggressive volume coupled with **stalled price advancement** against resting limit liquidity.
- **Output**: Generates candidates with a multi-factor confidence score ($0.0 - 1.0$), volume, and price response.

---

## 5. Running the Terminal

### 1. Start Python Backend Bridge:
```bash
# From workspace root
PYTHONPATH=orderbook-bridge:. .venv/bin/python3 orderbook-bridge/bridge.py
```

### 2. Start Frontend Dev Server:
```bash
# In another terminal
cd trading-terminal
npm run dev
```
Open `http://localhost:5173` in your browser.

### 3. Run Automated Unit Tests:
```bash
PYTHONPATH=. .venv/bin/pytest tests/
```
