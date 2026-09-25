#!/usr/bin/env node
// SparkDBA demo video: SPARKDBA_TOKEN=... node media/tools/build.mjs [--lang=en] [--rerecord=a,b] [--record-only=a,b]
// 1) speak narration, size each section to its measured speech, rewrite script.md times
// 2) render title/end cards  3) record each section via CDP screencast (cached)
// 4) concat  5) finalize (burned subs + soft subs + narration + .srt)
import { chromium } from "/Users/chase/agentkit/node_modules/playwright/index.mjs";
import * as S from "./subs.mjs";
import { finalize } from "./finalize.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ff = (a) => run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...a], { maxBuffer: 1 << 26 });
const MEDIA = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EN = process.argv.includes("--lang=en");
const T = (zh, en) => (EN ? en : zh);
S.setLang(EN ? "en" : "zh");
const WORK = join(MEDIA, T("work", "work-en"));
const SCRIPT = join(MEDIA, T("script.md", "script.en.md"));
const OUT = join(MEDIA, T("sparkdba-demo.mp4", "sparkdba-demo-en.mp4"));
const URL0 = process.env.SPARKDBA_URL || "http://127.0.0.1:9000/";   // set SPARKDBA_URL to the deployed site
const TOKEN = process.env.SPARKDBA_TOKEN || "";   // never written to the repo
const VOICE = T("Tingting", "Samantha");
const W = 1920, H = 1080, FPS = 30;
const ENC = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS)];
const recordOnly = (process.argv.find((a) => a.startsWith("--record-only="))?.split("=")[1] || "").split(",").filter(Boolean);
const rerecord = new Set((process.argv.find((a) => a.startsWith("--rerecord="))?.split("=")[1] || "").split(",").filter(Boolean));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. narration timing ─────────────────────────────────────────────
const md = await readFile(SCRIPT, "utf8");
const sections = S.parseScript(md);
const cues = S.makeCues(sections);
const measured = await S.speakAll({ cues, outDir: join(WORK, "fin", "tts"), voice: VOICE });
const MIN = [5, 14, 25, 18, 30, 14, 14, 18, 16, 5];     // storyboard minimums
let t = 0;
const spans = sections.map((s, i) => {
  const list = cues.filter((c) => c.chapter === s.title);
  const speech = list.reduce((a, c) => a + measured[c.i], 0) + 0.25 * (list.length - 1);
  const len = Math.max(MIN[i] ?? 0, Math.ceil(speech + (i === 0 ? 0.6 : 1.2)));
  const r = { title: s.title, start: t, len, speech: +speech.toFixed(1) };
  t += len;
  return r;
});
const mmss = (x) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
let md2 = md;
for (const sp of spans) {
  const re = new RegExp(`^## \\d{2}:\\d{2}–\\d{2}:\\d{2} · ${sp.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
  if (!re.test(md2)) throw new Error(`header not found: ${sp.title}`);
  md2 = md2.replace(re, `## ${mmss(sp.start)}–${mmss(sp.start + sp.len)} · ${sp.title}`);
}
await writeFile(SCRIPT, md2);
console.log("spans", spans.map((s) => `${s.title}:${s.len}s(speech ${s.speech})`).join(" "), "total", t);

// ── 2. cards ────────────────────────────────────────────────────────
const CARD_CSS = `*{margin:0;box-sizing:border-box}body{width:${W}px;height:${H}px;background:radial-gradient(1200px 700px at 30% 35%,#1b2410 0%,#141518 60%,#0f1013 100%);
  font-family:-apple-system,"PingFang SC",sans-serif;color:#e9eaee;display:flex;flex-direction:column;justify-content:center;padding:0 200px}
  .k{font:500 30px/1.4 ui-monospace,Menlo,monospace;color:#9a9aa3}.k b{color:#ff6b9d;font-weight:500}
  h1{font-size:132px;font-weight:800;letter-spacing:-.02em;margin:18px 0 8px}h1 em{font-style:normal;color:#76b900}h2{font-size:60px;font-weight:700;color:#e9eaee}h2 em{font-style:normal;color:#76b900}
  .tags{margin-top:48px;display:flex;gap:16px;flex-wrap:wrap}.tags span{border:1px solid #3a3b42;border-radius:999px;padding:10px 24px;font-size:28px;color:#c9c9cf}
  .by{margin-top:40px;font-size:36px;color:#c9c9cf}
  .foot{position:absolute;left:200px;top:72px;font-size:26px;color:#7d7d86}`;
const TITLE_HTML = T(`<div class="k">SELECT root_cause FROM <b>your_data</b>; -- on DGX Spark</div><h1>Spark<em>DBA</em></h1><h2>让数据<em>自己诊断</em>，就在一台 DGX Spark 上</h2>
  <div class="tags"><span>PostgreSQL 16</span><span>TDengine 工业时序</span><span>9 个 Agent Skills</span><span>Nemotron 3.5 · NVFP4</span><span>OpenClaw · Hermes</span></div>
  <div class="foot">第三届 NVIDIA DGX Spark 黑客松 · 团队 GPTOPS</div>`,
  `<div class="k">SELECT root_cause FROM <b>your_data</b>; -- on DGX Spark</div><h1>Spark<em>DBA</em></h1><h2>Data that <em>diagnoses itself</em>, on one DGX Spark</h2>
  <div class="tags"><span>PostgreSQL 16</span><span>TDengine plant telemetry</span><span>9 Agent Skills</span><span>Nemotron 3.5 · NVFP4</span><span>OpenClaw · Hermes</span></div>
  <div class="foot">3rd NVIDIA DGX Spark Hackathon · Team GPTOPS</div>`);
const END_HTML = T(`<h1 style="font-size:112px">Spark<em>DBA</em></h1><h2 style="font-size:52px">判定用规则 · 解读用模型 · 执行有闸门</h2>
  <div class="by">全部运行在一台 NVIDIA DGX Spark（GB10）上 · 画面均为真实录屏</div>
  <div class="foot">团队 GPTOPS · 第三届 NVIDIA DGX Spark 黑客松</div>`,
  `<h1 style="font-size:112px">Spark<em>DBA</em></h1><h2 style="font-size:52px">Rules decide · the model interprets · gates execute</h2>
  <div class="by">Everything runs on one NVIDIA DGX Spark (GB10) · all footage is real screen recording</div>
  <div class="foot">Team GPTOPS · 3rd NVIDIA DGX Spark Hackathon</div>`);
async function card(name, html, len) {
  const png = join(WORK, `${name}.png`), mp4 = join(WORK, `seg-${name}.mp4`);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>${CARD_CSS}</style>${html}`);
  await p.screenshot({ path: png });
  await b.close();
  // gentle fade in/out so cards don't pop
  await ff(["-loop", "1", "-framerate", String(FPS), "-i", png, "-t", String(len),
    "-vf", `fade=in:st=0:d=0.5,fade=out:st=${len - 0.5}:d=0.5`, ...ENC, mp4]);
  return mp4;
}

// ── 3. recording ────────────────────────────────────────────────────
const CURSOR = `addEventListener("DOMContentLoaded",()=>{const c=document.createElement("div");
  c.style.cssText="position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(118,185,0,.35);border:2px solid #76b900;z-index:99999;pointer-events:none;transition:transform .15s;transform:translate(-100px,-100px)";
  document.body.appendChild(c);let x=-100,y=-100;
  addEventListener("mousemove",e=>{x=e.clientX;y=e.clientY;c.style.transform="translate("+x+"px,"+y+"px)"},true);
  addEventListener("mousedown",()=>{c.style.transform="translate("+x+"px,"+y+"px) scale(.6)"},true);
  addEventListener("mouseup",()=>{c.style.transform="translate("+x+"px,"+y+"px)"},true);});`;

function helpers(page) {
  const h = {
    async moveTo(loc) {
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      const bb = await loc.boundingBox();
      if (!bb) throw new Error("no box");
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 18 });
      return bb;
    },
    async click(loc) { await h.moveTo(loc); await sleep(150); await page.mouse.down(); await sleep(80); await page.mouse.up(); },
    btn: (name, n = 0) => page.getByRole("button", { name, exact: false }).nth(n),
    async scroll(y, ms = 900) {
      await page.evaluate(async ([to, ms]) => {
        const from = scrollY, t0 = performance.now();
        await new Promise((res) => { const f = (now) => { const k = Math.min(1, (now - t0) / ms);
          scrollTo(0, from + (to - from) * (k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2)); k < 1 ? requestAnimationFrame(f) : res(); };
          requestAnimationFrame(f); });
      }, [y, ms]);
    },
    async scrollToEl(loc, offset = 120, ms = 900) {
      const y = await loc.evaluate((e, o) => e.getBoundingClientRect().top + scrollY - o, offset);
      await h.scroll(y, ms);
    },
    hover: async (loc) => { await h.moveTo(loc); },
  };
  return h;
}

// Each plan: [atSeconds, async (h, page) => {...}]; the segment is exactly `len` seconds.
const PLANS = {
  home: { hash: "", steps: [
    [1.5, (h, p) => h.hover(p.getByText(T("做了什么", "What the agent did")).first())],
    [5.0, (h, p) => h.scrollToEl(p.locator(".stats").first(), 200, 1200)],
    [9.0, (h, p) => h.scrollToEl(p.getByText(T("一次诊断的流水线", "One diagnosis, end to end")).first(), 160, 1200)],
  ] },
  // runs a real injection and both diagnoses: record only when no eval batch is running
  lab: { hash: "#lab", speed: 3, badge: T("⏩ 3× 加速 · 真实运行", "⏩ 3× speed · real run"), steps: [
    [1.0, (h, p) => h.click(p.getByRole("button", { name: T(/长事务未提交/, /Idle in transaction/) }).first())],
    [3.0, (h) => h.click(h.btn(T("注入故障", "Inject fault")))],
    [16.0, (h) => h.click(h.btn(T("两个都跑", "Run both")))],
    [20.0, (h, p) => h.scrollToEl(p.locator(".trace").first(), 140, 1500)],
    [-7.0, (h, p) => h.scrollToEl(p.locator(".verdict").last(), 760, 1800)],   // both verdict badges in view
  ] },
  workload: { hash: "#workload", steps: [
    [1.5, (h, p) => h.hover(p.getByText("PDDM · Top-5").first())],
    [5.0, async (h, p) => { await p.locator("select").first().selectOption("session"); }],
    [7.0, (h, p) => h.scrollToEl(p.getByText("PSH ·").first(), 140, 1400)],
  ] },
  plant: { hash: "#plant", speed: 4, badge: T("⏩ 4× 加速 · 真实运行", "⏩ 4× speed · real run"), steps: [
    [1.0, (h, p) => h.click(p.getByRole("button", { name: T(/设备过热/, /Overheating/) }).first())],
    [3.0, (h) => h.click(h.btn(T("注入故障", "Inject fault")))],
    [5.0, (h, p) => h.scrollToEl(p.getByText(T("产线良品率", "Line yield")).first(), 160, 1500)],
    [75.0, (h, p) => h.scrollToEl(p.getByText(T("诊断：是哪台设备", "Diagnose: which device")).first(), 120, 1500)],
    [78.0, (h) => h.click(h.btn(T("诊断 · 有技能", "Diagnose · with skills")))],
  ] },
  design: { hash: "#design", steps: [
    [2.0, (h, p) => h.scrollToEl(p.getByText(T("编排智能体", "Orchestrator")).first(), 140, 1500)],
    [6.5, (h, p) => h.scrollToEl(p.getByText(T("负载报告智能体", "Workload agent")).first(), 140, 1500)],
    [10.5, (h, p) => h.scrollToEl(p.getByText(T("工业时序智能体", "Plant agent")).first(), 140, 1500)],
  ] },
  skills: { hash: "#skills", steps: [
    [1.5, (h) => h.click(h.btn("SKILL.md", 0))],
    [6.0, (h) => h.click(h.btn("skill-card.md", 0))],
    [10.0, (h, p) => h.scrollToEl(p.getByText("pg-workload-report").first(), 140, 1500)],
  ] },
  bench: { hash: "#bench", steps: [
    [2.0, (h, p) => h.hover(p.locator("svg").first())],
    [8.0, (h, p) => h.scrollToEl(p.locator(".tbl").first(), 140, 1500)],
  ] },
  safety: { hash: "#safety", steps: [
    [1.5, (h, p) => h.scrollToEl(p.getByText(T("人工处置台", "Operator console")).first(), 120, 1200)],
    [3.5, async (h, p) => { await p.locator("select").first().selectOption("drop_table"); }],
    [5.0, (h) => h.click(h.btn(T("执行", "Execute")))],
    [9.0, async (h, p) => { await p.locator("select").first().selectOption("vacuum_full"); await p.getByPlaceholder("public.events").fill("public.events"); }],
    [10.5, (h) => h.click(h.btn(T("执行", "Execute")))],
  ] },
};

async function record(name, len) {
  const mp4 = join(WORK, `seg-${name}.mp4`);
  if (existsSync(mp4) && !rerecord.has(name)) {
    const d = await S.probeDur(mp4);
    if (Math.abs(d - len) < 0.2) return mp4;
  }
  const plan = PLANS[name];
  const dir = join(WORK, "frames-" + name);
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    const file = join(dir, `${String(n++).padStart(5, "0")}.jpg`);
    frames.push({ file, ts: f.metadata.timestamp });
    writeFile(file, Buffer.from(f.data, "base64"));
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  if (TOKEN) await page.goto(URL0 + "?token=" + TOKEN, { waitUntil: "load", timeout: 60000 });   // sets the auth cookie
  await page.goto(URL0 + (EN ? "?lang=en" : "?lang=zh") + plan.hash, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.waitForTimeout(800);
  await page.mouse.move(W - 300, H - 200);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await page.waitForTimeout(300);
  const sp = plan.speed || 1, wall = len * sp;
  if (plan.badge) await page.evaluate((t) => { const d = document.createElement("div"); d.textContent = t;
    d.style.cssText = "position:fixed;right:32px;top:72px;z-index:99998;background:#76b900;color:#111;font:700 22px/1 -apple-system,sans-serif;padding:10px 16px;border-radius:8px";
    document.body.appendChild(d); }, plan.badge);
  const t0 = Date.now() / 1000, h = helpers(page);
  const log = [];
  const steps = plan.steps.map(([at, fn]) => [at < 0 ? wall + at : at, fn]).sort((a, b) => a[0] - b[0]);
  for (const [at, fn] of steps) {
    const wait = at - (Date.now() / 1000 - t0);
    if (wait > 0) await sleep(wait * 1000);
    try { await Promise.race([fn(h, page), sleep(6000).then(() => { throw new Error("timeout"); })]); log.push(`ok@${at.toFixed(1)}`); }
    catch (e) { log.push(`FAIL@${at.toFixed(1)} ${String(e.message).split("\n")[0].slice(0, 80)}`); }
  }
  if (plan.tailScroll) {
    const rest = wall - 3.5 - (Date.now() / 1000 - t0);
    if (rest > 0) await sleep(rest * 1000);
    await h.scrollToEl(page.getByText(plan.tailScroll).first(), 500, 1200).catch((e) => log.push("tailScroll FAIL"));
  }
  const rest = wall + 0.3 - (Date.now() / 1000 - t0);
  if (rest > 0) await sleep(rest * 1000);
  await cdp.send("Page.stopScreencast");
  await sleep(300);
  await b.close();
  // frames → concat list with real durations (screencast only emits on change)
  const cdpT0 = frames.find((f) => f.ts)?.ts;
  // map wall clock t0 onto screencast clock: first frame arrives right after start (~≤300ms before t0)
  const start = cdpT0 + ((t0 - cdpT0) > 0 && (t0 - cdpT0) < 5 ? (t0 - cdpT0) : 0.3);
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const a = Math.max(frames[i].ts, start), z = Math.min(i + 1 < frames.length ? frames[i + 1].ts : start + wall, start + wall);
    if (z - a <= 0.001) continue;
    lines.push(`file '${frames[i].file}'`, `duration ${((z - a) / sp).toFixed(4)}`);
  }
  lines.push(lines[lines.length - 2]);
  const list = join(dir, "list.txt");
  await writeFile(list, lines.join("\n") + "\n");
  await ff(["-f", "concat", "-safe", "0", "-i", list, "-vf", `scale=${W}:${H}:flags=lanczos,fps=${FPS}`, "-fps_mode", "cfr", "-t", String(len), ...ENC, mp4]);
  console.log(`rec ${name} len=${len} frames=${frames.length} dur=${(await S.probeDur(mp4)).toFixed(2)} ${log.join(" ")}`);
  return mp4;
}

// ── 4/5. assemble + finalize ────────────────────────────────────────
const names = ["title", "home", "lab", "workload", "plant", "design", "skills", "bench", "safety", "end"];
if (recordOnly.length) {
  for (const nm of recordOnly) await record(nm, spans[names.indexOf(nm)].len);
  process.exit(0);
}
const segs = [];
for (let i = 0; i < names.length; i++) {
  const nm = names[i], len = spans[i].len;
  if (nm === "title") segs.push(await card("title", TITLE_HTML, len));
  else if (nm === "end") segs.push(await card("end", END_HTML, len));
  else segs.push(await record(nm, len));
}
const listFile = join(WORK, "concat.txt");
await writeFile(listFile, segs.map((f) => `file '${f}'`).join("\n") + "\n");
const base = join(WORK, "base.mp4");
await ff(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", base]);
await rm(join(WORK, "fin", "subpng"), { recursive: true, force: true });
const r = await finalize({ baseVideo: base, scriptFile: SCRIPT, outFile: OUT, workDir: join(WORK, "fin"), voice: VOICE, titleSec: 0 });
console.log(JSON.stringify({ ...r, spans }, null, 1));
