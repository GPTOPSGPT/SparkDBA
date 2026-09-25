---
name: td-insight
description: "Data-insight advisor for plant telemetry in TDengine: health of every device and line over a window versus the baseline before it — metric shifts, flatlined sensors, data gaps, status codes, yield changes — as findings plus a one-line summary for a report. Use when: 看看产线/设备状态, health check, daily/periodic report, trends, anomalies, 洞察, 周报. Not for: explaining why a specific drop happened (use td-root-cause), PostgreSQL, changing data."
license: Apache-2.0
metadata: { "openclaw": { "emoji": "🔎", "requires": { "bins": ["bash"] } } }
---

# Data insight advisor

## Run

```bash
"$SKILL_DIR/scripts/run.sh" health --minutes 1 --baseline 30 [--ago 0]
```

Returns `findings` (severity 3 = act now, 2 = look) with device, kind (`shift`, `flatline`, `data_gap`,
`no_data`, `status`, `yield_drop`) and the numbers behind each, plus `yield_pct` for window vs baseline.

## Rules

- Keep the window on the incident: `--minutes 1` for "just now", wider only if the user says so. A wide window mixes in earlier, already-resolved events.
- Report the numbers as given (e.g. `temperature 180.4 -> 219.7 (z=+31.0)`); do not round them into adjectives.
- A flatline is a sensor/data-quality problem, not a process problem.
- Findings are observations. For a cause, hand over to td-root-cause.
