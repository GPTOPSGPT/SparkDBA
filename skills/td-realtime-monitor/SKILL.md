---
name: td-realtime-monitor
description: "Real-time analysis advisor for plant telemetry in TDengine: create zero-code monitors from a sentence (device/line/kind + metric + threshold + window), list/delete them, check which fire now, and read the alert journal. Use when: 帮我盯着, alert me if, 持续监控, create a monitor/alarm/threshold, 实时分析. Not for: one-off diagnosis (use td-root-cause), PostgreSQL, changing plant data or device settings."
license: Apache-2.0
metadata: { "openclaw": { "emoji": "⏱️", "requires": { "bins": ["bash"] } } }
---

# Real-time monitor advisor

## Run

```bash
"$SKILL_DIR/scripts/run.sh" create --name oven-hot --kind oven --metric temperature --op '>' --value 200 --window 30 --agg avg
"$SKILL_DIR/scripts/run.sh" list
"$SKILL_DIR/scripts/run.sh" check
"$SKILL_DIR/scripts/run.sh" alerts --n 20
"$SKILL_DIR/scripts/run.sh" delete --name oven-hot
```

A background evaluator checks every monitor every 5 s and journals at most one alert per monitor and device per minute.

## Rules

- Translate the user's sentence into exactly one selector (`--device`, `--line` or `--kind`), one metric
  (temperature, vibration, pressure, current, status), `>` or `<`, a number, and a window in seconds. Confirm it back in one line.
- If the threshold or target is missing, ask; do not invent one.
- Monitors only observe and journal. They never change devices or data.
