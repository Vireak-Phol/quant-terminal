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

---

## 6. v7.4 Institutional Signal Engine (`engine/`)

Python port of `pine-strategy/7.4` (OSC-VIP v7.4 + REG/UIS-VIP v7.4), driven by closed bars only so live == backtest.

| Module | Role |
|---|---|
| `pine.py`, `sessions.py`, `htf.py` | Pine runtime primitives (ta.* semantics), NY killzones (DST-aware), 4H / cross-symbol alignment |
| `osc_engine.py` | OSC §3–§6: shock guard, CF-VWAP-Z, SMPI, ER regime, CHoCH/FVG/OB/sweeps/trap, liquidity vacuum, Hopla, log-odds + N_eff scoring, EQS, dynamic A+ threshold, tiers |
| `reg/unicorn.py`, `reg/liquidity.py`, `reg/rpd.py`, `reg/regob.py` | REG: FVG+breaker (CTF+MTF), liquidity zones/sweeps + PDH/PDL, RPD, Regression OBs |
| `risk.py` | Trade plan: session-σ stops (wall-anchored when a resting wall is within 0.5 ATR), TP1/TP2, sizing, leverage cap, fees + slippage in R |
| `ledger.py`, `calibration.py` | SQLite ledger (`data/ledger.db`), outcome resolution, Beta(2,2) + Wilson CI per setup × tier × score bin |
| `runtime.py`, `live.py` | Per-timeframe orchestrator (5m, 15m), warm-up, live bar polling, `v74` WebSocket frame, soft guardrails |
| `backtest.py` | Full-history replay through the identical code path |
| `alerts.py` | Opt-in Telegram alerts (`.env`, see `.env.example`) |

**Probability rule.** The only number shown as "win rate" is the measured, cost-adjusted hit rate from the ledger (gray *warm-up* until n ≥ 15). The OSC model score is used internally for tiering/ranking.

**Parity with TradingView** (`tests/test_osc_parity.py`, fixtures exported from TradingView Desktop): OSC A+/Structural/Trap, killzones, shock, vacuum, VWAP-Z and SMPI match bar-for-bar; REG Unicorn setups and liquidity sweeps exact; RPD 85% (residual is TradingView's internal 20m MTF series).

### Commands
```bash
# tests (from orderbook-bridge/)
../.venv/bin/python -m pytest tests -q
# backtest → fills ledger with source=backtest, prints per-setup stats
../.venv/bin/python -m engine.backtest --tf 5m --tf 15m --json ../data/backtest_report.json
# bridge on another port (frontend: VITE_BRIDGE_URL=ws://localhost:8766 pnpm dev)
BRIDGE_PORT=8766 PYTHONPATH=orderbook-bridge:. .venv/bin/python3 orderbook-bridge/bridge.py
```

WebSocket commands: `{"action":"get_ledger","tf":"5m"}` → `{"type":"ledger",…}`; `{"action":"set_risk_config","config":{…}}` → `{"type":"risk_config","ok":…}` (validated, saved to `data/config.json`).
