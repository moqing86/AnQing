// 安倾 · 开发热更新服务（跑在电脑上，只服务手机上的 App）
//
//   node dev-server.js            # 监听 127.0.0.1:3084
//   adb reverse tcp:3084 tcp:3084 # 把手机的 127.0.0.1:3084 接到电脑
//   手机上：POST http://127.0.0.1:3083/api/dev-sync
//
// 它只做两件事：列出该同步的文件、把文件原文吐出去。
// 真正决定写什么、写去哪、要不要重启引擎的，是手机里的 server.js。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || 'D:\\dsh\\Project\\project2\\anqing\\common\\product\\xiaoan-mobile';
const PORT = Number(process.argv[3] || 3084);

// 同步范围：引擎代码 + 页面 + 心文件 + 她的参考音频（在 files/engine/tts/ 里，可直接热更，不用重打 APK）。
// data/ 与 memory.txt 是她的东西，永不外发。
const DIRS = ['public', 'her'];
const FILES = ['server.js', 'tts/ref.wav', 'tts/ref.txt'];
const SKIP = /(^|[\\/])memory\.txt$|(^|[\\/])\.|\.log$/i;

function walk(dir, rel, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (SKIP.test(r)) continue;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out);
    else out.push(r);
  }
}

function listFiles() {
  const out = [];
  for (const f of FILES) if (fs.existsSync(path.join(ROOT, f))) out.push(f);
  for (const d of DIRS) walk(path.join(ROOT, d), d, out);
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/list') {
    const files = listFiles();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ root: ROOT, files }));
  }
  if (url.pathname === '/file') {
    const p = url.searchParams.get('p') || '';
    if (p.indexOf('..') >= 0 || path.isAbsolute(p)) { res.writeHead(400); return res.end('bad path'); }
    const full = path.join(ROOT, p);
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(full).size });
    return fs.createReadStream(full).pipe(res);
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[dev-server] 母本: ' + ROOT);
  console.log('[dev-server] 监听 http://127.0.0.1:' + PORT + '（共 ' + listFiles().length + ' 个文件）');
  console.log('[dev-server] 手机侧记得: adb reverse tcp:' + PORT + ' tcp:' + PORT);
});
