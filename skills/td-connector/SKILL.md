---
name: td-connector
description: "Read-only connector to the plant's TDengine time-series database (database plant: super table sensors = per-device temperature/vibration/pressure/current/status; output = per-line produced/good). Discover devices, lines and schema, and run guarded SELECT/SHOW/DESCRIBE queries. Use when: questions about production lines, devices, sensors, telemetry, yield/良品率, 设备, 产线, TDengine. Not for: PostgreSQL / the shop database (use the pg-* skills), writing or deleting data, non-plant questions."
license: Apache-2.0
metadata: { "openclaw": { "emoji": "🔌", "requires": { "bins": ["bash"] } } }
---

# TDengine connector (plant)

The connector gets the data; the four td-* advisors know how to use it.

## Run

```bash
"$SKILL_DIR/scripts/run.sh" schema
"$SKILL_DIR/scripts/run.sh" query --sql "SELECT _wstart, avg(temperature) FROM sensors WHERE device_id='L2-oven' AND ts > now-10m INTERVAL(30s)"
```

`$SKILL_DIR` is the directory containing this SKILL.md.

## Data model

| super table | columns | tags |
|---|---|---|
| `sensors` | ts, temperature, vibration, pressure, current, status (0 ok, 2 fault) | device_id (e.g. L2-oven), line (L1–L3), kind |
| `output` | ts, produced, good (per second) | line |

Yield = sum(good) / sum(produced). TDengine SQL: `now - 5m`, `INTERVAL(10s)`, `PARTITION BY device_id`, `_wstart`.

## Rules

- Read-only: the script accepts one SELECT / SHOW / DESCRIBE statement. TDengine OSS has no GRANT, so this guard is the enforcement.
- Always bound queries by time (`ts > now - Nm`); telemetry is one row per device per second.
- For diagnosis prefer the advisors (td-insight, td-root-cause) over hand-written SQL.
