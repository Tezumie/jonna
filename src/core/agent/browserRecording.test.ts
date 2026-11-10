import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captionOf,
  isRecordingStop,
  markerOf,
  needsLocate,
  RECORDING_LIMITS,
  recordingFileName,
  recordingLimit,
  recordingSize,
  recordingSummary,
  scaleMarker,
} from "./browserRecording";

test("D340: a recording's size: scaled down to its long side, never up", () => {
  assert.deepEqual(recordingSize({ width: 1568, height: 980 }), { width: 960, height: 600 });
  assert.deepEqual(recordingSize({ width: 400, height: 300 }), { width: 400, height: 300 });
  assert.deepEqual(recordingSize({ width: 375, height: 812 }, 406), { width: 188, height: 406 });
});

test("D340: markers from coordinates; elements are looked up", () => {
  assert.deepEqual(markerOf({ action: "left_click", coordinate: [10, 20] }), {
    kind: "click",
    x: 10,
    y: 20,
  });
  assert.deepEqual(markerOf({ action: "drag", start_coordinate: [1, 2], coordinate: [3, 4] }), {
    kind: "drag",
    x: 3,
    y: 4,
    fromX: 1,
    fromY: 2,
  });
  assert.equal(markerOf({ action: "click", ref: "e3" }), null);
  assert.equal(markerOf({ action: "navigate", coordinate: [1, 1] }), null);
  assert.equal(needsLocate({ action: "click", ref: "e3" }), true);
  assert.equal(needsLocate({ action: "upload", selector: "#f" }), true);
  assert.equal(needsLocate({ action: "click", coordinate: [1, 2] }), false);
  assert.equal(needsLocate({ action: "type", ref: "e3" }), false);
  assert.deepEqual(
    scaleMarker(
      { kind: "click", x: 100, y: 50 },
      { width: 1000, height: 500 },
      { width: 500, height: 250 },
    ),
    { kind: "click", x: 50, y: 25 },
  );
});

test("D340: captions, limits, summary, file name, the stop call", () => {
  assert.equal(captionOf({ action: "click", action_summary: "opens the menu" }), "Opens the menu");
  assert.equal(captionOf({ action: "navigate", url: "localhost:5173" }), "Navigate localhost:5173");
  assert.equal(recordingLimit({ frames: 3, elapsedMs: 1000, bytes: 10 }), null);
  assert.match(
    recordingLimit({ frames: RECORDING_LIMITS.maxFrames, elapsedMs: 0, bytes: 0 }) ?? "",
    /frames/,
  );
  assert.match(
    recordingLimit({ frames: 1, elapsedMs: RECORDING_LIMITS.maxMs, bytes: 0 }) ?? "",
    /minutes/,
  );
  assert.equal(
    recordingSummary({ frames: 12, durationMs: 8400, width: 640, height: 400, bytes: 1300000 }),
    "12 frames · 8.4 s · 640×400 · 1.2 MB",
  );
  assert.equal(
    recordingFileName(new Date(2026, 10, 6, 14, 5, 9)),
    "recording-2026-11-06-14-05-09.gif",
  );
  assert.equal(isRecordingStop("browser_act", { action: "stop_recording" }), true);
  assert.equal(isRecordingStop("browser_act", { action: "start_recording" }), false);
  assert.equal(isRecordingStop("browser_batch", { action: "stop_recording" }), false);
  assert.equal(
    isRecordingStop("browser_batch", {
      actions: [
        { name: "browser_act", input: { action: "click", ref: "e1" } },
        { name: "browser_act", input: { action: "stop_recording" } },
      ],
    }),
    true,
  );
  assert.equal(
    isRecordingStop("browser_batch", { actions: [null, { name: "screenshot" }] }),
    false,
  );
});

test("D354: the screenshot tool's record: stop ends a recording (the IDE window's card)", () => {
  assert.equal(isRecordingStop("screenshot", { record: "stop", target: "ide" }), true);
  assert.equal(isRecordingStop("screenshot", { record: "start" }), false);
  assert.equal(isRecordingStop("screenshot", { target: "ide" }), false);
});
