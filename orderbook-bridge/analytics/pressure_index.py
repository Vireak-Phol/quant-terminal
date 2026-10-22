"""
Smart-Money Pressure Index (SMPI) — Python port of the OSC-VIP v7.4 Pine pressure block.

OSC SMPI (Pine, section "Smart Money Pressure Index")::

    smpiRaw = 0.40 * ofpSlopeZ
            + 0.30 * (isAbsorption ? sign(ofpSlopeZ) * 1.5 : 0)
            + 0.30 * (close > open ? +1 : -1)
    smpi    = clamp(ema(smpiRaw, 3), -3, +3)
    snr     = |smpi| / max(stdev(smpi, 20), 0.1)

The one substantive upgrade in this port
-----------------------------------------
The Pine ``ofpSlopeZ`` is the slope of a LOWER-TIMEFRAME *range-location* volume proxy
(``volume * (close - mid) / (range/2)``) — i.e. where each intrabar closed inside its
range, which is not order flow. This engine replaces that term with the z-score of the
slope of the bridge's TRUE session-anchored CVD (``buy_volume − sell_volume`` from the
real aggressor-tagged trade tape). Everything else — the absorption kicker, the bar
direction term, the weights, the EMA(3) smoothing, the ±3 clamp, and the SNR — is
preserved so the composite reads on the same scale as the Pine original.

``absorption`` is supplied by the caller (the bridge already runs a quantitative
AbsorptionEngine on the live book); when it is unknown, pass ``None`` / ``False``.

Deterministic, operates on CLOSED bars only → never repaints.

Reference: pine-strategy/7.4/OSC-vip-v7-4-lite.pine
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass
from typing import Any, Dict, Optional

from engine.pine import EMA, SMA, Stdev, clamp

# OSC weights (sum to 1.0): flow 0.40, absorption kicker 0.30, bar direction 0.30.
_W_FLOW = 0.40
_W_ABSORB = 0.30
_W_DIR = 0.30
# Absorption kicker magnitude (OSC uses ±1.5).
_ABSORB_KICK = 1.5
# Final clamp (OSC clamps smpi to ±3).
_SMPI_CLAMP = 3.0
# SNR denominator floor (OSC uses max(stdev,0.1)).
_SNR_FLOOR = 0.1


@dataclass
class PressureState:
    """A single closed-bar snapshot of the pressure index."""

    smpi: Optional[float]          # signed pressure, clamped ±3  (+ = buy, − = sell)
    raw: Optional[float]           # pre-EMA composite
    slope_z: Optional[float]       # CVD-slope z-score (the flow term, pre-weight)
    slope: Optional[float]         # raw CVD slope over the lookback
    snr: Optional[float]           # |smpi| / stdev(smpi, snr_window) — signal clarity
    absorption: bool               # absorption state fed in for this bar

    def to_dict(self) -> Dict[str, Any]:
        def r(x: Optional[float], n: int = 3) -> Optional[float]:
            if x is None or not math.isfinite(x):
                return None
            return round(x, n)

        return {
            "smpi": r(self.smpi),
            "raw": r(self.raw),
            "slopeZ": r(self.slope_z),
            "slope": r(self.slope, 2),
            "snr": r(self.snr),
            "absorption": self.absorption,
        }


class _CvdSlope:
    """CVD value `lookback` bars ago, for an O(1) slope = cvd − cvd[lookback]."""

    __slots__ = ("lookback", "_buf")

    def __init__(self, lookback: int):
        self.lookback = lookback
        self._buf: "deque[float]" = deque(maxlen=lookback + 1)

    def push(self, cvd: float) -> Optional[float]:
        self._buf.append(cvd)
        if len(self._buf) <= self.lookback:
            return None
        return cvd - self._buf[0]


class PressureIndexEngine:
    """Signed smart-money pressure composite from true CVD flow + absorption + bar dir.

    Feed one CLOSED trade candle per bar via :meth:`update`, passing the session CVD
    at the bar close and the current absorption state. Query via :meth:`state` /
    :meth:`to_dict`.
    """

    def __init__(
        self,
        z_window: int = 100,
        cvd_lookback: int = 3,
        ema_len: int = 3,
        snr_window: int = 20,
    ):
        self.z_window = z_window
        self._slope = _CvdSlope(cvd_lookback)
        self._slope_mu = SMA(z_window)
        self._slope_sd = Stdev(z_window)
        self._ema = EMA(ema_len)
        self._smpi_sd = Stdev(snr_window)
        self._last = PressureState(None, None, None, None, None, False)

    def update(
        self,
        cvd: float,
        open_: float,
        close: float,
        absorption: bool = False,
    ) -> PressureState:
        """Ingest one CLOSED bar.

        Parameters
        ----------
        cvd : session-anchored cumulative volume delta at this bar's close.
        open_, close : the trade candle's open/close (bar-direction term).
        absorption : whether the live book flagged absorption on this bar.
        """
        slope = self._slope.push(cvd)

        if slope is None:
            self._last = PressureState(None, None, None, slope, None, bool(absorption))
            return self._last

        mu = self._slope_mu.update(slope)
        sd = self._slope_sd.update(slope)
        if mu is None or sd is None:
            # Warming up the z-window: no pressure reading yet.
            self._last = PressureState(None, None, None, slope, None, bool(absorption))
            return self._last

        # OSC clamps every z via f_clampZ = ±5.0 (OSC-vip-v7-4-lite.pine:256,379).
        slope_z = clamp((slope - mu) / sd if sd != 0 else 0.0, -5.0, 5.0)

        flow_term = _W_FLOW * slope_z
        # Absorption kicker takes the SIGN of the flow z. OSC used `z>0 ? +1.5 : -1.5`,
        # which spuriously fires NEGATIVE on a flat (z==0) tape; with a real CVD a zero
        # is near-impossible, but a perfectly linear ramp produces z==0 exactly, so a
        # zero flow gets a neutral (0) kick rather than a false bearish one.
        if absorption and slope_z != 0.0:
            absorb_sign = _ABSORB_KICK if slope_z > 0 else -_ABSORB_KICK
        else:
            absorb_sign = 0.0
        absorb_term = _W_ABSORB * absorb_sign
        dir_term = _W_DIR * (1.0 if close > open_ else -1.0)
        raw = flow_term + absorb_term + dir_term

        smpi_ema = self._ema.update(raw)
        if smpi_ema is None:
            self._last = PressureState(None, raw, slope_z, slope, None, bool(absorption))
            return self._last

        smpi = clamp(smpi_ema, -_SMPI_CLAMP, _SMPI_CLAMP)

        sd_smpi = self._smpi_sd.update(smpi)
        snr = abs(smpi) / max(sd_smpi, _SNR_FLOOR) if sd_smpi is not None else None

        self._last = PressureState(
            smpi=smpi,
            raw=raw,
            slope_z=slope_z,
            slope=slope,
            snr=snr,
            absorption=bool(absorption),
        )
        return self._last

    def state(self) -> PressureState:
        return self._last

    def to_dict(self) -> Dict[str, Any]:
        return {"pressure_index": self._last.to_dict()}
