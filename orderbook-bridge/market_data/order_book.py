"""
Precise, sequence-synchronized local Order Book engine for Binance USDⓈ-M Futures.
Implements the official reconciliation protocol:
- Initial snapshot buffering and reconciliation.
- Strict update ID sequence verification (U <= lastUpdateId <= u, then pu == prev_u).
- Zero-quantity level removal.
- Sequence gap detection and automatic desynchronization signaling.
- Decimal price keys to prevent floating-point representation bugs.
"""

from decimal import Decimal
import logging
import time
from typing import Dict, List, Optional, Tuple, Any

from .base import (
    DepthLevel,
    DepthUpdateEvent,
    OrderBookSnapshot,
    OrderBookSyncState,
)

logger = logging.getLogger("OrderBook")


class SequenceGapError(Exception):
    """Raised when a depth update sequence gap is detected."""
    pass


class LocalOrderBook:
    def __init__(self, symbol: str = "XAUUSDT"):
        self.symbol = symbol
        self.bids: Dict[Decimal, Decimal] = {}
        self.asks: Dict[Decimal, Decimal] = {}
        self.state: OrderBookSyncState = OrderBookSyncState.UNINITIALIZED
        self.last_update_id: int = 0
        self.prev_u: Optional[int] = None
        self.last_exchange_time: int = 0
        self.last_receive_time: int = 0
        self.event_buffer: List[DepthUpdateEvent] = []
        self.sequence_gaps_count: int = 0
        self.total_updates_processed: int = 0

    def reset(self):
        """Reset state before a new synchronization cycle."""
        self.bids.clear()
        self.asks.clear()
        self.state = OrderBookSyncState.BUFFERING
        self.last_update_id = 0
        self.prev_u = None
        self.event_buffer.clear()
        logger.info(f"[{self.symbol}] OrderBook reset to BUFFERING state.")

    def buffer_event(self, event: DepthUpdateEvent):
        """Buffer depth updates while awaiting snapshot fetch."""
        if self.state in (OrderBookSyncState.BUFFERING, OrderBookSyncState.UNINITIALIZED):
            self.event_buffer.append(event)
            # Bound buffer to prevent memory leaks if snapshot hangs
            if len(self.event_buffer) > 2000:
                self.event_buffer.pop(0)

    def reconcile_snapshot(self, snapshot: OrderBookSnapshot):
        """
        Reconcile the REST snapshot with buffered events using Binance Futures rules:
        1. Snapshot establishes baseline bids & asks.
        2. Discard events where u < lastUpdateId.
        3. First event must have U <= lastUpdateId <= u.
        4. Apply remaining events sequentially checking pu == prev_u.
        """
        self.bids.clear()
        self.asks.clear()

        for lvl in snapshot.bids:
            if lvl.quantity > Decimal("0"):
                self.bids[lvl.price] = lvl.quantity

        for lvl in snapshot.asks:
            if lvl.quantity > Decimal("0"):
                self.asks[lvl.price] = lvl.quantity

        self.last_update_id = snapshot.last_update_id
        self.last_exchange_time = snapshot.exchange_timestamp
        self.last_receive_time = int(time.time() * 1000)

        logger.info(
            f"[{self.symbol}] Snapshot loaded with lastUpdateId={snapshot.last_update_id}. "
            f"Bids: {len(self.bids)}, Asks: {len(self.asks)}. Reconciling {len(self.event_buffer)} buffered events..."
        )

        first_event_found = False
        self.prev_u = None

        for event in self.event_buffer:
            # 1. Drop any event where u < lastUpdateId
            if event.final_update_id < self.last_update_id:
                continue

            if not first_event_found:
                # 2. First processed event: U <= lastUpdateId <= u
                if event.first_update_id <= self.last_update_id <= event.final_update_id:
                    first_event_found = True
                    self._apply_event_levels(event)
                    self.prev_u = event.final_update_id
                    self.last_update_id = event.final_update_id
                    self.last_exchange_time = event.exchange_timestamp
                    self.last_receive_time = event.received_timestamp
                    self.total_updates_processed += 1
                else:
                    # Gap between snapshot and first usable event
                    logger.warning(
                        f"[{self.symbol}] Snapshot lastUpdateId {self.last_update_id} not within "
                        f"first event range [{event.first_update_id}, {event.final_update_id}]. Resync required."
                    )
                    self.state = OrderBookSyncState.DESYNCHRONIZED
                    self.sequence_gaps_count += 1
                    raise SequenceGapError("Snapshot gap with buffered event")
            else:
                # 3. Subsequent buffered events: pu must match prev_u
                if event.prev_final_update_id is not None and event.prev_final_update_id != self.prev_u:
                    logger.warning(
                        f"[{self.symbol}] Sequence gap in buffered events: pu={event.prev_final_update_id} != prev_u={self.prev_u}"
                    )
                    self.state = OrderBookSyncState.DESYNCHRONIZED
                    self.sequence_gaps_count += 1
                    raise SequenceGapError("Sequence gap in buffered events")

                self._apply_event_levels(event)
                self.prev_u = event.final_update_id
                self.last_update_id = event.final_update_id
                self.last_exchange_time = event.exchange_timestamp
                self.last_receive_time = event.received_timestamp
                self.total_updates_processed += 1

        self.event_buffer.clear()
        self.state = OrderBookSyncState.SYNCHRONIZED
        logger.info(
            f"[{self.symbol}] OrderBook successfully SYNCHRONIZED at updateId={self.last_update_id}!"
        )

    def apply_update(self, event: DepthUpdateEvent):
        """
        Apply a real-time depth update.
        Verifies pu == prev_u and maintains zero-quantity deletion.
        """
        if self.state != OrderBookSyncState.SYNCHRONIZED:
            self.buffer_event(event)
            return

        # Initial live event transition if not processed from buffer
        if self.prev_u is None:
            if event.final_update_id < self.last_update_id:
                return
            if event.first_update_id <= self.last_update_id <= event.final_update_id:
                self._apply_event_levels(event)
                self.prev_u = event.final_update_id
                self.last_update_id = event.final_update_id
                self.last_exchange_time = event.exchange_timestamp
                self.last_receive_time = event.received_timestamp
                self.total_updates_processed += 1
                return
            else:
                self.sequence_gaps_count += 1
                self.state = OrderBookSyncState.DESYNCHRONIZED
                raise SequenceGapError("Snapshot gap with live event")

        # Sequence gap check for Binance Futures: pu == prev_u
        if event.prev_final_update_id is not None:
            if event.prev_final_update_id != self.prev_u:
                self.sequence_gaps_count += 1
                self.state = OrderBookSyncState.DESYNCHRONIZED
                logger.error(
                    f"[{self.symbol}] Depth sequence gap detected: pu={event.prev_final_update_id} != prev_u={self.prev_u}. "
                    f"Marking DESYNCHRONIZED."
                )
                raise SequenceGapError(
                    f"Sequence gap: pu={event.prev_final_update_id} != {self.prev_u}"
                )

        self._apply_event_levels(event)
        self.prev_u = event.final_update_id
        self.last_update_id = event.final_update_id
        self.last_exchange_time = event.exchange_timestamp
        self.last_receive_time = event.received_timestamp
        self.total_updates_processed += 1

    def replace_levels(
        self,
        bids: List[Tuple[Decimal, Decimal]],
        asks: List[Tuple[Decimal, Decimal]],
        exchange_timestamp: Optional[int] = None,
    ):
        """Replace the whole book with a full quote snapshot (quote-only venues such
        as OANDA, which stream complete bid/ask ladders rather than sequenced diffs).
        There is no sequence to verify, so the book is SYNCHRONIZED by construction.
        Zero/negative-price levels are dropped; a zero liquidity figure is kept (the
        venue quoted the price but did not disclose size). Crossed snapshots (best
        bid >= best ask) are rejected and the previous book is kept."""
        new_bids = {p: q for p, q in bids if p > 0 and q >= 0}
        new_asks = {p: q for p, q in asks if p > 0 and q >= 0}
        if new_bids and new_asks and max(new_bids) >= min(new_asks):
            logger.debug(f"[{self.symbol}] crossed quote ignored: {max(new_bids)} >= {min(new_asks)}")
            return
        self.bids = new_bids
        self.asks = new_asks
        self.state = OrderBookSyncState.SYNCHRONIZED
        self.event_buffer.clear()
        self.last_exchange_time = exchange_timestamp or int(time.time() * 1000)
        self.last_receive_time = int(time.time() * 1000)
        self.total_updates_processed += 1

    def _apply_event_levels(self, event: DepthUpdateEvent):
        """Applies level quantity updates or removes zero-quantity levels."""
        zero = Decimal("0")
        for lvl in event.bids:
            if lvl.quantity == zero:
                self.bids.pop(lvl.price, None)
            else:
                self.bids[lvl.price] = lvl.quantity

        for lvl in event.asks:
            if lvl.quantity == zero:
                self.asks.pop(lvl.price, None)
            else:
                self.asks[lvl.price] = lvl.quantity

    def get_best_bid_ask(self) -> Tuple[Optional[Decimal], Optional[Decimal]]:
        """Returns best (highest) bid and best (lowest) ask prices."""
        if not self.bids or not self.asks:
            return None, None
        best_bid = max(self.bids.keys())
        best_ask = min(self.asks.keys())
        return best_bid, best_ask

    def get_mid_and_spread(self) -> Tuple[Optional[Decimal], Optional[Decimal]]:
        """Returns mid price and spread as Decimals."""
        best_bid, best_ask = self.get_best_bid_ask()
        if best_bid is None or best_ask is None:
            return None, None
        spread = best_ask - best_bid
        mid = (best_bid + best_ask) / Decimal("2")
        return mid, spread

    def get_top_levels(self, limit: int = 20) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Returns sorted top bids (descending) and asks (ascending) with cumulative depth.
        """
        sorted_bids = sorted(self.bids.items(), key=lambda x: x[0], reverse=True)[:limit]
        sorted_asks = sorted(self.asks.items(), key=lambda x: x[0])[:limit]

        out_bids = []
        bid_cum = Decimal("0")
        for p, q in sorted_bids:
            bid_cum += q
            out_bids.append({
                "price": float(p),
                "size": float(q),
                "cumulative": float(round(bid_cum, 4))
            })

        out_asks = []
        ask_cum = Decimal("0")
        for p, q in sorted_asks:
            ask_cum += q
            out_asks.append({
                "price": float(p),
                "size": float(q),
                "cumulative": float(round(ask_cum, 4))
            })

        return out_bids, out_asks

    def get_binned_depth_column(
        self,
        price_min: float,
        price_max: float,
        bin_size: float,
    ) -> List[float]:
        """
        Dense Bookmap-style depth column: total resting limit volume per price bin
        across the full [price_min, price_max) window, from both book sides.

        Unlike the thresholded liquidity zones (which keep only ~20 large walls),
        this returns the continuous depth gradient at every bin so the heatmap
        reads like Bookmap at any timeframe. Returns a list of length `num_bins`.
        Lifespan/spoof weighting is intentionally omitted here because the
        synchronized L2 book does not track per-level age.
        """
        if bin_size <= 0 or price_max <= price_min:
            return []
        num_bins = int(round((price_max - price_min) / bin_size))
        if num_bins <= 0:
            return []

        bins = [0.0] * num_bins
        for book_side in (self.bids, self.asks):
            for p_dec, q_dec in book_side.items():
                p = float(p_dec)
                if p < price_min or p >= price_max:
                    continue
                idx = int((p - price_min) // bin_size)
                if 0 <= idx < num_bins:
                    bins[idx] += float(q_dec)
        return bins

    def get_imbalance(self, depth: int = 5) -> Tuple[float, int]:
        """
        Calculates order flow imbalance across top N levels:
        returns (imbalance: -1.0 to +1.0, score: 0 to 100).
        """
        top_bids = sorted(self.bids.items(), key=lambda x: x[0], reverse=True)[:depth]
        top_asks = sorted(self.asks.items(), key=lambda x: x[0])[:depth]

        bid_vol = sum(q for _, q in top_bids)
        ask_vol = sum(q for _, q in top_asks)
        denom = bid_vol + ask_vol

        if denom == Decimal("0"):
            return 0.0, 50

        imb = float((bid_vol - ask_vol) / denom)
        score = max(0, min(100, int(round(50 + (imb * 50)))))
        return round(imb, 4), score
