#!/usr/bin/env node
// 给成片加：烧录中文字幕 + 可开关软字幕轨 + 语音播报。
//
// 三样都给，是因为各有各的失效场景：
//   · 烧录字幕：任何播放器都能看，但关不掉；
//   · mov_text 软轨：能开关、能复制文字，但有些播放器默认不显示；
//   · 独立 .srt：投稿/上传平台通常要这个。
// 语音走 macOS 自带 say（本机 9 个 zh_CN 声音），离线、无 API 成本。
import * as S from "./subs.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname, basename, extname } from "node:path";
import { existsSync } from "node:fs";

const run = promisify(execFile);
const ff = (a) => run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...a],
                      { maxBuffer: 1 << 26 });

export async function finalize({ baseVideo, scriptFile, outFile, workDir,
                                 voice = "Tingting", titleSec = 0, burn = true }) {
  const base = resolve(baseVideo), out = resolve(outFile), wd = resolve(workDir);
  await mkdir(wd, { recursive: true });
  if (!existsSync(base)) throw new Error(`成片不存在: ${base}`);

  const dur = await S.probeDur(base);
  const sections = S.parseScript(await readFile(resolve(scriptFile), "utf8"));
  if (!sections.length) throw new Error("脚本里没解析出任何「口播」段落");
  const rawCues = S.makeCues(sections);

  // 片头占的秒数：字幕/配音都要整体后移，否则从第 0 秒就开始念，压在片头上。
  const offset = titleSec;

  const ttsDir = join(wd, "tts");
  const measured = await S.speakAll({ cues: rawCues, outDir: ttsDir, voice });
  const plan = S.planBySpeech({ cues: rawCues, sections, measured });

  // 排布后必须复核：不能越过片尾，也不能互相重叠 —— 这两样出问题时画面上
  // 看不出来（字幕照常闪），只有对着时间轴数才发现，所以在这里断言。
  const last = plan[plan.length - 1];
  const overlaps = plan.filter((c, i) => i > 0 && c.start < plan[i - 1].end - 0.01);
  if (overlaps.length) throw new Error(`字幕排布重叠 ${overlaps.length} 处`);

  // 口播比画面长时补一段冻结末帧。为什么允许这样：Codex 那份脚本给末节
  // 「合规」写了 28.2s 的词却只留 15s，压到 1.88× 已经听不清 —— 与其为了凑
  // 整 5:00 把话说糊，不如让片尾多几秒。但只允许**尾部**溢出：中间章节溢出
  // 会让后面所有字幕和画面错位，那必须报错让人去改脚本。
  const need = last.end + offset;
  let padSec = 0;
  if (need > dur + 0.3) {
    const midOverflow = plan.slice(0, -1).some((c, i) => {
      const sec = sections.find((s) => s.title === c.chapter);
      return sec && c.end > sec.end + 1.0 && c.chapter !== sections[sections.length - 1].title;
    });
    if (midOverflow) {
      throw new Error("中间章节的口播超出其时间段，会导致后续字幕与画面整体错位 —— 请缩短该节口播词");
    }
    padSec = Math.ceil((need - dur) * 10) / 10 + 0.5;
    if (padSec > 20) throw new Error(`片尾需补 ${padSec}s，超过 20s 上限 —— 脚本与片长差得太多`);
  }
  let src = base;
  if (padSec > 0) {
    src = join(wd, "padded.mp4");
    await ff(["-i", base, "-vf", `tpad=stop_mode=clone:stop_duration=${padSec}`,
              "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", src]);
  }
  const vidDur = padSec > 0 ? await S.probeDur(src) : dur;

  // ① 独立 srt（带片头偏移）
  const srt = out.replace(/\.mp4$/, "") + ".srt";
  await writeFile(srt, S.toSrt(plan, offset), "utf8");

  // ② 语音轨
  const audio = join(wd, "narration.m4a");
  const nar = await S.renderNarration({ plan, srcDir: ttsDir, outFile: audio,
                                        workDir: join(wd, "aparts"), totalSec: vidDur, offset });

  // ③ 烧录字幕轨（透明 overlay）
  let vmap = ["-map", "0:v:0"], vcodec = ["-c:v", "copy"], extra = [];
  if (burn) {
    const w = 1920, h = 1080;
    const subMov = join(wd, "subtrack.mov");
    await S.renderSubTrack({ cues: plan, width: w, height: h, outFile: subMov,
                             workDir: join(wd, "subpng"), totalSec: vidDur, offset });
    extra = ["-i", subMov];
    vmap = ["-map", "[v]"];
    vcodec = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"];
  }

  // ffmpeg 要求**所有 -i 排在任何 -map 之前**，混着写会报
  // "cannot be applied to input url ... Move this option before the file"。
  // 所以先把输入按固定次序摆好，再统一 map：0=视频 1=音频 [2=字幕轨] 末位=srt
  // srt 也塞进容器做软字幕轨：mov_text 是 mp4 里唯一通用的字幕编码。
  const inputs = ["-i", src, "-i", audio, ...extra, "-i", srt];
  const srtIdx = 2 + (burn ? 1 : 0);
  const args = [...inputs];
  if (burn) args.push("-filter_complex", "[0:v][2:v]overlay=0:0:format=auto[v]");
  args.push(...vmap, "-map", "1:a:0", "-map", `${srtIdx}:s:0`,
            "-c:s", "mov_text", "-metadata:s:s:0", "language=chi",
            // 用显式 -t 而不是 -shortest。带字幕流时 -shortest 会等一个永远不再
            // 产包的输入，表现为进程 0% CPU 挂死（实测两次各卡 40min / 2h18m，
            // 而同一条命令在 10s 切片上只要 4.9s —— 不是慢，是死锁）。
            ...vcodec, "-c:a", "aac", "-b:a", "128k", "-t", vidDur.toFixed(3), out);
  await ff(args);

  const outDur = await S.probeDur(out);
  return {
    ok: true, output: out, srt, durationSec: +outDur.toFixed(1), padSec,
    cues: plan.length, narrationCues: nar.cues,
    sped: plan.filter((c) => c.tempo > 1.001).length,
    maxTempo: +Math.max(...plan.map((c) => c.tempo)).toFixed(3),
    firstCue: plan[0].text, lastCueEnd: +(last.end + offset).toFixed(1),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , baseVideo, scriptFile, outFile, titleSec] = process.argv;
  const r = await finalize({
    baseVideo, scriptFile, outFile,
    workDir: join(dirname(resolve(outFile)), "fin-" + basename(outFile, extname(outFile))),
    titleSec: +(titleSec || 0),
  });
  console.log(JSON.stringify(r, null, 2));
}
