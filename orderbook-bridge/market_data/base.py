"""
Base abstractions, interfaces, and data models for Market Data Providers.
Supports multi-exchange extensibility without altering the visualization engine.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Dict, List, Optional, Tuple, Callable, Awaitable, Any


class MarketType(str, Enum):
    SPOT = "spot"
    USD_M_FUTURES = "usd_m_futures"
    COIN_M_FUTURES = "coin_m_futures"


class ConnectionState(str, Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    SYNCHRONIZING = "synchronizing"
    CONNECTED = "connected"
    STALE = "stale"
    RECONNECTING = "reconnecting"
    ERROR = "error"


class OrderBookSyncState(str, Enum):
    UNINITIALIZED = "uninitialized"
    BUFFERING = "buffering"
    SYNCHRONIZED = "synchronized"
    DESYNCHRONIZED = "desynchronized"


@dataclass(frozen=True)
class InstrumentMetadata:
    symbol: str
    pair: str
    market_type: MarketType
    contract_type: str
    status: str
    base_asset: str
    quote_asset: str
    margin_asset: str
    price_precision: int
    quantity_precision: int
    tick_size: Decimal
    step_size: Decimal
    min_qty: Decimal
    min_notional: Decimal

    def to_dict(self) -> Dict[str, Any]:
        return {
            "symbol": self.symbol,
            "pair": self.pair,
            "market_type": self.market_type.value,
            "contract_type": self.contract_type,
            "status": self.status,
            "base_asset": self.base_asset,
            "quote_asset": self.quote_asset,
            "margin_asset": self.margin_asset,
            "price_precision": self.price_precision,
            "quantity_precision": self.quantity_precision,
            "tick_size": str(self.tick_size),
            "step_size": str(self.step_size),
            "min_qty": str(self.min_qty),
            "min_notional": str(self.min_notional),
        }


@dataclass
class TradeEvent:
    symbol: str
    market_type: MarketType
    trade_id: int
    price: Decimal
    quantity: Decimal
    aggressor_side: str  # "buy" or "sell"
    exchange_timestamp: int  # ms
    received_timestamp: int  # ms
    is_buyer_maker: bool

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": "trade",
            "symbol": self.symbol,
            "market_type": self.market_type.value,
            "trade_id": self.trade_id,
            "price": str(self.price),
            "quantity": str(self.quantity),
            "aggressor_side": self.aggressor_side,
            "exchange_timestamp": self.exchange_timestamp,
            "received_timestamp": self.received_timestamp,
        }


@dataclass
class DepthLevel:
    price: Decimal
    quantity: Decimal


@dataclass
class DepthUpdateEvent:
    symbol: str
    market_type: MarketType
    first_update_id: int  # U
    final_update_id: int  # u
    prev_final_update_id: Optional[int]  # pu (Binance Futures)
    exchange_timestamp: int  # E
    received_timestamp: int
    bids: List[DepthLevel]
    asks: List[DepthLevel]


@dataclass
class OrderBookSnapshot:
    symbol: str
    last_update_id: int
    exchange_timestamp: int
    bids: List[DepthLevel]
    asks: List[DepthLevel]


@dataclass
class KlineEvent:
    symbol: str
    interval: str
    start_time: int  # ms
    close_time: int  # ms
    open_price: Decimal
    high_price: Decimal
    low_price: Decimal
    close_price: Decimal
    volume: Decimal
    is_closed: bool

    def to_dict(self) -> Dict[str, Any]:
        return {
            "symbol": self.symbol,
            "interval": self.interval,
            "time": self.start_time // 1000,
            "open": float(self.open_price),
            "high": float(self.high_price),
            "low": float(self.low_price),
            "close": float(self.close_price),
            "volume": float(self.volume),
            "is_closed": self.is_closed,
        }


class InstrumentMetadataProvider(ABC):
    @abstractmethod
    async def get_instrument_metadata(self, symbol: str) -> InstrumentMetadata:
        """Fetch and validate instrument contract rules, precision, and tick size."""
        pass


class OrderBookProvider(ABC):
    @abstractmethod
    async def fetch_snapshot(self, symbol: str, limit: int = 1000) -> OrderBookSnapshot:
        """Fetch full order-book snapshot from REST API."""
        pass


class CandleProvider(ABC):
    @abstractmethod
    async def fetch_klines(
        self, symbol: str, interval: str, limit: int = 200
    ) -> List[KlineEvent]:
        """Fetch historical candlestick bars from REST API."""
        pass


class TradeStreamProvider(ABC):
    @abstractmethod
    def register_trade_callback(self, callback: Callable[[TradeEvent], Awaitable[None]]):
        """Register callback for real-time executed trades."""
        pass


class MarketDataProvider(
    InstrumentMetadataProvider,
    OrderBookProvider,
    CandleProvider,
    TradeStreamProvider,
    ABC,
):
    """Unified Market Data Provider interface."""

    @abstractmethod
    async def start(self):
        """Start background stream listeners and management loops."""
        pass

    @abstractmethod
    async def stop(self):
        """Stop all streams gracefully."""
        pass

    @abstractmethod
    def get_connection_state(self) -> ConnectionState:
        """Get current connection health."""
        pass
