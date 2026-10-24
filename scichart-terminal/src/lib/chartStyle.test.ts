// Unit tests for chart colour settings. Zero-dependency: Node's built-in runner with
// type stripping (`pnpm test`). Imports use the .ts extension for that reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHART_STYLE,
  STYLE_PRESETS,
  bubblePaint,
  isHexColor,
  mixHex,
  rgba,
  sanitizeStyle,
} from "./chartStyle.ts";

test("sanitizeStyle keeps valid values, drops invalid, clamps opacity", () => {
  const s = sanitizeStyle({
    candleUpBody: "#ABCDEF",
    candleDownBody: "red", // not #rrggbb -> default
    bubbleBuy: "#12345", // too short -> default
    bubbleOpacity: 7,
    evil: "<script>",
  });
  assert.equal(s.candleUpBody, "#abcdef");
  assert.equal(s.candleDownBody, DEFAULT_CHART_STYLE.candleDownBody);
  assert.equal(s.bubbleBuy, DEFAULT_CHART_STYLE.bubbleBuy);
  assert.equal(s.bubbleOpacity, 1);
  assert.equal("evil" in s, false);
  assert.equal(sanitizeStyle({ bubbleOpacity: -1 }).bubbleOpacity, 0.1);
  assert.deepEqual(sanitizeStyle(null), DEFAULT_CHART_STYLE);
  assert.deepEqual(sanitizeStyle("garbage"), DEFAULT_CHART_STYLE);
});

test("colour maths", () => {
  assert.equal(rgba("#3b82f6", 0.55), "rgba(59, 130, 246, 0.55)");
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mixHex("#123456", "#ffffff", 0), "#123456");
  assert.ok(isHexColor("#a1b2c3") && !isHexColor("#a1b2c") && !isHexColor(42));
});

test("default bubble paint reproduces the shipped DeepCharts look", () => {
  const buy = bubblePaint(DEFAULT_CHART_STYLE, "buy", false);
  assert.equal(buy.fill, "rgba(59, 130, 246, 0.55)");
  assert.equal(buy.strokeThickness, 1.5);
  const battle = bubblePaint(DEFAULT_CHART_STYLE, "sell", true);
  assert.match(battle.fill, /, 0\.9\)$/); // battle tier is near-opaque regardless of opacity
  assert.equal(battle.strokeThickness, 2);
  // user opacity affects normal tier only
  const faint = bubblePaint({ ...DEFAULT_CHART_STYLE, bubbleOpacity: 0.2 }, "buy", false);
  assert.match(faint.fill, /, 0\.2\)$/);
});

test("every preset is a fully valid style", () => {
  for (const p of STYLE_PRESETS) assert.deepEqual(sanitizeStyle(p.style), p.style, p.name);
});
