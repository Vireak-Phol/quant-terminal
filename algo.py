import numpy as np
import pandas as pd
from dataclasses import dataclass
from typing import Optional, List, Dict

@dataclass
class TradeSignal:
    timestamp: str
    direction: str  # "LONG" or "SHORT"
    entry_price: float
    stop_loss: float
    take_profit_1: float
    take_profit_2: float
    confluence_reasons: List[str]
    institutional_score: float  # 0.0 to 100.0

class InstitutionalQuantEngine:
    def __init__(self, spot_price: float, gex_regime: str, zero_gamma_level: float, call_wall: float, put_wall: float):
        self.spot_price = spot_price
        self.gex_regime = gex_regime  # "LONG_GAMMA" (mean-reversion) or "SHORT_GAMMA" (trend)
        self.zero_gamma = zero_gamma_level
        self.call_wall = call_wall
        self.put_wall = put_wall
        
    def calculate_anchored_vwap(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        df requires: ['price', 'volume', 'bid_volume', 'ask_volume']
        """
        # Microstructure Delta
        df['delta'] = df['ask_volume'] - df['bid_volume']
        df['cvd'] = df['delta'].cumsum()
        
        # Anchored VWAP and Bands
        pv = (df['price'] * df['volume']).cumsum()
        cum_vol = df['volume'].cumsum()
        df['vwap'] = pv / cum_vol
        
        # Dynamic Standard Deviation Bands
        df['variance'] = (((df['price'] - df['vwap']) ** 2) * df['volume']).cumsum() / cum_vol
        df['std'] = np.sqrt(df['variance'])
        df['vwap_upper_2'] = df['vwap'] + 2.0 * df['std']
        df['vwap_lower_2'] = df['vwap'] - 2.0 * df['std']
        df['vwap_upper_3'] = df['vwap'] + 3.0 * df['std']
        df['vwap_lower_3'] = df['vwap'] - 3.0 * df['std']
        return df

    def detect_absorption(self, df: pd.DataFrame, window: int = 5, delta_mult: float = 2.0) -> pd.DataFrame:
        """
        Detects passive absorption: High aggressive volume/delta with near-zero price progression
        """
        df['price_displacement'] = df['price'].diff(window).abs()
        df['rolling_delta'] = df['delta'].rolling(window).sum()
        df['rolling_vol'] = df['volume'].rolling(window).sum()
        df['mean_delta'] = df['delta'].abs().rolling(20).mean()

        # Absorption criteria: Aggressive delta spike, but price cannot displace
        df['bid_absorption'] = (
            (df['rolling_delta'] < -delta_mult * df['mean_delta']) & 
            (df['price_displacement'] <= df['price'] * 0.0003)
        )  # Trapped aggressive sellers into a passive buyer (Long signal)
        
        df['ask_absorption'] = (
            (df['rolling_delta'] > delta_mult * df['mean_delta']) & 
            (df['price_displacement'] <= df['price'] * 0.0003)
        )  # Trapped aggressive buyers into a passive seller (Short signal)
        
        return df

    def evaluate_orderflow_execution(self, df: pd.DataFrame, globex_high: float, globex_low: float) -> Optional[TradeSignal]:
        latest = df.iloc[-1]
        confluences = []
        score = 0.0
        
        # ─── SCENARIO 1: SHORT SETUP (Passive Seller Absorbing Aggressive Buyers at Extreme) ───
        if self.gex_regime == "LONG_GAMMA":
            score += 20
            confluences.append("Long Gamma Regime (Mean Reverting Volatility)")

            # Check Location: Overextended at VWAP +2.0 StdDev or Call Wall / Globex High sweep
            at_location = False
            if latest['price'] >= latest['vwap_upper_2']:
                confluences.append("Price >= VWAP +2.0 Sigma Band")
                score += 25
                at_location = True
            if latest['price'] >= globex_high:
                confluences.append("Globex High Liquidity Swept")
                score += 20
                at_location = True
            if abs(latest['price'] - self.call_wall) <= 2.0:
                confluences.append("Dealer Call Wall Rejection Zone")
                score += 25
                at_location = True

            # Microstructure Confirmation: Ask Absorption (Passive limit seller soaking aggressive market buys)
            if at_location and latest['ask_absorption']:
                score += 30
                confluences.append("Iceberg Ask Absorption Confirmed (Trapped Buyers)")
                
                # Check CVD Divergence
                if latest['price'] >= df['price'].iloc[-10:].max() and latest['cvd'] < df['cvd'].iloc[-10:].max():
                    score += 15
                    confluences.append("Bearish CVD Divergence Detected")

                if score >= 75.0:
                    entry = latest['price']
                    stop = entry + (latest['std'] * 0.5)  # Structural invalidation just behind the absorption node
                    tp1 = latest['vwap']                 # Mean reversion to VWAP
                    tp2 = latest['vwap_lower_2']         # Continuation to opposite band
                    
                    return TradeSignal(
                        timestamp=str(latest.name),
                        direction="SHORT",
                        entry_price=round(entry, 2),
                        stop_loss=round(stop, 2),
                        take_profit_1=round(tp1, 2),
                        take_profit_2=round(tp2, 2),
                        confluence_reasons=confluences,
                        institutional_score=min(score, 100.0)
                    )

        # ─── SCENARIO 2: LONG SETUP (Passive Buyer Absorbing Aggressive Sellers at Floor) ───
        # Evaluate in any regime — SHORT_GAMMA may still produce valid long reversal signals;
        # the regime weight (+20 pts) is already captured in the score above if applicable.
        if True:
            at_location = False
            if latest['price'] <= latest['vwap_lower_2']:
                confluences.append("Price <= VWAP -2.0 Sigma Band")
                score += 25
                at_location = True
            if latest['price'] <= globex_low:
                confluences.append("Globex Low Liquidity Swept")
                score += 20
                at_location = True
            if abs(latest['price'] - self.put_wall) <= 2.0:
                confluences.append("Dealer Put Wall Support Zone")
                score += 25
                at_location = True

            # Microstructure Confirmation: Bid Absorption (Passive limit buyer soaking aggressive sellers)
            if at_location and latest['bid_absorption']:
                score += 30
                confluences.append("Iceberg Bid Absorption Confirmed (Trapped Sellers)")
                
                if latest['price'] <= df['price'].iloc[-10:].min() and latest['cvd'] > df['cvd'].iloc[-10:].min():
                    score += 15
                    confluences.append("Bullish CVD Divergence Detected")

                if score >= 75.0:
                    entry = latest['price']
                    stop = entry - (latest['std'] * 0.5)
                    tp1 = latest['vwap']
                    tp2 = latest['vwap_upper_2']
                    
                    return TradeSignal(
                        timestamp=str(latest.name),
                        direction="LONG",
                        entry_price=round(entry, 2),
                        stop_loss=round(stop, 2),
                        take_profit_1=round(tp1, 2),
                        take_profit_2=round(tp2, 2),
                        confluence_reasons=confluences,
                        institutional_score=min(score, 100.0)
                    )

        return None