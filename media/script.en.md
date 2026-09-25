# SparkDBA demo video · narration script (English)

- Entry: SparkDBA (3rd NVIDIA DGX Spark Hackathon · Team GPTOPS)
- Voice: macOS `say`, voice Samantha (en_US); burned-in subtitles + mov_text soft subtitles + matching .srt
- Timings are rewritten by `media/tools/build.mjs --lang=en` from measured speech; do not edit them by hand
- All footage is real screen recording of the live site; numbers come from the eval result files

## 00:00–00:06 · Title
- **Screen**: title card
- **Narration**: SparkDBA. Data that diagnoses itself, on one DGX Spark.

## 00:06–00:23 · Overview
- **Screen**: home page, recent agent runs, stat cards, pipeline
- **Narration**: The model, the databases and the evaluation all run on this one Spark. NVIDIA Nemotron 3.5 in NVFP4, served locally, so no data leaves the box. Nine Agent Skills handle evidence, root cause and tiered remediation.

## 00:23–00:48 · Fault lab
- **Screen**: inject "idle in transaction" → run both → the skills side names the holder; the baseline gets it wrong
- **Narration**: We inject an idle-in-transaction fault. The session holding the lock is idle, so looking only at active sessions will miss it. Same model, same tools; the only difference is the skills. With skills, the agent finds the blocking process and the table. The baseline calls it lock contention.

## 00:48–01:07 · Workload report
- **Screen**: Top-5 check cards; average active sessions sliced by session
- **Narration**: What about incidents that are already over? We rebuilt Kingbase's KWR, KSH and KDDM for stock PostgreSQL: per-second session history, counter snapshots and Top-5 threshold checks. Even after recovery, slicing by session still finds the lock holder.

## 01:07–01:37 · Plant telemetry
- **Screen**: TDengine line yield and device charts → inject L2 oven overheating → the diagnosis names the device
- **Narration**: The same agent, a different kind of data. A simulated plant writes telemetry from fifteen devices into TDengine every second. We inject overheating on the L2 oven, and yield drops. The root-cause advisor names the device, the temperature rise and the yield change, and every number traces back to a query.

## 01:37–01:51 · Agent design
- **Screen**: four-components page, scrolling agent by agent
- **Narration**: Every agent is described by four components: perception, planning and reasoning, tools, and memory. Rules decide, the model interprets, and gates execute.

## 01:51–02:05 · Agent Skills
- **Screen**: skill list, SKILL.md and skill card opened
- **Narration**: Each skill is a directory packaged in NVIDIA's format: triggers, scripts, eval cases, a benchmark report and a skill card. OpenClaw and Hermes both discover and use them directly.

## 02:05–02:24 · Benchmark
- **Screen**: benchmark charts and per-task table
- **Narration**: Ground truth is the fault we actually injected, and each mode runs every task three times. With skills, database root-cause accuracy goes from thirty-three to ninety-six percent, and plant diagnosis from seventeen to one hundred. Every run counts, failures included.

## 02:24–02:40 · Safety
- **Screen**: operator console: drop_table refused; VACUUM FULL needs the table name repeated
- **Narration**: Fixes only go through a fixed catalog. A request to drop a table is refused outright. High-risk actions show their impact first, and run only after a human repeats the target. Confirmation comes from a person, never from the agent.

## 02:40–02:45 · Closing
- **Screen**: end card
- **Narration**: SparkDBA, by Team GPTOPS. Thank you.
