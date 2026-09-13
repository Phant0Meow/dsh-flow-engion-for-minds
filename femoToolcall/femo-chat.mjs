// femo-chat.mjs — 剧场应急：一键取回当前/最近一场 Femo 剧本的全部发言记录。
// 用法：node femo-chat.mjs [runId前缀]
//   不带参数 = 自动选最近修改的一场（正在运行的那场几乎总是它）。
// 数据源：DSH_HOME/sessions/<工作区>/femo-proj-session-<run>-god/session.jsonl.zstd
// （上帝视角投影日志，多帧 zstd 追加写入，须按帧魔数切帧解压；
//   发言正文在各事件 data.message.content[].text，dsh-femo/chat 是说话人标记行）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // zstd 帧魔数

function frameSplit(buf) {
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i);
  }
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString()); } catch {}
  }
  return parts.join('\n');
}

function findGodFiles() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const root = path.join(home, 'sessions');
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const ws of fs.readdirSync(root)) {
    const wsDir = path.join(root, ws);
    let entries;
    try { entries = fs.readdirSync(wsDir); } catch { continue; }
    for (const name of entries) {
      if (!name.startsWith('femo-proj-session-') || !name.endsWith('-god')) continue;
      const file = path.join(wsDir, name, 'session.jsonl.zstd');
      try {
        found.push({ file, runId: name.slice('femo-proj-session-'.length, -'-god'.length), mtime: fs.statSync(file).mtimeMs });
      } catch {}
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

const prefix = process.argv[2] || '';
const candidates = findGodFiles().filter(x => !prefix || x.runId.startsWith(prefix));
if (candidates.length === 0) {
  console.error('未找到任何 femo-proj-session-*-god 投影记录' + (prefix ? `（runId 前缀 ${prefix}）` : ''));
  process.exit(1);
}
const picked = candidates[0];
console.log(`# 场次 ${picked.runId}`);
console.log(`# 来源 ${picked.file}\n`);
for (const line of frameSplit(fs.readFileSync(picked.file)).split('\n')) {
  let j;
  try { j = JSON.parse(line); } catch { continue; }
  if (j.type === 'dsh-femo/chat') {
    const d = j.data || {};
    if (d.kind === 'speaker') console.log(`\n━━━ ${d.actor} ━━━`);
    else if (d.text) console.log(`[${d.kind || 'chat'}] ${d.text}`);
  } else if (j.type === 'assistant/message') {
    const content = j.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('');
    if (text.trim()) console.log(text.trim() + '\n');
  }
}
