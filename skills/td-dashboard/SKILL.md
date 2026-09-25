---
name: td-dashboard
description: "Dashboard advisor for plant telemetry in TDengine: save an analysis as a live panel (title + guarded SELECT + line/bar chart + refresh) that the SparkDBA UI renders, and list/delete/render panels. Use when: 做个看板, make a dashboard/chart/panel, 可视化, 固化成面板, show me a trend chart. Not for: diagnosis (use td-root-cause), PostgreSQL, writing data."
license: Apache-2.0
metadata: { "openclaw": { "emoji": "📊", "requires": { "bins": ["bash"] } } }
---

# Dashboard advisor

## Run

```bash
"$SKILL_DIR/scripts/run.sh" create --title "L2 oven temperature" --chart line --refresh 10 \
  --sql "SELECT _wstart, avg(temperature) FROM sensors WHERE device_id='L2-oven' AND ts > now-30m INTERVAL(30s)"
"$SKILL_DIR/scripts/run.sh" list
"$SKILL_DIR/scripts/run.sh" render --id <id>
"$SKILL_DIR/scripts/run.sh" delete --id <id>
```

The first column is the x axis; each other column becomes a series. The SQL is run once before saving, so a broken panel is never stored.

## Rules

- Always bound by time (`ts > now - Nm`) and aggregate with `INTERVAL(...)`: raw 1-second rows make unreadable charts.
- One question per panel; name it after what it answers.
- Read-only SQL only (same guard as td-connector).
