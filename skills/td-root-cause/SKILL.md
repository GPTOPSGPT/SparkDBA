---
name: td-root-cause
description: "Root-cause advisor for plant telemetry in TDengine: for a yield drop, alarm, device fault or metric jump, rank device-level hypotheses (overheating, bearing wear, low pressure, device offline, stuck sensor, healthy) and verify each against the data, with the exact SQL trace behind every number. Use when: 为什么良品率下降, why did line X drop, which device caused it, 根因, 故障原因. Not for: PostgreSQL database incidents (use pg-root-cause), creating monitors or dashboards, changing data."
license: Apache-2.0
metadata: { "openclaw": { "emoji": "🧯", "requires": { "bins": ["bash"] } } }
---

# Root-cause advisor (plant)

**Run `rank` before answering.** Its baseline is the 30 minutes before the window, computed per device.
Do not estimate baselines by hand from a few rows: normal readings drift ±2 °C and look like faults when eyeballed.

## Run

```bash
"$SKILL_DIR/scripts/run.sh" rank --minutes 1 --baseline 30 [--line L2] [--ago 0]
```

Returns ranked `hypotheses` (device, category, confidence, evidence) and `sql_trace` (the queries that produced every number).

## Answer contract

```
CATEGORY: <overheating | bearing_wear | low_pressure | device_offline | stuck_sensor | healthy>
DEVICE: <device_id, or none>
ROOT CAUSE: <one sentence: device, mechanism, effect on the line>
EVIDENCE:
- <numbers from the hypotheses / sql_trace>
RULED OUT: <closest alternative and why>
NEXT ACTION: <maintenance or monitor to add; nothing is executed>
```

## How to tell look-alikes apart

| category | signal | not to confuse with |
|---|---|---|
| stuck_sensor | zero variance on every metric, yield unchanged | healthy: real data always has noise |
| device_offline | missing rows (gap), yield dips | stuck_sensor: rows keep coming, values frozen |
| overheating | temperature +8 °C or more vs baseline, yield drops on that line | seasonal wave: ±2 °C |
| bearing_wear | vibration ×1.8+, current up, status 2 late | low_pressure: pressure falls, vibration normal |
| low_pressure | pressure ×0.8 or less on a compressor, yield drops | overheating |

## Rules

- Keep the window on the incident: `--minutes 1` for "just now", wider only if the user says so. A wide window mixes in earlier, already-resolved events.
- A yield drop is a symptom; name the device. If two devices rank close, say so and cite both.
- `healthy` is a valid answer when nothing is outside baseline.
- Past incidents: pass `--ago` so the window covers the incident, not the recovery.
