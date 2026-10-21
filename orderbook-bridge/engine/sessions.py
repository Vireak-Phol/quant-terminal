"""Session killzones (OSC-VIP v7.4 §3) evaluated in America/New_York, DST-aware."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from typing import Tuple
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")


def parse_session(spec: str) -> Tuple[int, int]:
    """'0830-1100' -> (510, 660) minutes-of-day; an end of 0000 means midnight (1440)."""
    a, b = spec.split("-")
    start = int(a[:2]) * 60 + int(a[2:])
    end = int(b[:2]) * 60 + int(b[2:])
    if end == 0:
        end = 1440
    return start, end


def in_session(minute_of_day: int, spec: Tuple[int, int]) -> bool:
    start, end = spec
    if start < end:
        return start <= minute_of_day < end
    return minute_of_day >= start or minute_of_day < end  # wraps midnight


@dataclass(frozen=True)
class KillzoneConfig:
    london: str = "0200-0500"
    ny_am: str = "0830-1100"
    asia: str = "2000-0000"
    london_fix: str = "1000-1100"
    use_asia: bool = True
    use_filter: bool = True


@dataclass(frozen=True)
class SessionFlags:
    london: bool
    ny_am: bool
    asia: bool
    london_fix: bool

    @property
    def any(self) -> bool:
        return self.london or self.ny_am or self.asia or self.london_fix

    @property
    def name(self) -> str:
        if self.london_fix:
            return "LONDON_FIX"
        if self.ny_am:
            return "NY_AM"
        if self.london:
            return "LONDON"
        if self.asia:
            return "ASIA"
        return "OFF"


@lru_cache(maxsize=8)
def _parsed(cfg: KillzoneConfig):
    return (parse_session(cfg.london), parse_session(cfg.ny_am), parse_session(cfg.asia), parse_session(cfg.london_fix))


def ny_minute_of_day(ts_sec: int) -> int:
    dt = datetime.fromtimestamp(ts_sec, tz=timezone.utc).astimezone(NY)
    return dt.hour * 60 + dt.minute


def session_flags(bar_open_ts: int, cfg: KillzoneConfig = KillzoneConfig()) -> SessionFlags:
    """Pine ``not na(time(timeframe.period, sess, tz))`` evaluated on the bar open time."""
    m = ny_minute_of_day(bar_open_ts)
    lon, ny, asia, fix = _parsed(cfg)
    return SessionFlags(
        london=in_session(m, lon),
        ny_am=in_session(m, ny),
        asia=cfg.use_asia and in_session(m, asia),
        london_fix=in_session(m, fix),
    )
