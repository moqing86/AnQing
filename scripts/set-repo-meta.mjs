/* 设置仓库简介 + topics（2026-10）
 * 凭据从 git credential helper 里取（推送时登录过），不打印 token。
 * 用法：$env:NODE_TLS_REJECT_UNAUTHORIZED="0"; node scripts/set-repo-meta.mjs
 */
import { execSync } from 'node:child_process';

const repo = 'moqing86/AnQing';

function credential() {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) m[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return m;
}

const cred = credential();
if (!cred.password) {
  console.error('拿不到 GitHub 凭据：先在仓库里 git push 一次完成登录');
  process.exit(1);
}
console.log('凭据：' + cred.username + ' / token ' + cred.password.length + ' 字符（不打印）');

const H = {
  Authorization: 'Bearer ' + cred.password,
  'User-Agent': 'anqing',
  Accept: 'application/vnd.github+json',
};

async function api(method, path, body) {
  const r = await fetch('https://api.github.com' + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, H),
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : {};
}

// 1) 简介
try {
  await api('PATCH', '/repos/' + repo, {
    description: 'Offline on-device AI companion for Android — local LLM chat + local TTS/ASR, no cloud, no server.',
    homepage: '',
  });
  console.log('✅ 简介已更新');
} catch (e) { console.log('简介失败：' + e.message); }

// 2) topics
const topics = ['android', 'offline', 'ai-companion', 'sherpa-onnx', 'tts', 'asr', 'privacy', 'nodejs-mobile', 'on-device'];
try {
  const r = await api('PUT', '/repos/' + repo + '/topics', { names: topics });
  console.log('✅ topics: ' + (r.names || []).join(', '));
} catch (e) { console.log('topics 失败：' + e.message); }

// 3) 回读
try {
  const q = await api('GET', '/repos/' + repo);
  console.log('当前简介：' + q.description);
  console.log('当前 topics：' + (q.topics || []).join(', '));
} catch (e) { console.log('回读失败：' + e.message); }
