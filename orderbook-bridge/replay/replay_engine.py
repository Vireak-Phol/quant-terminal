"""
Market Microstructure Event Recorder and Replay Player.
Enables deterministic local recording of order book depth, trades, and derived signals,
and replaying them at configurable playback speeds (1x, 2x, 5x, 10x).
"""

import asyncio
import json
import logging
import os
import time
from typing import Callable, Dict, List, Optional, Awaitable, Any

logger = logging.getLogger("ReplayEngine")


class MarketRecorder:
    def __init__(self, output_dir: str = "data/recordings", max_events_per_file: int = 50_000):
        self.output_dir = output_dir
        self.max_events_per_file = max_events_per_file
        self.is_recording = False
        self._current_file = None
        self._event_count = 0
        os.makedirs(output_dir, exist_ok=True)

    def start_recording(self, session_name: Optional[str] = None) -> str:
        if self.is_recording:
            return self._current_file.name if self._current_file else ""

        ts = time.strftime("%Y%m%d_%H%M%S")
        name = session_name or f"session_{ts}"
        filepath = os.path.join(self.output_dir, f"{name}.jsonl")
        self._current_file = open(filepath, "a", encoding="utf-8")
        self.is_recording = True
        self._event_count = 0
        logger.info(f"MarketRecorder started: {filepath}")
        return filepath

    def record_event(self, event_type: str, payload: Dict[str, Any]):
        if not self.is_recording or not self._current_file:
            return

        entry = {
            "type": event_type,
            "recorded_at": int(time.time() * 1000),
            "payload": payload,
        }
        self._current_file.write(json.dumps(entry) + "\n")
        self._current_file.flush()
        self._event_count += 1

        if self._event_count >= self.max_events_per_file:
            self.stop_recording()

    def stop_recording(self):
        if not self.is_recording:
            return
        self.is_recording = False
        if self._current_file:
            try:
                self._current_file.close()
            except Exception:
                pass
            self._current_file = None
        logger.info("MarketRecorder stopped.")


class ReplayPlayer:
    def __init__(self, playback_speed: float = 1.0):
        self.playback_speed = playback_speed
        self.is_playing = False
        self.is_paused = False
        self.current_event_index = 0
        self.events: List[Dict[str, Any]] = []
        self._playback_task: Optional[asyncio.Task] = None
        self._subscribers: List[Callable[[Dict[str, Any]], Awaitable[None]]] = []

    def subscribe(self, callback: Callable[[Dict[str, Any]], Awaitable[None]]):
        self._subscribers.append(callback)

    def load_recording(self, filepath: str) -> int:
        """Loads events from a recorded jsonl file."""
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Recording file not found: {filepath}")

        self.events.clear()
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        self.events.append(json.loads(line))
                    except Exception:
                        continue
        self.current_event_index = 0
        logger.info(f"Loaded {len(self.events)} events for replay from {filepath}")
        return len(self.events)

    def set_speed(self, speed: float):
        self.playback_speed = max(0.1, min(speed, 50.0))
        logger.info(f"Replay playback speed set to {self.playback_speed}x")

    def pause(self):
        self.is_paused = True

    def resume(self):
        self.is_paused = False

    async def start(self):
        if self.is_playing or not self.events:
            return
        self.is_playing = True
        self.is_paused = False
        self._playback_task = asyncio.create_task(self._play_loop())

    async def stop(self):
        self.is_playing = False
        self.is_paused = False
        if self._playback_task:
            self._playback_task.cancel()
            try:
                await self._playback_task
            except asyncio.CancelledError:
                pass

    async def _play_loop(self):
        try:
            while self.is_playing and self.current_event_index < len(self.events):
                if self.is_paused:
                    await asyncio.sleep(0.1)
                    continue

                curr = self.events[self.current_event_index]
                self.current_event_index += 1

                # Broadcast to subscribers
                for sub in self._subscribers:
                    try:
                        await sub(curr.get("payload", {}))
                    except Exception as e:
                        logger.error(f"Error in replay subscriber: {e}")

                if self.current_event_index < len(self.events):
                    nxt = self.events[self.current_event_index]
                    dt_ms = nxt.get("recorded_at", 0) - curr.get("recorded_at", 0)
                    delay_sec = max(0.001, (dt_ms / 1000.0) / self.playback_speed)
                    # Bound delay to at most 0.5s to skip long idle gaps
                    delay_sec = min(delay_sec, 0.5)
                    await asyncio.sleep(delay_sec)

            logger.info("Replay completed!")
        except asyncio.CancelledError:
            pass
        finally:
            self.is_playing = False
