#!/usr/bin/env node
// 中文字幕 + 语音播报。
//
// 为什么字幕要走"渲染成图再叠"这条路：本机 ffmpeg 9.0.1 **没有** drawtext /
// subtitles / ass 三个滤镜（实测 ✗），烧录字幕的常规做法全部不可用。
// 所以用 headless Chromium 把每条字幕渲染成透明 PNG，拼成一条带 alpha 的
// 覆盖轨（qtrle/mov），最后一次 overlay 叠上去 —— 只做一次叠加，
// 比给每条字幕挂一个 enable=between(...) 的 overlay 稳得多（那样 80+ 条会把
// filter_complex 撑爆）。
//
// 同时输出 .srt 并混流成 mov_text 软字幕轨：烧录的关不掉，软轨可开关，两个都给。
import { chromium } from "/Users/chase/agentkit/node_modules/playwright/index.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve, dirname, basename, extname } from "node:path";
import { existsSync } from "node:fs";

const run = promisify(execFile);
const ff = (args, opt = {}) => run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args],
                                  { maxBuffer: 1 << 26, ...opt });

/** ── 1. 解析脚本 ────────────────────────────────────────────────────
 * video-script.md 的每节形如：
 *   ## 00:25–01:15 · 主线演示：一键故障注入 → 七阶段闭环
 *   - **屏幕**：…
 *   - **口播**：「…」
 * 只取「口播」，那才是要念、要显示的内容；「屏幕」是给录制用的。
 * 破折号用的是 – (U+2013) 不是 -，别写错。
 */
// 两份脚本的标题写法不同，都要认：
//   Claude: `## 00:25–01:15 · 标题`，口播在同一行 `- **口播**：「…」`
//   Codex : `## 00:30–01:15｜标题`，`**口播词**` 独占一行，正文在其后的段落
// 分隔符可能是 · 或 ｜ 或 |；破折号可能是 – — -，全都放进字符类里。
const SEC_RE = /^##\s+(\d{1,2}):(\d{2})[–\-—](\d{1,2}):(\d{2})\s*[·｜|]\s*(.+?)\s*$/;
const NARR_INLINE = /^-\s*\*\*(?:口播词?|Narration)\*\*[：:]\s*(.+)$/;
const NARR_HEAD = /^\*\*口播词?\*\*\s*$/;
const QUOTES = /^[「“"']+|[」”"']+$/g;


// 字幕文本 → 朗读文本。字幕照原样显示，只改 say 听到的字：
//   · 能按单词读的英文别拆字母（SQL→塞扣、Prometheus→普若米修斯、Alertmanager→两个词）
//   · 缩写按字母读（BIC-QA、KWR、KES、PID、AAS、TPC-C）
//   · 斜线/连字符不读，换成停顿
// English mode (build.mjs --lang=en): different cue splitting and pronunciation rules.
let LANG = "zh";
export function setLang(l) { LANG = l; }

const EN_RULES = [
  [/\bPostgreSQL\b/g, "Postgres Q L"], [/\bTDengine\b/g, "T D engine"], [/\bNVFP4\b/g, "N V F P 4"],
  [/\bGB10\b/g, "G B 10"], [/\bSKILL\.md\b/g, "skill dot M D"], [/\bKWR\b/g, "K W R"], [/\bKSH\b/g, "K S H"],
  [/\bKDDM\b/g, "K D D M"], [/\bSQL\b/g, "S Q L"], [/\bL2\b/g, "L 2"], [/\bAI\b/g, "A I"], [/\bDGX\b/g, "D G X"],
  [/\bGPTOPS\b/g, "G P T ops"], [/\bpid\b/g, "P I D"], [/\s*\/\s*/g, ", "],
];

export function ttsText(t) {
  if (LANG === "en") return EN_RULES.reduce((x, [re, rep]) => x.replace(re, rep), t);
  const rules = [
    [/TiDB/g, "钛 D B"], [/TiKV/g, "钛 K V"], [/TiFlash/g, "钛 Flash"],
    [/raft-election-timeout-ticks/g, "raft election timeout ticks"],
    [/balance-region/g, "balance region"], [/balance-leader/g, "balance leader"],
    [/read_index/g, "read index"], [/wait_index/g, "wait index"],
    [/start_ts/g, "start T S"], [/commit_ts/g, "commit T S"],
    [/mpp\[tiflash\]/g, "M P P tiflash"], [/annIndex/g, "ann index"],
    [/(\d+)MiB/g, "$1 M i B"], [/\bv(\d)\.(\d)\.(\d)/g, "V $1.$2.$3"], [/\bv(\d)\.(\d)/g, "V $1.$2"],
    [/store-(\d)/g, "store $1"], [/\bT([12])\b/g, "T $1"],
    [/\bHTAP\b/g, "H T A P"], [/\bHNSW\b/g, "H N S W"], [/\bDDL\b/g, "D D L"],
    [/\bPD\b/g, "P D"], [/\bSQL\b/g, "S Q L"], [/\bL2\b/g, "L 2"], [/\bAI\b/g, "A I"],
    [/\s*\/\s*/g, "，"],
  ];
  return rules.reduce((x, [re, rep]) => x.replace(re, rep), t);
}

export function parseScript(md) {
  const out = [];
  let cur = null, expectNarr = false;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const m = SEC_RE.exec(line);
    if (m) {
      cur = { start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4], title: m[5], text: "" };
      out.push(cur);
      expectNarr = false;
      continue;
    }
    const inline = NARR_INLINE.exec(line);
    if (inline && cur) { cur.text = inline[1].replace(QUOTES, "").trim(); expectNarr = false; continue; }
    if (NARR_HEAD.test(line)) { expectNarr = true; continue; }
    if (expectNarr && cur) {
      if (!line) continue;                       // 标题与正文之间的空行
      if (line.startsWith("**") || line.startsWith("##")) { expectNarr = false; continue; }
      cur.text = line.replace(QUOTES, "").trim();
      expectNarr = false;
    }
  }
  return out.filter((s) => s.text);
}

/** ── 2. 切成字幕条 ──────────────────────────────────────────────────
 * 按中文标点断句，再把过长的句子按 maxLen 硬切。
 * 时间按**字数比例**分配到该节的区间里 —— 不是平均分：长句本来就该占更久，
 * 平均分会让长句一闪而过、短句杵在屏幕上不动。
 */
const ASCII_WORD = /[A-Za-z0-9_\[\].\-]/;

/** 按 maxLen 切长句，但切点避开西文词内部。 */
function hardSplit(text, maxLen) {
  const out = [];
  let rest = text;
  while (rest.length > maxLen + 4) {
    let cut = maxLen;
    // 从 maxLen 往回找一个安全切点：两侧不同时是 ASCII 字母数字
    while (cut > 6 && ASCII_WORD.test(rest[cut - 1]) && ASCII_WORD.test(rest[cut])) cut--;
    if (cut <= 6) cut = maxLen;          // 整段都是西文，只能硬切
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

export function makeCues(sections, { maxLen = LANG === "en" ? 64 : 28, minSec = 1.2, minPiece = LANG === "en" ? 18 : 8 } = {}) {
  const cues = [];
  const joiner = LANG === "en" ? " " : "";
  for (const s of sections) {
    const pieces = [];
    for (const part of s.text.split(LANG === "en" ? /(?<=[.!?;])\s+/ : /(?<=[。！？；])/)) {
      const t = part.trim();
      if (!t) continue;
      if (t.length <= maxLen) { pieces.push(t); continue; }
      // 长句先在逗号处切，仍超长再按 maxLen 截
      let buf = "";
      for (const sub of t.split(/(?<=[，、,：:])/)) {
        if ((buf + sub).length > maxLen && buf) { pieces.push(buf.trim()); buf = sub; }
        else buf += sub;
      }
      if (buf) pieces.push(buf);
      // 还有没有标点可切的长句（实测最长 45 字），按 maxLen 硬切 ——
      // 一行 45 字在 1600px 上要么溢出要么缩到看不清，宁可断行也不要塞满。
      // 但**不能从西文词中间切**：早先按字符数一刀切，切出过 "ry-run，"
      // （dry-run）、"PC-C 负载。"（TPC-C）、"I 做根因分析。"（AI）这种断词。
      // 切点必须落在「两侧不同时是 ASCII 字母数字」的位置上。
      for (let k = pieces.length - 1; k >= 0; k--) {
        if (pieces[k].length <= maxLen + 4) continue;
        pieces.splice(k, 1, ...hardSplit(pieces[k], maxLen));
      }
    }
    // 切分会留下短碎片（"。"后跟个短尾巴，或硬切的余数）。阈值从 3 提到 8 ——
    // 实测 79 条里有 11 条 ≤8 字，像 "更重要的是：""七维采样、" 这种单独挂在
    // 屏幕上既读不出意思、又一闪而过。并进相邻条，优先并前面。
    for (let k = pieces.length - 1; k > 0; k--) {
      if (pieces[k].length <= minPiece && pieces[k - 1].length + pieces[k].length <= maxLen + 10) {
        pieces[k - 1] += joiner + pieces[k];
        pieces.splice(k, 1);
      }
    }
    // 首条太短只能并到后面去
    if (pieces.length > 1 && pieces[0].length <= minPiece
        && pieces[0].length + pieces[1].length <= maxLen + 10) {
      pieces[1] = pieces[0] + joiner + pieces[1];
      pieces.shift();
    }
    if (LANG === "en") pieces.forEach((p, i) => { pieces[i] = p.replace(/\s+/g, " ").trim(); });
    const span = Math.max(0.1, s.end - s.start);
    const chars = pieces.reduce((a, p) => a + p.length, 0) || 1;
    let t = s.start;
    pieces.forEach((p, i) => {
      const d = Math.max(minSec, span * (p.length / chars));
      cues.push({ i: cues.length + 1, start: t, end: Math.min(s.end, t + d),
                  text: p, chapter: s.title });
      t += d;
    });
    // 比例分配可能因 minSec 撑出区间，压回去，保证不跨节
    const over = t - s.end;
    if (over > 0.01) {
      const k = span / (t - s.start);
      let a = s.start;
      for (const c of cues.slice(cues.length - pieces.length)) {
        const d = (c.end - c.start) * k;
        c.start = a; c.end = a + d; a += d;
      }
    }
  }
  return cues;
}

/** ── 3. SRT ───────────────────────────────────────────────────────── */
const srtTime = (t) => {
  const ms = Math.round(t * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, "0");
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
};

export function toSrt(cues, offset = 0) {
  return cues.map((c, i) =>
    `${i + 1}\n${srtTime(c.start + offset)} --> ${srtTime(c.end + offset)}\n${c.text}\n`).join("\n");
}

/** ── 4. 把字幕渲染成一条带 alpha 的覆盖轨 ────────────────────────────
 * 一次 Chromium 启动画完所有帧（每条字幕一张 PNG），再用 concat demuxer
 * 按各自时长拼成 qtrle/mov —— qtrle 保 alpha，libx264 不保。
 * 空隙（没有字幕的时间）插一张全透明帧，否则上一条会一直挂在屏幕上。
 */
export async function renderSubTrack({ cues, width, height, outFile, workDir,
                                       totalSec, offset = 0, fps = 10 }) {
  await mkdir(workDir, { recursive: true });
  const css = `
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:${width}px;height:${height}px;background:transparent;
      font-family:"PingFang SC","Heiti SC",-apple-system,sans-serif}
    .box{position:absolute;left:0;right:0;bottom:44px;display:flex;justify-content:center}
    .t{max-width:${Math.round(width * 0.82)}px;padding:12px 26px;border-radius:10px;
      background:rgba(8,11,16,.82);color:#fff;font-size:38px;line-height:1.45;
      font-weight:500;letter-spacing:.02em;text-align:center;
      text-shadow:0 2px 8px rgba(0,0,0,.9);
      border:1px solid rgba(255,255,255,.10)}`;
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  // 全透明帧：用于字幕之间的空档
  const blank = join(workDir, "sub-blank.png");
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>`);
  await page.screenshot({ path: blank, omitBackground: true });

  const items = [];           // {file, dur}
  let cursor = 0;
  for (const c of cues) {
    const st = c.start + offset, en = c.end + offset;
    if (st - cursor > 0.02) items.push({ file: blank, dur: st - cursor });
    const png = join(workDir, `sub-${String(c.i).padStart(3, "0")}.png`);
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>${css}</style>
       <div class="box"><div class="t">${esc(c.text)}</div></div>`);
    await page.screenshot({ path: png, omitBackground: true });
    items.push({ file: png, dur: Math.max(0.05, en - st) });
    cursor = en;
  }
  if (totalSec > cursor) items.push({ file: blank, dur: totalSec - cursor });
  await b.close();

  // concat demuxer 有个坑：最后一条的 duration 会被忽略，必须把最后一个文件再写一遍。
  // concat 清单里的路径是相对**清单文件所在目录**解析的，写相对路径会被拼两次。
  const abs = (f) => resolve(f);
  const list = items.map((it) => `file '${abs(it.file)}'\nduration ${it.dur.toFixed(3)}`).join("\n")
             + `\nfile '${abs(items[items.length - 1].file)}'\n`;
  const listFile = join(workDir, "sub-list.txt");
  await writeFile(listFile, list, "utf8");

  await ff(["-f", "concat", "-safe", "0", "-i", listFile,
            // ffmpeg 9 删了 -vsync；且 -r 不能和 vfr 同用（会报 contradictory）。
            // 这条轨是拿来 overlay 的，定帧率(cfr)比可变帧率更好对齐，就用 cfr。
            // concat 末帧要重复写一遍才不被丢，代价是会多出一截；用 -t 截回目标时长。
            "-fps_mode", "cfr", "-r", String(fps), "-t", totalSec.toFixed(3),
            "-c:v", "qtrle", "-pix_fmt", "argb", outFile]);
  return { outFile, frames: items.length };
}

/** ── 5. 语音播报 ────────────────────────────────────────────────────
 * macOS 自带 `say`（本机有 9 个 zh_CN 声音），不联网、不花钱。
 * 每条字幕单独合成，再用 atempo 压到该条的时长内 —— 不压的话念得比字幕慢，
 * 越往后越对不上，到片尾能差出十几秒。atempo 低于 0.5 会失真，
 * 所以只在"念得太慢"时压，念得快就让它留白，不做拉伸。
 */
export async function synthNarration({ cues, outFile, workDir, voice = "Tingting",
                                       totalSec, offset = 0 }) {
  await mkdir(workDir, { recursive: true });
  const parts = [];
  for (const c of cues) {
    const aiff = join(workDir, `tts-${String(c.i).padStart(3, "0")}.wav`);
    const m4a = join(workDir, `tts-${String(c.i).padStart(3, "0")}.m4a`);
    // say 的 --data-format 不能单独给（报 "Opening output file failed: fmt?"），
    // 必须与 --file-format 成对出现。实测这个组合可用。
    // 文本经 -f 文件传，不放 argv：以「C 档…」「-…」开头的字幕会被 say 当成选项（实测 invalid option -- C）
    await writeFile(aiff + ".txt", ttsText(c.text), "utf8");
    await run("say", ["-v", voice, "-o", aiff,
                      "--file-format=WAVE", "--data-format=LEI16@22050", "-f", aiff + ".txt"]);
    const raw = await probeDur(aiff);
    const budget = Math.max(0.4, c.end - c.start);
    // 只压不拉：念得比字幕快就留白，比字幕慢才加速
    let tempo = raw > budget ? raw / budget : 1;
    tempo = Math.min(tempo, 2.0);              // 再快就听不清了，宁可轻微溢出
    const af = tempo > 1.001 ? ["-filter:a", `atempo=${tempo.toFixed(4)}`] : [];
    await ff(["-i", aiff, ...af, "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-ac", "2", m4a]);
    parts.push({ file: m4a, at: (c.start + offset) * 1000, tempo: +tempo.toFixed(3),
                 raw: +raw.toFixed(2), budget: +budget.toFixed(2) });
  }

  // 用 adelay 把每条放到时间轴上，再 amix。amix 会按输入数衰减音量，
  // 这里每一刻其实只有一条在响，所以 normalize=0 保持原音量。
  const inputs = parts.flatMap((p) => ["-i", p.file]);
  const chains = parts.map((p, i) => `[${i}:a]adelay=${Math.round(p.at)}|${Math.round(p.at)}[a${i}]`);
  const mix = `${parts.map((_, i) => `[a${i}]`).join("")}amix=inputs=${parts.length}:normalize=0:dropout_transition=0[mix]`;
  const pad = `[mix]apad,atrim=0:${totalSec.toFixed(3)},aresample=44100[out]`;
  await ff([...inputs, "-filter_complex", `${chains.join(";")};${mix};${pad}`,
            "-map", "[out]", "-c:a", "aac", "-b:a", "128k", outFile]);
  const over = parts.filter((p) => p.tempo >= 1.999);
  return { outFile, cues: parts.length, sped: parts.filter((p) => p.tempo > 1.001).length,
           maxTempo: Math.max(...parts.map((p) => p.tempo)), clipped: over.length };
}

async function probeDur(f) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
                                           "-of", "default=nw=1:nk=1", f]);
  return parseFloat(stdout.trim());
}
export { probeDur };

/** ── 6. 按实测语音时长排布字幕 ──────────────────────────────────────
 * 先前按**字数比例**切时间是错的：字数和念出来的秒数不成正比（数字、英文、
 * 标点差很多），结果是有的句子被逼到 1.76× 语速，而同一节里其实还有富余。
 *
 * 正确做法：先按自然语速合成、量出每条真实时长，再在本节区间内顺排。
 * 实测全片自然语速 252.9s / 片长 310s —— 整体放得下，只有一节需要 1.10×。
 * 放得下就插间隔（句子之间留白，听感自然），放不下才整节等比加速。
 * 字幕时间与配音时间同源，不会出现"字出来了声没跟上"。
 */
export function planBySpeech({ cues, sections, measured, maxTempo = 1.6, minGap = 0.12 }) {
  const byChapter = new Map();
  for (const c of cues) {
    if (!byChapter.has(c.chapter)) byChapter.set(c.chapter, []);
    byChapter.get(c.chapter).push(c);
  }
  const plan = [];
  for (const sec of sections) {
    const list = byChapter.get(sec.title) || [];
    if (!list.length) continue;
    const span = sec.end - sec.start;
    const speech = list.reduce((a, c) => a + measured[c.i], 0);
    const needed = speech + minGap * (list.length - 1);
    let tempo = 1, gap = minGap;
    if (needed > span) {
      tempo = Math.min(maxTempo, speech / Math.max(0.1, span - minGap * (list.length - 1)));
      gap = Math.max(0, (span - speech / tempo) / Math.max(1, list.length - 1));
      // 压到上限仍放不下就**如实溢出**，不再继续加速。
      // 1.88× 的中文语速已经听不清了，宁可让片尾多几秒（finalize 会补冻结帧），
      // 也不要为了凑一个"正好 5:00"把话说得没人听得懂。
    } else {
      gap = (span - speech) / Math.max(1, list.length);   // 均摊到句间与句尾
    }
    let t = sec.start;
    for (const c of list) {
      const d = measured[c.i] / tempo;
      plan.push({ ...c, start: t, end: t + d, tempo: +tempo.toFixed(4), speechSec: +d.toFixed(2) });
      t += d + gap;
    }
  }
  return plan;
}

/** 按已排定的 plan 合成音轨（tempo 已在 plan 里定好，这里不再自己决定快慢）。 */
export async function renderNarration({ plan, srcDir, outFile, workDir, totalSec, offset = 0 }) {
  await mkdir(workDir, { recursive: true });
  const parts = [];
  for (const c of plan) {
    const src = join(srcDir, `${c.i}.wav`);
    const m4a = join(workDir, `a-${String(c.i).padStart(3, "0")}.m4a`);
    const af = c.tempo > 1.001 ? ["-filter:a", `atempo=${c.tempo.toFixed(4)}`] : [];
    await ff(["-i", src, ...af, "-c:a", "aac", "-b:a", "112k", "-ar", "44100", "-ac", "2", m4a]);
    parts.push({ file: m4a, at: Math.round((c.start + offset) * 1000) });
  }
  const inputs = parts.flatMap((p) => ["-i", p.file]);
  const chains = parts.map((p, i) => `[${i}:a]adelay=${p.at}|${p.at}[a${i}]`);
  const mix = `${parts.map((_, i) => `[a${i}]`).join("")}amix=inputs=${parts.length}:normalize=0:dropout_transition=0[m]`;
  const pad = `[m]apad,atrim=0:${totalSec.toFixed(3)},aresample=44100[out]`;
  await ff([...inputs, "-filter_complex", `${chains.join(";")};${mix};${pad}`,
            "-map", "[out]", "-c:a", "aac", "-b:a", "128k", outFile]);
  return { outFile, cues: parts.length };
}

/** 自然语速合成一遍并量时长（只做一次，后面重排都复用这批 wav）。 */
export async function speakAll({ cues, outDir, voice = "Tingting" }) {
  await mkdir(outDir, { recursive: true });
  const measured = {};
  for (const c of cues) {
    const f = join(outDir, `${c.i}.wav`);
    if (!existsSync(f)) {
      await writeFile(f + ".txt", ttsText(c.text), "utf8");
      await run("say", ["-v", voice, "-o", f,
                        "--file-format=WAVE", "--data-format=LEI16@22050", "-f", f + ".txt"]);
    }
    measured[c.i] = await probeDur(f);
  }
  return measured;
}
