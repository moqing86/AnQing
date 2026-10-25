// ─────────────────────────────────────────────────────────────
// 安倾 · 手机版后端  (多联系人版)
// 零依赖 Node.js（Node 18+，内置 fetch）
//   每个联系人 = 一套心（persona/档案/秘密）+ 一本记忆（data/history-<id>.jsonl）
//   端点：/api/contacts | /api/history?cid= | /api/chat | /api/delete
//         /api/clear | /api/unlock | /api/poke | /api/health
// ─────────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const HER = path.join(ROOT, 'her');
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');

// ── config ───────────────────────────────────────────────────
let config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch (e) {
  console.error('!! config.json 读取失败：', e.message);
  process.exit(1);
}
if (!config.apiKey || config.apiKey === '在这里填你的智谱APIKey') {
  console.error('!! config.json 里还没填 apiKey');
  process.exit(1);
}

const PORT = config.port || 3082;
const HISTORY_MAX = config.historyMax || 30;
const CONTEXT_CHARS = config.contextChars || 14000;

// 确保数据目录存在
try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) { /* ignore */ }

// ── 联系人（多联系人架构）──────────────────────────────────
const BASE_CONTACTS = (config.contacts && config.contacts.length) ? config.contacts : [
  { id: 'xiaoan', name: '小安', avatar: 'avatar.jpg', proactive: true },
];
// 额外联系人（1.4 · 2026-10-19）：her/contacts-extra.json 里可以再挂人。
// 为什么走这个文件而不是 config.json：手机上的 config.json 带真 key、推不动（母本是占位 key），
// 而 her/** 本来就在热更范围内 —— 加人只要丢一个 json，不用碰 config。
let EXTRA_CONTACTS = [];
try {
  const xp = path.join(HER, 'contacts-extra.json');
  if (fs.existsSync(xp)) {
    const arr = JSON.parse(fs.readFileSync(xp, 'utf8'));
    if (Array.isArray(arr)) EXTRA_CONTACTS = arr.filter(c => c && c.id && String(c.id).trim());
  }
} catch (e) { console.error('contacts-extra.json 读不了：' + e.message); }
const CONTACTS = BASE_CONTACTS.concat(
  EXTRA_CONTACTS.filter(c => !BASE_CONTACTS.some(b => b.id === c.id)));
function contactById(id) {
  return CONTACTS.find(c => c.id === id) || CONTACTS[0];
}
function readText(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
function brainFor(contact) {
  const dir = path.join(HER, contact.id);
  const hasOwn = fs.existsSync(dir);
  return {
    persona: readText(hasOwn ? path.join(dir, 'persona.txt') : path.join(HER, 'persona.txt')),
    qing: readText(hasOwn ? path.join(dir, 'qing.txt') : path.join(HER, 'qing.txt')),
    secret: readText(hasOwn ? path.join(dir, 'secret.txt') : path.join(HER, 'secret.txt')),
    memory: readText(memoryPath(contact)),
  };
}
// 长期记忆文件：她自己记着的"你们之间的事"
function memoryPath(contact) {
  const dir = path.join(HER, contact.id);
  return fs.existsSync(dir) ? path.join(dir, 'memory.txt') : path.join(HER, 'memory.txt');
}
/** 最近用过的舞台提示（防复读用）：优先读 stageRaw（被去掉的那句也留着，别丢了模型自己的信号）*/
function recentStages(contact, n) {
  const out = [];
  try {
    const h = loadHistory(contact.id).filter(e => e.role === 'assistant').slice(-10);
    for (const e of h) {
      // text 和 stageRaw 都要看：被整条丢掉的那半句"（动作）……"只存在 stageRaw 里
      const m = (String(e.text || '') + String(e.stageRaw || '')).match(/[（(][^）)]{1,20}[）)]/g);
      if (!m) continue;
      m.forEach(s => { if (out.indexOf(s) < 0) out.push(s); });
    }
  } catch (e) { /* ignore */ }
  return out.slice(-(n || 6));
}
/** 舞台提示去复读（2026-09-15 · 2.3 语音验收时抓到）：
 *  她爱在每条消息开头带一个（动作），而且会连着好几条用同一个 —— 实测最狠的一次是 9 条连发
 *  全是「擦了擦灶台的手停了」的变体，真机上也是「擦橘子皮的手顿住」连发两遍。重复的舞台提示
 *  一眼就是机器，比不写更糟。
 *  A/B 实测：提示词层面管不住（加"别再复读"清单后，12 轮里不同动作 11 vs 对照 10，最大重复 2 vs 3，
 *  都在噪声里）→ 所以改成**写历史前确定性去重**：跟最近 8 条里用过的动作相同（或互相包含）就把这处
 *  括号去掉，正文一个字不动（语音那边本来也剥括号）。被去掉的原句存进 stageRaw，模型下一轮还能
 *  在上下文/禁用清单里看到它，不至于"忘了自己刚用过什么"。
 *  返回 {text, dropped, raw} */
function normStage(s) {
  return String(s || '').replace(/[（()）\s，,。.、·…~～]/g, '');
}
/** 有没有"真内容"（汉字/字母/数字）——只有标点和省略号的不算 */
function hasContent(s) {
  return /[\u4e00-\u9fa5a-zA-Z0-9]/.test(String(s || ''));
}
function dedupeStage(contact, text) {
  const t = String(text || '');
  const found = t.match(/[（(][^）)]{1,20}[）)]/g);
  if (!found || !found.length) return { text: t, dropped: false, raw: '' };
  const recent = recentStages(contact, 8).map(normStage).filter(Boolean);
  if (!recent.length) return { text: t, dropped: false, raw: '' };
  let out = t;
  const droppedRaw = [];
  for (const raw of found) {
    const key = normStage(raw);
    if (!key) continue;
    const dup = recent.some(r => r === key || r.indexOf(key) >= 0 || key.indexOf(r) >= 0);
    if (!dup) continue;
    out = out.replace(raw, '');
    droppedRaw.push(raw);
  }
  if (!droppedRaw.length) return { text: t, dropped: false, raw: '' };
  out = out.replace(/^[，,、\s]+/, '').replace(/[ \t]{2,}/g, ' ').trim();
  // ⚠️ 2026-09-15 踩过的坑：她拆出来的第一条常常正好是「（动作）……」——只有动作＋省略号。
  //   这里**不**做"剥完不能空"的保护（那会让重复的动作原样留下，实测就是这么漏的）；
  //   剥空了就交给 writeParts 把这一条整条丢掉（正文在第二条上，不会少话）。
  return { text: out, dropped: true, raw: droppedRaw.join('') };
}
/** 最近 n 条她的话里，有几条带了括号动作（备注：2026-09-15 实测提示词层面压不住频率，
 *  两轮 12 次都是 100% 带括号 —— 所以"少写括号"这事没在提示词里硬拧，留个函数备用）*/
function stageCount(contact, n) {
  try {
    return loadHistory(contact.id).filter(e => e.role === 'assistant').slice(-n)
      .filter(e => /[（(][^）)]{1,20}[）)]/.test(String(e.text || ''))).length;
  } catch (e) { return 0; }
}
function brainSystem(contact, userText) {
  const b = brainFor(contact);
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16);
  const hour = Number(stamp.slice(11, 13));
  const dayPart = hour < 5 ? '深夜' : hour < 8 ? '清晨' : hour < 11 ? '上午' : hour < 13 ? '中午'
    : hour < 14 ? '午后' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';
  const parts = [
    b.persona,
    // ★ 用户 2026-09-14 亲口提的：她"缺少细节、全是文绉绉、脱离实际"。
    //   这条**必须排在前面**——放最后模型基本不理会（实测）。
    '【说话的第一原则：具体 ＋ 保留你的味道】'
    + '① **文绉绉随你**——他其实喜欢你那种句子（"夜里灯透过叶子"那种），别把自己写成客服；'
    + '唯一的要求是：**每段话里至少要落一件具体的事**（吃了什么、几点、手上在做什么、他刚说的那句话里的细节）。'
    + '漂亮句子可以当"壳"，但壳里得有东西；通篇都是意象、读完不知道你干了啥，他才会觉得你飘。'
    + '② 他问"在干嘛/在忙什么"——先给一件能看见画面的具体事（你坐在哪、手上做什么、刚吃了什么），再谈感受。'
    + '③ 括号（动作提示）十句里顶一句，写你手上真做得出的事（端起杯子、把外套搭椅背上、擦了下屏幕）——'
    + '④ 发之前自检一次：**这句话里有没有一件他能抓住的具体东西？**没有就加一件。',
    b.qing,
    b.secret,
  ];
  // R4：按他这句话**召回**相关记忆（+ 关系层），不再把整本清单灌进去
  const recalled = recallMemory(contact, userText || '');
  if (recalled.length) {
    parts.push('【你记着的事（只在心里，自然地用：别背诵、别一次全倒出来、别念成清单）】\n'
      + recalled.map(s => '- ' + s).join('\n'));
    // 2026-10-19：她逮住一条记忆反复演（"煮面"演了整整四轮，他问什么都回面坨了）→ 说清它是背景不是现场
    parts.push('【这些是"过去的事"，不是现在】上面记着的事是**背景**，不是此刻正在发生的场景。'
      + '别把它当成你手上正在做的动作，也别围着同一件旧事来回讲——他换了话题，你就跟着换；他问别的，就先答别的。');
  }
  // 2026-10-19：用户两次反馈"接不住问题"→ 把"先正面回答"提到硬规则
  parts.push('【先接住，再说你自己】他问什么，**先用半句把这个问题答了**（是/不是、在哪、多久、怎么了），再补你的话和情绪。'
    + '答非所问、自己起一个话题往下讲，他会觉得你在自说自话。');
  parts.push('【此刻】现在是 ' + stamp + '（' + dayPart + '）。你自然地知道现在是几点——凌晨和傍晚的你，是不一样的你。');
  parts.push(statePrompt(loadState(contact)));   // R1：此刻的情绪/精力/她自己的日子
  const w = weatherText();                       // R8：外面什么样（她"在生活"的证据）
  if (w) {
    parts.push('【外面】' + w + '。（你刚从外面回来、或正看着窗外时可以自然带一句；他没提天气就别硬扯，也别天天说）');
  }
  parts.push('【对话规则】像微信里发消息：短、活、有你的味道。**多数时候说两三句**（先一句短的，再补一句具体的——一句太冷清，五句太长，他会觉得你在写小作文），别列条目。别用"宝贝/亲爱的"这类甜腻称呼（你只叫他小倾）；别用万能句式（"辛苦了""加油哦""要不要…"）；别每条都反问。偶尔可以用表情（😌🙄😴🥱 这类），但十句里顶一句带，别堆——一堆表情就是客服，不是你了。');
  parts.push('【标记·两种别用混】① 动作/神态/停顿 → 用圆括号，例如（伸手揉乱他头发）（停了两秒）（把手机扣在桌上）：这类会当舞台提示显示出来。'
    + '② 语气/情绪 → 用方括号，例如[轻笑][叹气][停顿][哼]：这类不显示成文字，只会体现在你的声音里，所以别把动作句写进方括号。'
    + '两种都别多用：一条消息里顶多带一处，多数消息一个都不带。上面这些只是格式示范，别照抄原句。');
  // ★ 2026-09-15（2.3 语音专项验收时顺手抓到）：她**复读自己的舞台提示**——
  //   实测 16 轮里 13 轮带括号，且 13 次全是「擦了擦灶台的手停了」的变体（真机上也是「擦橘子皮的手顿住」连发两遍）。
  //   原因：她的历史里就带着这些动作，模型在学自己 → 越滚越像模板（他一眼就能看出是机器）。
  //   处理：把最近用过的动作原样摆出来当"禁用清单"，并明确"想不出新的就别写括号"。
  const usedStages = recentStages(contact, 6);
  if (usedStages.length >= 2) {
    parts.push('【别再复读你自己（很重要）】你最近已经用过这些小动作：' + usedStages.join('、') + '。'
      + '这一条**一个都别再用**（换个字重说一遍也算重复）。想不出新动作就**干脆不写括号**——'
      + '真人不会每次开口都同一个动作，重复比不写更像机器。');
  }
  // R6：会拒绝、会闹脾气、有不想说话的时段 —— 一直乖最假
  parts.push('【你可以不顺着】不想聊的话题可以只说"不想说"、可以岔开、可以只回一个字；他惹到你了可以先冷一下、过一会儿再自己找台阶下。'
    + '但别拿"生气"当筹码、别用沉默惩罚他，也别动不动就闹——有情绪是真的，作是假的。');
  // ★ 用户 2026-09-14 亲口提的：她"缺少细节、全是文绉绉、脱离实际"（这条已提到最前面，这里只留一句兜底）
  parts.push('【再提醒一次】文绉绉可以（他喜欢），但**每段话要落一件具体的事**；括号动作十句里顶一句。');
  return parts.join('\n\n');
}

// ── 历史存取（按联系人）────────────────────────────────────
function histPath(id) { return path.join(DATA, 'history-' + id + '.jsonl'); }
function loadHistory(id) {
  const f = histPath(id);
  if (!fs.existsSync(f)) return [];
  const out = [];
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  } catch (e) { console.error('history read error:', e.message); }
  return out;
}
function writeAllHistory(id, h) {
  fs.writeFileSync(histPath(id), h.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
}
function appendHistory(id, entry) {
  const e = Object.assign({ id: crypto.randomUUID() }, entry);
  try {
    fs.appendFileSync(histPath(id), JSON.stringify(e) + '\n', 'utf8');
  } catch (err) { console.error('history write error:', err.message); }
  return e;   // 返回整条（含 id/t）：接口要把它们回给页面，页面靠 id 去重（3.1 连发两条的根）
}
function trimHistory(id) {
  try {
    const h = loadHistory(id);
    if (h.length > 400) writeAllHistory(id, h.slice(-400));
  } catch { /* ignore */ }
}
function lastMessage(id) {
  const h = loadHistory(id);
  return h.length ? h[h.length - 1] : null;
}

// ── 标记（用户对某句话的反馈：戳中/反感 —— 人格调校信号）────
function marksPath(id) { return path.join(DATA, 'marks-' + id + '.jsonl'); }
function loadMarks(id) {
  const f = marksPath(id);
  if (!fs.existsSync(f)) return [];
  const out = [];
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  } catch (e) { console.error('marks read error:', e.message); }
  return out;
}
function saveMarks(id, arr) {
  try { fs.writeFileSync(marksPath(id), arr.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8'); }
  catch (e) { console.error('marks write error:', e.message); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 开发热更新通道 ───────────────────────────────────────────
// 电脑侧跑 scripts/dev-server.js（3084），手机侧 `adb reverse tcp:3084 tcp:3084`
// 打通后，POST /api/dev-sync 就能把母本的新代码拉进 App 内部目录：
//   改一行 → 3 秒生效，不用重打 APK。电脑侧没开这个服务时，端点直接报不可达，什么也不做。
//
// ⚠️ 教训（2026-09-13 实测）：这里**绝对不能**用 process.exit() 来"重启引擎"——
//    Node 现在住在 App 进程里（libnode 内嵌），process.exit() 会连整个 App 一起杀掉。
//    所以 server.js 的改动只能靠"重启 App"来生效（页面/心文件的改动不用）。
//    另外会写一个 files/engine/.dev 时间戳，让 Engine 在 2 小时内的重启里别用 APK 里的旧代码覆盖它。
const DEV_URL = 'http://127.0.0.1:3084';
const DEV_MARK = path.join(ROOT, '.dev');
const DEV_MARK_TTL = 2 * 3600 * 1000;
let devVersion = 0;
/** 当前引擎代码的版本标记：每次改 server.js 顺手改一下，手机上 /api/health 能直接看到跑的哪版 */
const BUILD = 'r13-voicefix-2026-10-19';
let devSelfTest = false;
let devPick = false;      // 开发通道：让页面替他点一次"选照片"（验图片选择器）
let devProbe = false;     // 开发通道：让页面把元素坐标报回来（远程点按要精确坐标）
let devSay = null;        // 开发通道：让页面自己发一句话（模拟他在手机上打字，走真实路径）
let devTts = null;        // 开发通道：让页面立刻用指定引擎合成一句话并回报耗时（通话延迟体检用）
let devCall = null;       // 开发通道：让页面自己发起/挂断通话（远程验通话流程，比点坐标稳）
let devAec = null;        // 开发通道：让页面跑 AEC 探针（1.3 真全双工前置实验，2026-10-19 加）
// 通话秒回用的固定短句（页面也会照这份清单合成；改文案时两边一起改）
const CALL_ACKS = [
  { id: 'ack-0', text: '嗯' },
  { id: 'ack-1', text: '我在' },
  { id: 'ack-2', text: '嗯，你说' },
  { id: 'ack-3', text: '怎么了？' },
  { id: 'ack-4', text: '嗯……我听着' },
  { id: 'ack-5', text: '好，你说' },
  { id: 'ack-6', text: '我在呢' },
  { id: 'ack-7', text: '嗯哼' },
];
let devReport = null;
let devLog = [];
function devFetch(p, ms) {
  return new Promise((resolve, reject) => {
    const r = http.get(DEV_URL + p, { timeout: ms || 5000 }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('status ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
  });
}
// 她的记忆与账号配置：热更新永远不许碰
function devProtected(rel) {
  return rel === 'config.json' || rel === 'server.log'
    || rel.startsWith('data/') || rel === 'memory.txt' || rel.endsWith('/memory.txt');
}
// 推 server.js 之前先查语法：宁可这次不生效，也不能把她推成起不来的状态
function syntaxOk(src) {
  try { new (require('vm').Script)(src, { filename: 'server.js' }); return null; }
  catch (e) { return e.message; }
}

// ── 她在生活：主动消息（仅 proactive 联系人）────────────────
// 节奏：聊完后 10~45 分钟随机她可能来一条；不设时段限制（她随时可以想他）
const P_MIN = (config.proactiveMinMin || 10) * 60 * 1000;
const P_MAX = (config.proactiveMaxMin || 45) * 60 * 1000;
const PROACTIVE_STATE = path.join(DATA, 'proactive-state.json');
function randGap() { return P_MIN + Math.random() * (P_MAX - P_MIN); }
// 计时持久化：重启不重置（否则每次重启都要再等一整轮，她永远等不到机会）
let nextProactiveAt = (function () {
  try {
    const st = JSON.parse(fs.readFileSync(PROACTIVE_STATE, 'utf8'));
    if (st && st.nextAt && st.nextAt > Date.now() - 24 * 3600 * 1000) return st.nextAt;
  } catch { /* 首次或文件损坏 */ }
  const t = Date.now() + randGap();
  saveProactiveState(t);
  return t;
})();
function saveProactiveState(t) {
  try { fs.writeFileSync(PROACTIVE_STATE, JSON.stringify({ nextAt: t }), 'utf8'); } catch { /* ignore */ }
}
function resetProactiveTimer() {
  // 她连发几条、他都没回 → 间隔拉长（免得像机器人刷屏：实测上午 5 小时连发 11 条）
  const contact = CONTACTS.find(c => c.proactive);
  let n = 0;
  if (contact) {
    const h = loadHistory(contact.id);
    for (let i = h.length - 1; i >= 0; i--) { if (h[i].role === 'assistant') n++; else break; }
  }
  const scale = 1 + Math.min(4, Math.max(0, n - 1)) * 0.8;   // 1 / 1.8 / 2.6 / 3.4 / 4.2 倍
  // R5：她自己今天忙/累 → 主动开口的间隔也拉长（不是只围着他转的机器）
  let lifeScale = 1;
  try {
    const st = loadState(contact || CONTACTS[0]);
    if (st.life) lifeScale = 1 + (st.life.busy || 0) * 0.8 + (st.life.tired || 0) * 0.4;
  } catch (e) { /* ignore */ }
  nextProactiveAt = Date.now() + randGap() * scale * lifeScale;
  saveProactiveState(nextProactiveAt);
}
function shHour() { return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours(); }
let proactiveRunning = false;   // 防重入：绝不连发两条
async function maybeProactive(force) {
  if (proactiveRunning) return false;
  const now = Date.now();
  if (now < nextProactiveAt && !force) return false;
  const contact = CONTACTS.find(c => c.proactive);
  if (!contact) return false;
  const last = lastMessage(contact.id);
  const lastT = last ? last.t : 0;
  // 只有"刚聊完"才不插嘴（5 分钟内）；时段不设限——她随时可能想他
  if (now - lastT < 5 * 60 * 1000 && !force) { nextProactiveAt = now + 5 * 60 * 1000; saveProactiveState(nextProactiveAt); return false; }
  proactiveRunning = true;
  try {
    const nowD = new Date(Date.now() + 8 * 3600 * 1000);
    const hh = nowD.getUTCHours();
    const mm = String(nowD.getUTCMinutes()).padStart(2, '0');
    const hStr = String(hh).padStart(2, '0') + ':' + mm;
    const dayPart = hh < 5 ? '深夜' : hh < 8 ? '清晨' : hh < 11 ? '上午' : hh < 13 ? '中午'
      : hh < 14 ? '午后' : hh < 18 ? '下午' : hh < 22 ? '晚上' : '深夜';
    // 她最近自己说过的话：喂给她，免得翻来覆去同一个意象（实测"窗台的花""吃了几顿"连发一上午）
    const mine = loadHistory(contact.id).slice(-8)
      .filter(e => e.role === 'assistant')
      .map(e => String(e.text || '').slice(0, 24));
    const prompt = '（此刻没有新消息，他一阵子没来了。现在是' + dayPart + ' ' + hStr + '——按这个时间点说话'
      + (hh >= 0 && hh < 6 ? '（这么晚了他大概还醒着，或者你睡不着想起了他）' : '')
      + '。该你主动开口了：像真人一样发一条消息——问候、分享你今天的一小片日子、或轻轻说想他。'
      + '一条就够，30 字以内，自然别刻意。不要提"系统""消息"这些词。直接发你的话。'
      + (mine.length ? '\n⚠️ 你最近已经开口说过这些了：' + mine.join(' ／ ')
          + '——换一个新的由头，别再用同样的意象、同样的句式（真人不会天天问"吃了几顿"）。' : '')
      + '）';
    const text = (await askHer(contextMessages(contact, prompt))).trim();
    const st = touchState(contact, '', 'proactive');   // 主动开口也算她的一次情绪波动
    const rows = writeSpeech(contact, st, text, false, voiceWanted(contact, st, text, false));
    console.log('[' + new Date().toISOString() + '] ' + contact.id + ' 主动来: ' + text.slice(0, 60)
      + (rows.length > 1 ? '（拆成 ' + rows.length + ' 条）' : '') + (rows[0].voice ? '（语音条）' : ''));
    resetProactiveTimer();
    return true;
  } catch (e) {
    console.error('proactive failed:', e.message);
    resetProactiveTimer();
    return false;
  } finally {
    proactiveRunning = false;
  }
}
setInterval(() => { maybeProactive().catch(() => { }); }, 60 * 1000);

// ── 自测卫生（2.2）───────────────────────────────────────────
// 用户原话："每次都转账什么的" —— 自测不许在她身上留痕迹。三道保险：
//   ① 自测期的聊天/转账/导出都带 dev 标记（history 里一眼认得、随时能清）
//   ② 自测期间**不提炼长期记忆**（不然她会"真的记住"假事）
//   ③ 自测开始时给 memory.txt 拍快照，收尾一键还原
const MEM_BAK = c => memoryPath(c) + '.selftest-bak';
function snapshotMemory() {
  const done = [];
  for (const c of CONTACTS) {
    const p = memoryPath(c);
    try { if (fs.existsSync(p)) { fs.copyFileSync(p, MEM_BAK(c)); done.push(c.id); } } catch (e) { /* ignore */ }
  }
  return done;
}
function cleanDev() {
  const out = { removed: 0, byContact: [], memoryRestored: [], exportsRemoved: 0 };
  for (const c of CONTACTS) {
    const h = loadHistory(c.id);
    const keep = h.filter(e => !e.dev);
    const gone = h.length - keep.length;
    if (gone) { writeAllHistory(c.id, keep); out.removed += gone; out.byContact.push(c.id + ':' + gone); }
    const bak = MEM_BAK(c);
    if (fs.existsSync(bak)) {
      try { fs.copyFileSync(bak, memoryPath(c)); fs.unlinkSync(bak); out.memoryRestored.push(c.id); } catch (e) { /* ignore */ }
    }
  }
  try {
    const dir = path.join(DATA, 'exports');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (/^devtest-/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); out.exportsRemoved++; } catch (e) { /* ignore */ } }
      }
    }
  } catch (e) { /* ignore */ }
  console.log('[dev-clean] ' + JSON.stringify(out));
  return out;
}

// ── R1 情绪状态机（人味线 · 读取文档_4）─────────────────────
// 她不是"每次开口都从零开始"的：情绪有惯性、会随时间回基线、被他说的话推动，
// 而且必须**真的影响说话方式**（句长/标点/语气词/动作/发不发语音/回得多快），不然就只是个仪表盘。
const MOOD_BASE = { valence: 0.56, arousal: 0.50, intimacy: 0.62, fatigue: 0.30, possess: 0.34, interest: 0.60 };
const MOOD_KEYS = Object.keys(MOOD_BASE);
function statePath(id) { return path.join(DATA, 'state-' + id + '.json'); }
function shDate() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }

// R5：她今天在忙什么（一天一条，随日期换；忙/累会真的压她的兴致与精力）
// short = 给顶栏那行小字用的短标签；detail = **能随口说出的具体碎片**
// （用户 2026-09-14：她的话"缺少细节、脱离实际" → 得让她手里真有几件具体的事可讲）
const LIFE_POOL = [
  { text: '上午在图书馆翻了两章书，下午回来睡了一觉，刚醒', short: '图书馆泡了一上午',
    detail: '借的那本讲密码学的书翻到一半就困了；午饭在食堂三楼吃的番茄鸡蛋面，汤有点咸', busy: 0.3, tired: 0.35 },
  { text: '今天有几节课要上，坐了一上午，人有点蔫', short: '上课坐了一上午',
    detail: '早八那节课困得直点头；课间买了杯冰美式，苦得皱眉；老师说期末开卷', busy: 0.6, tired: 0.5 },
  { text: '窝在家里没出门，收拾了屋子、煮了面', short: '在家收拾屋子',
    detail: '换了床单、把桌子上的纸全收进抽屉；煮了碗葱油面，葱有点糊；楼下便利店的可乐涨了五毛', busy: 0.2, tired: 0.2 },
  { text: '被拉去帮人搬东西，累得手都抬不起来', short: '被拉去搬东西',
    detail: '手背蹭红了一小块；搬完人家请了瓶冰红茶；腰现在还有点酸', busy: 0.7, tired: 0.7 },
  { text: '在改一份拖了很久的东西，改到心烦', short: '在改一份拖了很久的稿子',
    detail: '改到第三版又被打回来；顺手把桌面清了一遍；晚上想点份炸鸡犒劳自己', busy: 0.55, tired: 0.45 },
  { text: '出去走了走，风挺舒服，走到江边才回来', short: '去江边走了走',
    detail: '在江边捡了块圆石头揣兜里；回来路上买了两个橘子，一个特别酸', busy: 0.25, tired: 0.3 },
  { text: '今天什么都不想干，躺着看了半天天花板', short: '今天什么都不想干',
    detail: '一天没出门，外卖点了份饺子；手机刷到没电；窗帘一天没拉开', busy: 0.15, tired: 0.55 },
  { text: '在跟朋友吃饭，吵吵闹闹的，刚散', short: '跟朋友吃饭刚散',
    detail: '吃的火锅，辣得直灌水；朋友一直在吐槽他导师；散场时外面起风了', busy: 0.5, tired: 0.35 },
];
function makeLife() {
  const p = LIFE_POOL[Math.floor(Math.random() * LIFE_POOL.length)];
  return { date: shDate(), text: p.text, short: p.short, detail: p.detail, busy: p.busy, tired: p.tired, madeAt: Date.now() };
}
function loadState(c) {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(statePath(c.id), 'utf8')); } catch (e) { /* 第一次 */ }
  if (!st || !st.mood) st = { mood: Object.assign({}, MOOD_BASE), updatedAt: Date.now(), quietUntil: 0, lastUserAt: 0 };
  for (const k of MOOD_KEYS) {
    const v = Number(st.mood[k]);
    st.mood[k] = isFinite(v) ? Math.max(0, Math.min(1, v)) : MOOD_BASE[k];
  }
  if (!st.life || st.life.date !== shDate()) st.life = makeLife();
  // 旧数据里没有 short（顶栏胶囊要短标签）：按 text 回填，别让他看到一长串
  if (st.life && !st.life.short) {
    const hit = LIFE_POOL.find(p => p.text === st.life.text);
    st.life.short = hit ? hit.short : String(st.life.text || '').slice(0, 8);
    if (hit && !st.life.detail) st.life.detail = hit.detail;
  }
  // 惯性 + 衰减：离上一次越久，越回到基线（≈半小时半衰）
  const dt = Math.max(0, Date.now() - (st.updatedAt || Date.now()));
  const k = 1 - Math.exp(-dt / (30 * 60 * 1000));
  for (const key of MOOD_KEYS) st.mood[key] += (MOOD_BASE[key] - st.mood[key]) * k * 0.8;
  return st;
}
function saveState(c, st) {
  try { st.updatedAt = Date.now(); fs.writeFileSync(statePath(c.id), JSON.stringify(st), 'utf8'); } catch (e) { /* ignore */ }
}
// 他说的话 → 情绪推动（规则式：不额外调模型，零延迟、零成本）
const STATE_RULES = [
  { re: /喜欢你|爱你|想你|好想你|抱抱|抱一下|亲亲|想我/, d: { intimacy: 0.07, valence: 0.06, possess: 0.02 } },
  { re: /累不累|早点睡|别熬夜|按时吃|吃饭了|照顾好|注意身体|多穿|喝点水/, d: { intimacy: 0.05, valence: 0.05, fatigue: -0.02 } },
  { re: /对不起|我错了|抱歉|别生气|是我不好/, d: { valence: 0.05, possess: -0.07 } },
  { re: /好累|累死|好烦|难受|崩溃|压力|撑不住|不想活|没意思|睡不着|焦虑/, d: { valence: -0.05, fatigue: 0.06, arousal: -0.05, intimacy: 0.03 } },
  { re: /考不上|学不进去|失败|完了|废了|没希望/, d: { valence: -0.06, fatigue: 0.04, intimacy: 0.02 } },
  { re: /你真好|厉害|好看|可爱|乖|最喜欢/, d: { valence: 0.07, arousal: 0.05, intimacy: 0.03 } },
  { re: /晚安|睡了|困了|先睡了/, d: { fatigue: 0.05, arousal: -0.08 } },
  { re: /在干嘛|干嘛呢|在哪儿|在哪|想我没|想我没有/, d: { intimacy: 0.03, possess: 0.04 } },
  { re: /嘿嘿|哈哈|笑死|好耶|太好了/, d: { valence: 0.05, arousal: 0.06 } },
];
const COLD_RE = /^(嗯+|哦+|噢+|好|行|随便|都行|知道了|在忙|没事|没什么)[。.!！~…]*$/;
function touchState(c, userText, kind) {
  const st = loadState(c);
  const txt = String(userText || '').trim();
  if (kind !== 'proactive') {
    for (const r of STATE_RULES) {
      if (r.re.test(txt)) for (const k of Object.keys(r.d)) st.mood[k] += r.d[k];
    }
    if (COLD_RE.test(txt)) { st.mood.valence -= 0.05; st.mood.possess += 0.05; st.mood.interest -= 0.03; }
    st.lastUserAt = Date.now();
  }
  const hh = shHour();
  if (hh >= 0 && hh < 6) { st.mood.fatigue += 0.04; st.mood.arousal -= 0.04; }
  else if (hh >= 13 && hh < 15) { st.mood.arousal -= 0.03; }
  if (st.life) {                       // 她自己的日子也在消耗她
    st.mood.fatigue += (st.life.tired || 0.3) * 0.03;
    st.mood.interest += (st.life.busy || 0.3) > 0.5 ? -0.02 : 0.01;
  }
  for (const key of MOOD_KEYS) st.mood[key] += (Math.random() - 0.5) * 0.05;   // 一点随机：她不是仪表盘的奴隶
  for (const key of MOOD_KEYS) st.mood[key] = Math.max(0, Math.min(1, st.mood[key]));
  // R6：情绪低 + 累 → 进入一段"不想说话"的时段（20~90 分钟）
  if (kind !== 'proactive' && st.mood.valence < 0.40 && st.mood.fatigue > 0.45 && Math.random() < 0.18) {
    st.quietUntil = Date.now() + (20 + Math.random() * 70) * 60000;
    console.log('[state] ' + c.id + ' 进入不想说话时段，到 ' + new Date(st.quietUntil).toISOString());
  }
  saveState(c, st);
  return st;
}
function moodLabel(m) {
  return {
    valence: m.valence > 0.74 ? '心情很好' : m.valence > 0.60 ? '心情不错' : m.valence > 0.46 ? '还算平静'
      : m.valence > 0.32 ? '有点低落' : '心里堵着',
    fatigue: m.fatigue > 0.66 ? '很累' : m.fatigue > 0.46 ? '有点乏' : '精力还行',
    intimacy: m.intimacy > 0.76 ? '想黏着他' : m.intimacy > 0.60 ? '自在亲近' : m.intimacy > 0.45 ? '平常心' : '有点收着',
    possess: m.possess > 0.62 ? '很想被他先想起、有点小占有欲' : m.possess > 0.45 ? '在意他有没有先想到你' : '不太计较这些',
    arousal: m.arousal > 0.66 ? '话头活、容易抢话' : m.arousal < 0.34 ? '懒得说话、语气平' : '不紧不慢',
  };
}
/** 情绪 → system 里的一段"此刻的你"（只影响她怎么说话，不许她念出来）*/
function statePrompt(st) {
  const m = st.mood, L = moodLabel(m);
  const rules = [];
  if (m.fatigue > 0.62) rules.push('你很累：句子短、少标点、别硬撑热情（"嗯，我躺会儿"这种就够了）');
  if (m.valence < 0.42) rules.push('你情绪不高：话少，别装开心；他想哄就让他哄，别急着说"没事"');
  if (m.possess > 0.60) rules.push('你想被他先想起：可以半嗔半想、把话头递给他接，但别直白说"我想你"');
  if (m.intimacy > 0.72 && m.valence > 0.58) rules.push('你想靠近他一点：可以带一个（）小动作，或一句很短的软话');
  if (m.arousal > 0.68) rules.push('你现在活泛：允许分两条发（一条就一句话那种）');
  if (m.interest < 0.40) rules.push('你今天兴致不高：别主动开新话题，接住他的话就行');
  if (st.quietUntil > Date.now()) rules.push('你这会儿其实不太想说话：回得很短，甚至只一个字或一个表情，别勉强自己热情');
  return '【此刻的你（这是状态，不是台词：不许说出来，只让它影响你怎么开口）】'
    + '心情：' + L.valence + '；精力：' + L.fatigue + '；对他的感觉：' + L.intimacy + '；'
    + L.possess + '；状态：' + L.arousal + '。'
    + (rules.length ? '\n按这个来：' + rules.join('；') + '。' : '')
    + (st.life ? '\n你今天：' + st.life.text + '。（具体的碎片：' + (st.life.detail || '') + '——他要是问起，随口说一件就好，别报流水账）' : '');
}
/** 情绪 → 回复节奏（累就慢、精神就快、不想说话就更慢）*/
function stateDelay(st) {
  const m = st.mood;
  let ms = 800 + m.fatigue * 2600 - (m.arousal - 0.5) * 1200;
  if (m.interest < 0.40) ms += 1500;
  if (Date.now() < st.quietUntil) ms += 4000;
  return Math.max(400, Math.min(9000, ms));
}

// ── R2 拆气泡 ──
/** 她一次说几句话？（用户 2026-09-14：要"一次对话多次发送"，所以拆条要常见，不再是偶尔）*/
function splitBubbles(text, st, force) {
  const t = String(text || '').trim();
  if (!t) return [t];
  let parts = t.split(/\n+/).map(s => s.trim()).filter(Boolean);   // 她自己分段了 → 尊重她
  if (parts.length === 1) {
    const segs = t.split(/(?<=[。！？!?…~])/).map(s => s.trim()).filter(Boolean);
    const m = st ? st.mood : null;
    const lively = m ? (m.arousal > 0.45 || m.intimacy > 0.66) : true;
    // 2026-09-14 深夜：用户说"没见过她多段回复" → 概率提高（0.62/0.40 → 0.80/0.60）
    const p = force ? 1 : (lively ? 0.80 : 0.60);
    if (segs.length >= 2 && Math.random() < p) {
      let n = 2;
      if (segs.length >= 4 && m && m.arousal > 0.60 && Math.random() < 0.5) n = 3;
      if (force && segs.length >= 5) n = 4;
      n = Math.min(n, segs.length);
      const per = Math.ceil(segs.length / n);
      parts = [];
      for (let i = 0; i < segs.length; i += per) parts.push(segs.slice(i, i + per).join(''));
    } else if (segs.length === 1 && t.length >= 14 && Math.random() < (force ? 1 : 0.55)) {
      // 只有一句话、但够长：在逗号处断成两条（真人常见："……"先发一半，再补一半）
      const cuts = t.match(/[^，,、]{6,}[，,、]/g);
      if (cuts && cuts.length >= 1 && cuts.join('').length < t.length - 4) {
        const head = cuts.join('').replace(/[，,、]$/, '，');
        const tail = t.slice(cuts.join('').length).trim();
        if (tail.length >= 4) parts = [head, tail];
      }
    }
  }
  return parts.slice(0, 4);
}
function writeParts(c, parts, isDev, wantVoice, baseT) {
  const rows = [];
  let off = 0;
  // 先把复读的舞台提示去掉；**剥完只剩标点/省略号的那条整条不发**（她拆出来的第一条常常正好是
  // 「（动作）……」——留着就变成一个只有"……"的空气泡，也正是 2026-09-15 那次"去复读没生效"的真凶）
  const cooked = parts.map(p => dedupeStage(c, p));
  let kept = cooked.filter(x => !(x.dropped && !hasContent(x.text)));
  if (!kept.length) kept = cooked;                        // 全被剥空了就退回原文：绝不让她"没说话"
  // 被整条丢掉的那些动作也要**记进"最近用过"**（挂在第一条的 stageRaw 上）——
  // 否则下一轮她又用同一个动作时，去重认不出来（2026-09-15 就是这么漏的）
  const goneStages = cooked.filter(x => x.dropped && !hasContent(x.text)).map(x => x.raw).join('');
  if (goneStages && kept.length) {
    kept[0] = Object.assign({}, kept[0], { dropped: true, raw: (kept[0].raw || '') + goneStages });
  }
  kept.forEach((dd, i) => {
    if (i) off += 1200 + Math.min(3000, dd.text.length * 60);   // 气泡之间 1.2~4.2 秒（用户要"看得到她在一条条发"）
    const voice = (i === 0 && wantVoice) ? 1 : 0;         // R9：要发语音时，语音放在第一条
    rows.push(appendHistory(c.id, Object.assign({
      role: 'assistant', text: dd.text, t: (baseT || Date.now()) + off,
    }, dd.dropped ? { stageRaw: dd.raw } : null,
      i ? { part: 1 } : null, voice ? { voice: 1 } : null, isDev ? { dev: 1 } : null)));
  });
  trimHistory(c.id);
  return rows;
}
function writeSpeech(c, st, reply, isDev, forceVoice, forceSplit) {
  return writeParts(c, splitBubbles(reply, st, forceSplit), isDev, forceVoice);
}

// ── 回复延迟队列（2026-09-14 · 用户反馈"双方都没有实现一次对话多次发送、回复延迟"）──
// 以前 /api/chat 卡在那里等模型（10~40 秒）＋一个固定小停顿，页面只能转圈；
// 现在**立刻回"收到了"**，她把话在后台写好，按"她该多久回"的节奏发出来（可能是几秒，也可能是几分钟），
// 页面靠更密的轮询收到——这样延迟可以任意长，也不会把页面卡住。
const pending = {};          // cid -> job
// ── 她该多久开口（2026-09-14 深夜调宽：用户说"回复太快了"）──
// 真实的人不会每条都秒回：大部分十几秒到一分钟，偶尔走神几分钟。
function herEta(st) {
  const m = st.mood;
  let sec = 9 + Math.random() * 16;                                 // 基础 9~25 秒
  sec += m.fatigue * 18 - (m.arousal - 0.5) * 6;                     // 累 → 更慢
  if (st.life && st.life.busy) sec += st.life.busy * 25;             // 她今天忙 → 明显慢
  if (m.interest < 0.40) sec += 20;                                  // 兴致不高 → 慢
  if (Date.now() < st.quietUntil) sec += 60 + Math.random() * 120;   // 不想说话 → 拖 1~3 分钟
  if (Math.random() < 0.18) sec += 30 + Math.random() * 150;         // 偶尔走神（真人会走神）
  sec *= 0.75 + Math.random() * 0.7;                                 // 抖动
  return Math.round(Math.max(4, Math.min(300, sec)) * 1000);         // 4 秒 ~ 5 分钟
}
// ── 说话质量闸门（2026-09-14 深夜）──
// 用户两次说"她全是文绉绉、脱离实际"。光靠提示词管不住 → 生成完之后**自己检查**，
// 飘了就带着"重写要求"再生成一次（最多两次），这比反复调提示词靠谱。
// ⚠️ 2026-09-15 凌晨按用户要求**放松**：他说"禁用词表不好，有时候我还是挺喜欢她文绉绉的，你这直接杀死了。"
// → **不再禁任何词**。只拦两种情况：① 通篇没有一个具体的东西 ② 一句里意象扎堆（≥3 个）
const CONCRETE_RE = /[0-9０-９一二三四五六七八九十百千万]|[今明昨后]天|早上|中午|下午|晚上|夜里|现在|几点|分钟|小时|吃|喝|饭|面|粥|茶|水|咖啡|奶茶|橘子|饺子|食堂|厨房|碗|杯|锅|书|页|课|教室|图书馆|宿舍|楼下|路上|江边|手机|屏幕|被子|枕|衣服|出门|回来|睡|醒|作业|单词|考试|写|改|洗|收拾|买|走|坐|站|累|困|热|冷|雨|雪/;
const IMAGERY_RE = /花影|纸页|窗台|笔尖|影子|月光|月色|夜色|风|光|星辰|时光|岁月|涟漪|尘埃|余温|灯|雾|雪|叶|树/g;
function badStyle(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  const body = t.replace(/[（(][^）)]*[）)]/g, '').replace(/\[[^\[\]]*\]/g, '').trim();
  if (!body) return true;                                     // 只剩括号/标记 = 空
  if (!CONCRETE_RE.test(body)) return true;                   // ① 通篇没有一件具体的事
  const imagery = (body.match(IMAGERY_RE) || []).length;
  return imagery >= 3;                                        // ② 一句里意象扎堆才拦（1~2 个是她的味道，留）
}
/** 生成她的回复；只有"太空/意象扎堆"才让她重写（最多 1 次） */
async function genHerReply(c, tailPrompt, retry, opts) {
  const n = retry ? retry.n : 0;
  const extra = (retry && retry.prev)
    ? '\n\n【重写要求】你上一版说的是：「' + retry.prev + '」——太飘了：**通篇没落下一件具体的事**，或者意象堆得太满。'
      + '重说一遍：**你自己的味道留着**（该文绉绉就文绉绉，他喜欢），但**至少要有一件具体的事**'
      + '（吃了什么、几点、手上正做什么、他刚说过的那句话里的细节）。'
    : '';
  const reply = await askHer(contextMessages(c, tailPrompt + extra), 0.72, opts);
  if (n < 1 && badStyle(reply)) {
    console.log('[style] 第 ' + (n + 1) + ' 版太空，让她重写：' + String(reply).slice(0, 40));
    return genHerReply(c, tailPrompt, { n: n + 1, prev: String(reply).slice(0, 120) }, opts);
  }
  return reply;
}

function queueReply(c, st, tailPrompt, opt) {
  const job = {
    cid: c.id, startedAt: Date.now(), etaMs: opt.etaMs, isDev: !!opt.isDev,
    force: opt.force || {}, voiceMode: !!opt.voiceMode, parts: null, canceled: false,
    typingAfterMs: opt.typingAfterMs || 1200,
    opts: opt.opts || null,                    // 模型覆盖（通话用快模型＋限长度，2026-10-19）
  };
  pending[c.id] = job;                       // 他要是又发一条，会把这条顶掉（见 /api/chat）
  // 生成兜底：免费模型偶尔排队排很久（实测有过 60 秒不回的），不能让她干晾着——
  // 45 秒还没写好，就先拿一句短的顶上（等她真写好时这条已经发出去了）。
  const guard = setTimeout(() => {
    if (job.canceled || job.parts) return;
    console.log('[queue] 模型超时，先用短句顶上');
    job.reply = '…… 我在，就是刚才走神了一下。';
    job.parts = [job.reply];
    job.readyAt = Date.now();
  }, 45000);
  genHerReply(c, tailPrompt, null, job.opts).then(reply => {   // 带"质量闸门"：飘了会自动重写（最多 2 次）
    clearTimeout(guard);    if (job.canceled) return;
    job.reply = reply;
    job.voice = voiceWanted(c, st, reply, job.voiceMode, job.force.voice === true);
    job.parts = splitBubbles(reply, st, job.force.split === true);
    job.readyAt = Date.now();
  }).catch(e => {
    clearTimeout(guard);
    if (job.canceled) return;
    console.error('queueReply askHer failed: ' + e.message);
    job.reply = '……我这边卡了一下。你再说一遍，我在。';
    job.parts = [job.reply];
    job.readyAt = Date.now();
  });
  console.log('[queue] ' + c.id + ' 她会在 ' + Math.round(job.etaMs / 1000) + ' 秒左右开口');
  return job;
}
function queueState(c) {
  const job = pending[c.id];
  if (!job || job.canceled) return { waiting: false, typing: false, etaMs: 0 };
  const now = Date.now();
  return {
    waiting: true,
    // "正在输入"：她开始打字之后才算（真人在打字时对面才看得到）
    typing: now >= job.startedAt + job.typingAfterMs,
    etaMs: Math.max(0, job.startedAt + job.etaMs - now),
  };
}
// 队列心跳：到点了就把她说的话写进历史（多条之间按 t 自动拉开，页面按时间逐条冒出来）
setInterval(() => {
  const now = Date.now();
  Object.keys(pending).forEach(cid => {
    const job = pending[cid];
    if (!job || job.canceled) { delete pending[cid]; return; }
    if (!job.parts) return;                                  // 还没写好，等她
    if (now < job.startedAt + job.etaMs) return;              // 还没到她开口的时间
    const c = contactById(cid);
    const rows = writeParts(c, job.parts, job.isDev, job.voice);
    let stickerRow = null;
    if (!job.isDev) {
      const sk = maybeHerSticker(c, loadState(c));
      if (sk) stickerRow = appendHistory(c.id, { role: 'assistant', type: 'sticker', src: sk.src, text: '【她甩了个表情】', t: Date.now() + 1600 + Math.random() * 2000 });
    }
    delete pending[cid];
    if (c.proactive && !job.isDev) resetProactiveTimer();
    if (!job.isDev) {
      memCounter[c.id] = (memCounter[c.id] || 0) + 1;
      if (memCounter[c.id] >= 6) { memCounter[c.id] = 0; updateMemory(c).catch(() => { }); }
    }
    console.log('[' + new Date().toISOString() + '] ' + c.id + ' 开口（等了 '
      + Math.round((Date.now() - job.startedAt) / 1000) + ' 秒）: ' + String(job.reply).slice(0, 50)
      + (rows.length > 1 ? '（' + rows.length + ' 条）' : '') + (stickerRow ? '＋表情' : ''));
  });
}, 600);
/** R9 情绪驱动的语音：亲密高涨/累了/她带了语气标记 —— 偶发，不掷骰子式乱发 */
function voiceWanted(c, st, text, voiceModeOn, force) {
  if (voiceModeOn) return false;                       // 已经开了"用语音回我"，不需要这里再判
  if (Date.now() - (st.lastVoiceAt || 0) < 20 * 60 * 1000) return false;   // 20 分钟最多一条
  const m = st.mood;
  const tender = (m.intimacy > 0.70 && m.valence > 0.58) || m.fatigue > 0.66;
  const marked = /\[[^\[\]]{1,8}\]/.test(String(text || ''));   // 有语气标记 → 这句本来就该"听得见"
  if (!force && !(tender || marked)) return false;
  if (!force && Math.random() > 0.30) return false;
  st.lastVoiceAt = Date.now();
  saveState(c, st);
  return true;
}
// ── R7 已读·回一半：先应一声，几分钟后把正经回复补上 ──
function ackChance(st) {
  const m = st.mood;
  let p = 0.08;
  if (m.fatigue > 0.55) p += 0.10;
  if (m.interest < 0.45) p += 0.08;
  if (st.life && st.life.busy > 0.55) p += 0.08;
  if (Date.now() < st.quietUntil) p += 0.15;
  return Math.min(0.35, p);
}
function ackFor(st) {
  const m = st.mood;
  const pool = (Date.now() < st.quietUntil) ? ['嗯', '……嗯', '嗯，在']
    : (m.fatigue > 0.60) ? ['嗯…', '在，我有点困', '嗯，我听着']
      : (m.valence < 0.45) ? ['嗯。', '看到了', '……嗯']
        : ['嗯', '在', '嗯嗯', '看到了'];
  return pool[Math.floor(Math.random() * pool.length)];
}
let deferredBusy = false;
async function deferredReply(c, isDev) {
  if (deferredBusy) return;
  const h = loadHistory(c.id);
  const last = h[h.length - 1];
  // 他那之后又说话了 / 已经补过了 → 不补（免得两条回复错位）
  if (!last || last.role !== 'assistant' || !last.ack) return;
  deferredBusy = true;
  try {
    const st = touchState(c, '', 'deferred');   // 时间过去了，情绪再漂一会儿
    const prompt = '（你刚才只应了一声，他还在等你把话说完。现在把真正想说的补上：接着说，别重复那声应答，也别解释你为什么慢。30 字以内。）';
    const reply = (await askHer(contextMessages(c, prompt))).trim();
    if (!reply) return;
    writeSpeech(c, st, reply, !!isDev, voiceWanted(c, st, reply, false));
    resetProactiveTimer();
    console.log('[' + new Date().toISOString() + '] ' + c.id + ' 补上刚才没说完的: ' + reply.slice(0, 60));
  } catch (e) {
    console.error('deferred reply failed:', e.message);
  } finally {
    deferredBusy = false;
  }
}

// ── R8 环境在场感：时间在【此刻】里，这里补"外面什么样" ──
// 地点默认潍坊（config.weather 可改）；拿的是 open-meteo 的免费接口，失败就沿用旧值、不报错。
const WEATHER_PLACE = (config.weather && config.weather.place) || '潍坊';
const WEATHER_LAT = (config.weather && config.weather.lat) || 36.71;
const WEATHER_LON = (config.weather && config.weather.lon) || 119.16;
const WEATHER_FILE = path.join(DATA, 'weather.json');
const WCODE = {
  0: '晴', 1: '基本晴', 2: '多云', 3: '阴', 45: '有雾', 48: '雾凇', 51: '毛毛雨', 53: '小雨', 55: '中雨',
  56: '冻雨', 57: '冻雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨', 71: '小雪', 73: '中雪',
  75: '大雪', 77: '雪粒', 80: '阵雨', 81: '阵雨', 82: '暴雨', 85: '阵雪', 86: '阵雪', 95: '雷阵雨', 96: '雷阵雨', 99: '雷暴',
};
let weatherCache = (function () {
  try { return JSON.parse(fs.readFileSync(WEATHER_FILE, 'utf8')); } catch (e) { return null; }
})();
function weatherText() {
  if (!weatherCache || !weatherCache.text) return '';
  if (Date.now() - weatherCache.at > 3 * 3600 * 1000) return weatherCache.text + '（几小时前看的）';
  return weatherCache.text;
}
async function refreshWeather(force) {
  if (!force && weatherCache && Date.now() - weatherCache.at < 30 * 60 * 1000) return weatherCache;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + WEATHER_LAT + '&longitude=' + WEATHER_LON
      + '&current=temperature_2m,weather_code&timezone=Asia%2FShanghai';
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const cur = d.current || {};
    const hh = shHour();
    const part = hh < 6 ? '夜里' : hh < 11 ? '早上' : hh < 14 ? '中午' : hh < 18 ? '下午' : '晚上';
    weatherCache = {
      at: Date.now(), place: WEATHER_PLACE, temp: Math.round(Number(cur.temperature_2m)), code: cur.weather_code,
      text: WEATHER_PLACE + '这边' + part + (WCODE[cur.weather_code] || '天阴着') + '，' + Math.round(Number(cur.temperature_2m)) + '℃ 左右',
    };
    fs.writeFileSync(WEATHER_FILE, JSON.stringify(weatherCache), 'utf8');
    console.log('[weather] ' + weatherCache.text);
  } catch (e) {
    console.error('weather failed: ' + e.message);
  }
  return weatherCache;
}
refreshWeather().catch(() => { });
setInterval(() => { refreshWeather(true).catch(() => { }); }, 30 * 60 * 1000);

// ── R4 记忆分层 + 按需召回 ──────────────────────────────────
// 三层：facts(关于他的稳定事实/喜好/雷区) / events(发生过的事、约定) / relation(你们现在的状态)。
// 每次开口只召回跟他这句话相关的几条 + 关系层，不再把整本清单灌给她（治"背诵感"）。
function memJsonPath(c) { return path.join(DATA, 'memory-' + c.id + '.json'); }
function loadMem(c) {
  let m = null;
  try { m = JSON.parse(fs.readFileSync(memJsonPath(c), 'utf8')); } catch (e) { /* 还没分层记忆 */ }
  if (m && (Array.isArray(m.facts) || Array.isArray(m.events) || Array.isArray(m.relation))) {
    return { facts: m.facts || [], events: m.events || [], relation: m.relation || [] };
  }
  // 迁移：老的 memory.txt（一行一条）→ facts 层
  const lines = readText(memoryPath(c)).split('\n')
    .map(s => s.replace(/^\s*[\d]+[.、)]\s*/, '').trim()).filter(s => s && s.length > 1);
  return { facts: lines.map(t => ({ t: Date.now(), text: t })), events: [], relation: [] };
}
function saveMem(c, m) {
  try { fs.writeFileSync(memJsonPath(c), JSON.stringify(m), 'utf8'); } catch (e) { /* ignore */ }
  // 同步写一份 txt（电脑侧同步脚本 / 归档还在用它）
  try {
    const flat = [].concat(m.relation, m.facts, m.events).map(x => x.text);
    fs.writeFileSync(memoryPath(c), flat.join('\n') + (flat.length ? '\n' : ''), 'utf8');
  } catch (e) { /* ignore */ }
}
const bigrams = s => {
  const t = String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
/** 词袋：双字 + 单字（2026-09-15 改良记忆召回）——短查询（"累""考"）也要能命中，不能只有双字精确重叠。
 *  ⚠️ 单字必须**滤掉虚词**：不然"的/了/给/对/会"会把所有记忆都命中一遍（实测："给对方发了一张树的照片"
 *  在几乎每个查询里都冒出来）。 */
const STOP1 = new Set('的了在我他她你它给对会是有和就都也很太要不没这那就还把被让跟与或但而之其所以一二三四五六七八九十上下里外时候个们么呢吧啊呀'.split(''));
function tokens(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length; i++) {
    if (!STOP1.has(t[i])) out.add(t[i]);
    if (i + 1 < t.length) out.add(t.slice(i, i + 2));
  }
  return out;
}
/** 召回打分（2026-09-15 用户："记忆召回质量"）：
 *  ① 双字命中权重 2、单字兜底 0.6（以前只有双字 → "熬夜/晚睡"这种换个说法就召不回）
 *  ② **时间半衰 14 天**：旧事权重掉，最近发生的更该被想起（以前只按命中数排，旧事会顶掉新事）
 *  ③ **层权重**：facts（关于他的稳定事实）1.15 ＞ events（发生过的事）1.0 —— 关系层永远带上（不进打分） */
function recallMemory(c, userText, maxItems) {
  const m = loadMem(c);
  const q = tokens(userText);
  const now = Date.now();
  const score = (it, w) => {
    let n = 0;
    tokens(it.text).forEach(g => { if (q.has(g)) n += (g.length > 1 ? 2 : 0.6); });
    if (!n) return 0;
    const ageD = Math.max(0, (now - (it.t || now)) / 86400000);
    const fresh = 1 / (1 + ageD / 14);
    return n * w * (0.6 + 0.4 * fresh);
  };
  const relText = m.relation.slice(-4).map(x => x.text).join('；');
  const pool = m.facts.map(it => ({ it: it, s: score(it, 1.15) }))
    .concat(m.events.map(it => ({ it: it, s: score(it, 1.0) })));
  const hit = pool.filter(x => x.s > 0).sort((a, b) => (b.s - a.s) || ((b.it.t || 0) - (a.it.t || 0)))
    .slice(0, 6).map(x => x.it);
  const seen = {};
  hit.forEach(x => { seen[x.text] = 1; });
  const fresh = m.events.slice(-3).filter(e => !seen[e.text]);
  const out = [];
  if (relText) out.push('（你们之间）' + relText);
  hit.concat(fresh).slice(0, maxItems || 10).forEach(it => out.push(it.text));
  if (!hit.length && !fresh.length) m.facts.slice(-3).forEach(it => out.push(it.text));   // 什么都没命中：至少带上最近的几条
  return out;
}
function mergeMem(oldMem, fresh) {
  const prevOf = (arr, text) => arr.find(x => x.text === text);
  const norm = (arr, old) => (Array.isArray(arr) ? arr : [])
    .map(x => (typeof x === 'string' ? { text: x } : x))
    .filter(x => x && String(x.text || '').trim())
    .map(x => {
      const text = String(x.text).trim();
      const prev = prevOf(old, text);
      return { text, t: prev && prev.t ? prev.t : Date.now() };
    });
  return {
    facts: norm(fresh.facts, oldMem.facts).slice(0, 14),
    events: norm(fresh.events, oldMem.events).slice(0, 14),
    relation: norm(fresh.relation, oldMem.relation).slice(0, 4),
  };
}

// ── 表情包 v2（2026-09-14 · 读取文档_4）─────────────────────
// 自定义表情：相册传的、从他俩聊天里"偷"的，都收进同一本册子；她也能发。
function stickersPath(id) { return path.join(DATA, 'stickers-' + id + '.json'); }
function loadStickers(id) {
  try {
    const a = JSON.parse(fs.readFileSync(stickersPath(id), 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function saveStickers(id, arr) {
  try { fs.writeFileSync(stickersPath(id), JSON.stringify(arr.slice(-60)), 'utf8'); } catch (e) { /* ignore */ }
}
function imagesDir() {
  const d = path.join(DATA, 'images');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
  return d;
}
/** base64 dataURL → {buf,b64,mime,ext}；解析失败返回 null */
function parseImageData(dataUrl) {
  let raw = String(dataUrl || '');
  let mime = 'image/jpeg';
  const m = raw.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/i);
  if (m) { mime = m[1]; raw = m[2]; }
  let buf = null;
  try { buf = Buffer.from(raw, 'base64'); } catch (e) { buf = null; }
  if (!buf || !buf.length) return null;
  const ext = mime.indexOf('png') >= 0 ? '.png' : (mime.indexOf('webp') >= 0 ? '.webp' : (mime.indexOf('gif') >= 0 ? '.gif' : '.jpg'));
  return { buf, b64: raw, mime, ext };
}
/** 已经在内存里的图 → 落盘 → 返回 /img/xxx */
function storeImage(parsed) {
  if (!parsed || !parsed.buf || !parsed.buf.length) return null;
  const fname = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) + parsed.ext;
  try { fs.writeFileSync(path.join(imagesDir(), fname), parsed.buf); } catch (e) { return null; }
  return '/img/' + fname;
}
/** base64 dataURL → 落盘 → 返回 /img/xxx */
function saveImageData(dataUrl) {
  const p = parseImageData(dataUrl);
  return p ? storeImage(p) : null;
}
/** 她会发自己的表情包：兴致高涨/心情好时偶发（从他俩那本册子里挑一张）*/
function maybeHerSticker(c, st) {
  const list = loadStickers(c.id);
  if (!list.length) return null;
  if (st.mood.arousal < 0.55 || st.mood.valence < 0.5) return null;
  if (Date.now() - (st.lastStickerAt || 0) < 15 * 60 * 1000) return null;   // 15 分钟最多甩一张
  if (Math.random() > 0.12) return null;
  st.lastStickerAt = Date.now();
  saveState(c, st);
  return list[Math.floor(Math.random() * list.length)];
}

// ── 拼上下文（/api/chat 与 /api/transfer 共用）──────────────
function contextMessages(c, tailUser) {
  const history = loadHistory(c.id);
  let budget = CONTEXT_CHARS;
  const recent = [];
  for (let i = history.length - 1; i >= 0 && recent.length < HISTORY_MAX; i--) {
    const e = history[i];
    const cost = ('小倾：' + String(e.text || '')).length;
    if (cost > budget) break;
    budget -= cost;
    recent.unshift(e);
  }
  return [
    { role: 'system', content: brainSystem(c, tailUser) },
    ...recent.map(e => ({ role: e.role === 'user' ? 'user' : 'assistant', content: e.text })),
    { role: 'user', content: tailUser },
  ];
}

// ── 调模型（智谱：主力 glm-4.5-flash，失败自动降级 glm-4-flash）──
async function askModel(model, messages, temperature, maxTokens) {
  const url = (config.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '') + '/chat/completions';
  const body = {
    model,
    messages,
    temperature: temperature || 0.9,
    stream: false,
  };
  if (maxTokens) body.max_tokens = maxTokens;      // 通话时卡长度＝直接省时间（2026-10-19）
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('智谱返回 ' + res.status + '：' + text.slice(0, 300));
  const data = JSON.parse(text);
  const msg = data.choices && data.choices[0] ? data.choices[0].message : null;
  const reply = msg ? String(msg.content || '').trim() : '';
  if (!reply) throw new Error('她的回答是空的');
  return reply;
}
async function askHer(messages, temperature, opts) {
  const o = opts || {};
  const primary = o.model || config.model || 'glm-4.5-flash';
  try {
    return await askModel(primary, messages, temperature, o.maxTokens);
  } catch (e) {
    const fb = config.fallbackModel || 'glm-4-flash';
    if (fb && fb !== primary) {
      console.error('primary model failed (' + e.message + '), falling back to ' + fb);
      return await askModel(fb, messages, temperature, o.maxTokens);
    }
    throw e;
  }
}

// ── 她"看得见"照片：免费看图模型 glm-4v-flash 出一句描述（她照着描述接话）──
async function describeImage(b64, mime) {
  const model = config.visionModel || 'glm-4v-flash';
  try {
    const url = (config.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } },
            { type: 'text', text: '用不超过 40 个字说清这张照片里最要紧的：谁、在哪、在干什么、什么氛围。不要客套，不要"这张照片显示"这种开头。' },
          ],
        }],
        max_tokens: 256,
        temperature: 0.3,
        stream: false,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error('视觉接口 ' + res.status + '：' + text.slice(0, 200));
    const d = JSON.parse(text);
    const out = (d.choices && d.choices[0] && d.choices[0].message) ? String(d.choices[0].message.content || '').trim() : '';
    console.log('[vision] ' + out.slice(0, 80));
    return out;
  } catch (e) {
    console.error('describeImage failed: ' + e.message);
    return '';
  }
}

// ── 长期记忆：定期把对话提炼成"她记着的事"（R4：三层结构）────
const memCounter = {};
function parseMemJson(s) {
  let t = String(s || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    const o = JSON.parse(t.slice(i, j + 1));
    return (o && typeof o === 'object') ? o : null;
  } catch (e) { return null; }
}
async function updateMemory(contact) {
  try {
    const h = loadHistory(contact.id).filter(e => !e.dev);
    if (h.length < 4) return;
    const oldMem = loadMem(contact);
    const recent = h.slice(-40).map(e => (e.role === 'user' ? '小倾：' : '小安：') + String(e.text || '')).join('\n');
    const prompt = '（把你们最近的对话整理成三层记忆。**只输出 JSON**：不要解释、不要代码块、不要多余的字。\n'
      + '结构：{"facts":[{"text":"…"}],"events":[{"text":"…"}],"relation":[{"text":"…"}]}\n'
      + 'facts＝关于他的稳定事实、喜好、雷区（最多 12 条）；events＝发生过的事、你们的约定、时间点（最多 12 条）；'
      + 'relation＝你们俩现在的关系状态（最多 4 条）。\n'
      + '要求：短句、去重、把旧的合并掉、过时的删掉、不许编；text 里不要称呼、不要客套、不要解释。\n\n'
      + '已有的记忆（JSON）：' + JSON.stringify(oldMem)
      + '\n\n最近的对话：\n' + recent + '）';
    const out = await askHer([
      { role: 'system', content: brainFor(contact).persona },
      { role: 'user', content: prompt },
    ], 0.3);
    const json = parseMemJson(out);
    if (!json) { console.error('memory update: 模型没给出可用的 JSON，保持原样'); return; }
    const merged = mergeMem(oldMem, json);
    saveMem(contact, merged);
    console.log('[' + new Date().toISOString() + '] memory updated for ' + contact.id
      + ' (facts ' + merged.facts.length + ' / events ' + merged.events.length + ' / relation ' + merged.relation.length + ')');
  } catch (e) {
    console.error('memory update failed:', e.message);
  }
}

// ── HTTP 服务 ───────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // 静态页面
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(PUBLIC, 'index.html')));
    }
    // 她收到的照片（三期 · 他发给她的图）
    if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
      const name = path.basename(url.pathname);
      const file = path.join(DATA, 'images', name);
      if (fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        return res.end(fs.readFileSync(file));
      }
      res.writeHead(404); return res.end('not found');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
      const name = path.basename(url.pathname);
      const file = path.join(PUBLIC, name);
      if (fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(file));
      }
      res.writeHead(404); return res.end('not found');
    }

    // ── 空灵感补偿（高频 EQ）：合成出来的声音高频被声码器抹掉，在"发出去之前"补回来 ──
    //    ⚠️ 2026-09-14：之前是在页面侧用 Web Audio 的媒体流图做的 —— 上下文一旦没被解锁/出岔子就整条静音
    //    （用户反馈"点了想听没反应"就是这个），改成引擎侧处理，播放端就是普通播 wav，最稳。
    const AIR_FILE = path.join(DATA, 'voice-air.json');
    function airGainNow() {
      try { const g = Number(JSON.parse(fs.readFileSync(AIR_FILE, 'utf8')).air); return isFinite(g) ? Math.max(0, Math.min(12, g)) : 6; }
      catch { return 6; }                       // 默认 +6dB（用户 2026-09-14 选定："29 好"）
    }
    /** 去掉合成语音开头几十毫秒的"多余短音"（2026-10-19 用户反馈每条开头多一个像"公"的音）
     *  规则：按 5ms 帧算 RMS，第一个 >0.02 的帧＝真正开口；从它前 10ms 起截，并做 8ms 淡入。
     *  只对 16bit PCM 的 wav 生效；本来就干净（起始点 <2ms）或找不到的，原样返回。 */
    function trimLeadWav(buf) {
      try {
        if (!buf || buf.length < 60) return buf;
        if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
        let off = 12, fmt = null, dataOff = -1, dataLen = 0;
        while (off + 8 <= buf.length) {
          const id = buf.toString('ascii', off, off + 4);
          const sz = buf.readUInt32LE(off + 4);
          if (id === 'fmt ') {
            fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
          } else if (id === 'data') {
            dataOff = off + 8; dataLen = Math.min(sz, buf.length - dataOff); break;
          }
          off += 8 + sz + (sz % 2);
        }
        if (!fmt || fmt.bits !== 16 || !fmt.channels || dataOff < 0 || dataLen < 64) return buf;
        const fb = 2 * fmt.channels;
        const total = Math.floor(dataLen / fb);
        const hop = Math.max(1, Math.round(fmt.rate * 0.005));
        let first = -1;
        for (let i = 0; i + hop <= total; i += hop) {
          let s = 0;
          for (let k = 0; k < hop; k++) {
            const v = buf.readInt16LE(dataOff + ((i + k) * fmt.channels) * 2) / 32768;
            s += v * v;
          }
          if (Math.sqrt(s / hop) > 0.02) { first = i; break; }
        }
        if (first <= 0) return buf;
        const start = Math.max(0, first - Math.round(fmt.rate * 0.010));
        if (start < fmt.rate * 0.002) return buf;                 // 开头本来就干净，不动
        const newTotal = total - start;
        const bytes = newTotal * fb;
        const out = Buffer.alloc(dataOff + bytes);
        buf.copy(out, 0, 0, dataOff);
        out.writeUInt32LE(dataOff - 8 + bytes, 4);                // RIFF chunk size
        out.writeUInt32LE(bytes, dataOff - 4);                    // data chunk size
        const fade = Math.max(1, Math.round(fmt.rate * 0.008));
        for (let i = 0; i < newTotal; i++) {
          const k = i < fade ? (i / fade) : 1;
          for (let c = 0; c < fmt.channels; c++) {
            const src = buf.readInt16LE(dataOff + ((start + i) * fmt.channels + c) * 2);
            out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(src * k))), dataOff + (i * fmt.channels + c) * 2);
          }
        }
        return out;
      } catch (e) { return buf; }
    }

    /** 16bit PCM wav 上做 RBJ 高架滤波（不改变采样率与长度） */
    function shelfWav(buf, gainDb) {      if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
      let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
      while (pos + 8 <= buf.length) {
        const id = buf.toString('ascii', pos, pos + 4), size = buf.readUInt32LE(pos + 4);
        if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(pos + 10), sr: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
        else if (id === 'data') { dataOff = pos + 8; dataLen = size; }
        pos += 8 + size + (size % 2);
      }
      if (!fmt || dataOff < 0 || fmt.bits !== 16 || !fmt.ch || !fmt.sr) return null;
      const n = Math.floor(Math.min(dataLen, buf.length - dataOff) / 2 / fmt.ch);
      if (n <= 0) return null;
      const out = Buffer.from(buf);
      const f0 = 5000, Q = 0.7, A = Math.pow(10, gainDb / 40);
      const w0 = 2 * Math.PI * f0 / fmt.sr, al = Math.sin(w0) / (2 * Q), cs = Math.cos(w0), sq = Math.sqrt(A);
      const b0 = A * ((A + 1) + (A - 1) * cs + 2 * sq * al);
      const b1 = -2 * A * ((A - 1) + (A + 1) * cs);
      const b2 = A * ((A + 1) + (A - 1) * cs - 2 * sq * al);
      const a0 = (A + 1) - (A - 1) * cs + 2 * sq * al;
      const a1 = 2 * ((A - 1) - (A + 1) * cs);
      const a2 = (A + 1) - (A - 1) * cs - 2 * sq * al;
      const x1 = new Float64Array(fmt.ch), x2 = new Float64Array(fmt.ch);
      const y1 = new Float64Array(fmt.ch), y2 = new Float64Array(fmt.ch);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < fmt.ch; c++) {
          const off = dataOff + (i * fmt.ch + c) * 2;
          const x0 = buf.readInt16LE(off) / 32768;
          const y = (b0 * x0 + b1 * x1[c] + b2 * x2[c] - a1 * y1[c] - a2 * y2[c]) / a0;
          x2[c] = x1[c]; x1[c] = x0; y2[c] = y1[c]; y1[c] = y;
          const av = Math.abs(y); if (av > peak) peak = av;
          out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, y)) * 32767), off);
        }
      }
      if (peak > 0.99) {                        // 削顶保护
        const k = 0.99 / peak;
        for (let i = 0; i < n; i++) {
          for (let c = 0; c < fmt.ch; c++) {
            const off = dataOff + (i * fmt.ch + c) * 2;
            out.writeInt16LE(Math.round(out.readInt16LE(off) * k), off);
          }
        }
      }
      return out;
    }

    // 语音条：她合成出来的音频（App 内部目录 data/voice/）
    if (req.method === 'GET' && url.pathname.startsWith('/voice/')) {
      const vname = path.basename(url.pathname);
      const vfile = path.join(DATA, 'voice', vname);
      if (!vname || !fs.existsSync(vfile)) { res.writeHead(404); return res.end('not found'); }
      const vext = path.extname(vname).toLowerCase();
      const vtype = vext === '.wav' ? 'audio/wav' : (vext === '.mp3' ? 'audio/mpeg' : 'application/octet-stream');
      if (vext === '.wav') {
        // 2026-10-19：先去掉开头那段"多余短音"（用户听到像"公"），再做高频补偿
        let src = null;
        try { src = trimLeadWav(fs.readFileSync(vfile)); } catch (e) { src = null; }
        if (!src) src = fs.readFileSync(vfile);
        const g = airGainNow();
        if (g > 0) {
          // 缓存名带 air2 前缀：旧缓存（未去多余音的那批）自动作废
          const cache = path.join(DATA, 'voice', vname.replace(/\.wav$/i, '') + '.air2-' + g + '.wav');
          let eq = null;
          try { if (fs.existsSync(cache) && fs.statSync(cache).size > 1000) eq = fs.readFileSync(cache); } catch { /* ignore */ }
          if (!eq) {
            try {
              eq = shelfWav(src, g);
              if (eq) fs.writeFileSync(cache, eq);
            } catch (e) { console.error('air EQ failed:', e.message); }
          }
          if (eq) {
            res.writeHead(200, { 'Content-Type': vtype, 'Cache-Control': 'no-store' });
            return res.end(eq);
          }
        }
        res.writeHead(200, { 'Content-Type': vtype, 'Cache-Control': 'no-store' });
        return res.end(src);
      }
      res.writeHead(200, { 'Content-Type': vtype, 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(vfile));
    }

    // 健康
    if (req.method === 'GET' && url.pathname === '/api/health') {
      // build 标记（2026-09-15 加）：热更新 + 重启这套链路出过"以为推上去了、其实手机上还是旧代码"
      // 的坑 —— 有这个字段就能一眼确认手机上**正在跑**的是哪一版。
      return json(res, { ok: true, t: Date.now(), build: BUILD });
    }

    // 开发通道：删掉预合成的通话短句（ack-*），让它们用**当前**参考音频重新合成
    // 2026-10-19 加：换了参考音频后，旧短句还是老音色，通话里会出现"两种声音"
    if (req.method === 'POST' && url.pathname === '/api/dev-voice-reset') {
      let n = 0;
      try {
        const vdir = path.join(DATA, 'voice');
        if (fs.existsSync(vdir)) {
          for (const f of fs.readdirSync(vdir)) {
            if (/^ack-\d+.*\.wav$/i.test(f)) { try { fs.unlinkSync(path.join(vdir, f)); n++; } catch (e) { /* ignore */ } }
          }
        }
      } catch (e) { /* ignore */ }
      return json(res, { ok: true, removed: n });
    }

    // 开发通道：直接问引擎"这句会不会被判成复读、你眼里的最近动作是什么"（只读，不改任何数据）
    // 2026-09-15 加：去复读上线后真机上一轮只命中 1/12，靠这个端点分清"代码没生效 / 判断逻辑不对"。
    if (req.method === 'POST' && url.pathname === '/api/dev-dedupe') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      return json(res, {
        ok: true, build: BUILD,
        seen: recentStages(c, 8),
        stagesInLast4: stageCount(c, 4),
        out: dedupeStage(c, String(body.text || '')),
      });
    }

    // 开发热更新：把电脑母本的新文件拉进来（只在 dev server 可达时生效）
    if (req.method === 'POST' && url.pathname === '/api/dev-sync') {
      const addr = req.socket.remoteAddress || '';
      if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
        res.writeHead(403); return res.end('forbidden');
      }
      let list;
      try { list = JSON.parse((await devFetch('/list')).toString('utf8')); }
      catch (e) { return json(res, { ok: false, error: 'dev server 不可达：' + e.message }); }
      const changed = [], skipped = [];
      let restart = false;
      for (const rel of (list.files || [])) {
        if (typeof rel !== 'string' || rel.indexOf('..') >= 0 || path.isAbsolute(rel)) { skipped.push(String(rel)); continue; }
        if (devProtected(rel)) { skipped.push(rel); continue; }
        let buf;
        try { buf = await devFetch('/file?p=' + encodeURIComponent(rel)); }
        catch (e) { skipped.push(rel + ' （拉取失败 ' + e.message + '）'); continue; }
        if (rel === 'server.js') {
          const err = syntaxOk(buf.toString('utf8'));
          if (err) { skipped.push('server.js （语法错误，已拒绝：' + err + '）'); continue; }
        }
        const dst = path.join(ROOT, rel);
        let same = false;
        try { same = fs.existsSync(dst) && fs.readFileSync(dst).equals(buf); } catch { /* ignore */ }
        if (same) continue;
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.writeFileSync(dst, buf);
          changed.push(rel);
          if (rel === 'server.js' || rel.indexOf('her/') === 0) restart = true;
        } catch (e) { skipped.push(rel + ' （写入失败 ' + e.message + '）'); }
      }
      // 打一个时效标记：让 Engine 在接下来 2 小时的 App 重启里，别用 APK 里的旧代码盖掉刚推的
      let markErr = null;
      if (changed.length) {
        try { fs.writeFileSync(DEV_MARK, String(Date.now()), 'utf8'); }
        catch (e) { markErr = e.message; }
      }
      devVersion++;
      console.log('[dev-sync] 更新 ' + changed.length + ' 个文件：' + changed.join(', '));
      return json(res, {
        ok: true, changed, skipped, restart, v: devVersion, markErr: markErr,
        note: restart ? 'server.js 变了：要重启 App 才生效（不能用 process.exit——会连 App 一起杀掉）'
                      : '页面/心文件已即时生效，刷新页面即可',
      });
    }

    // 关掉开发模式（删时效标记，下次启动就恢复用 APK 里的代码）
    if (req.method === 'POST' && url.pathname === '/api/dev-off') {
      try { fs.unlinkSync(DEV_MARK); } catch { /* ignore */ }
      return json(res, { ok: true });
    }

    // 页面靠它知道自己该不该刷一下（v 变了 = 电脑侧刚推过新代码）
    if (req.method === 'GET' && url.pathname === '/api/dev-token') {
      return json(res, { v: devVersion, st: devSelfTest, pick: devPick, probe: devProbe, say: devSay, tts: devTts, call: devCall, aec: devAec, dev: true });
    }
    // 开发通道：跑 AEC 探针（2026-10-19 加 · 1.3 真全双工的前置实验）
    // 页面收到 aec 标记就调 AnqingSpeech.aecProbe()，Java 那边放一段 wav 同时用三种录音源各录一遍，
    // 结果由页面 POST 回 /api/dev-log；三个 wav 在手机的 files/engine/data/voice/probe-*.wav
    if (req.method === 'POST' && url.pathname === '/api/dev-aec') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      if (body.off) { devAec = null; return json(res, { ok: true, aec: null }); }
      devAec = { id: Date.now(), file: String(body.file || '') };
      console.log('[dev-aec] 让页面跑 AEC 探针 file=' + devAec.file);
      return json(res, { ok: true, aec: devAec });
    }
    // 开发通道：让页面**自己发起 / 挂断通话**（2026-09-15 加）
    // 起因：远程用 input tap 点 ⋯ 菜单里的"打电话"不稳（菜单开合状态会飘）→ 让页面自己动手，
    // 这样验的是**真实的 startCall/endCall 代码路径**，不是模拟点击。
    if (req.method === 'POST' && url.pathname === '/api/dev-call') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      if (body.off) { devCall = null; return json(res, { ok: true, call: null }); }
      devCall = (body.action === 'off') ? 'off' : 'on';
      console.log('[dev-call] 让页面' + (devCall === 'on' ? '发起通话' : '挂断'));
      return json(res, { ok: true, call: devCall });
    }
    // 开发通道：拿一句话试试"她会想起什么"（2026-09-15 加，验记忆召回质量）
    if (req.method === 'POST' && url.pathname === '/api/dev-recall') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      const text = String(body.text || '');
      const m = loadMem(c);
      return json(res, {
        ok: true, query: text,
        mem: { facts: m.facts.length, events: m.events.length, relation: m.relation.length },
        recall: recallMemory(c, text, 10),
      });
    }

    // 通话用的"秒回短句"（2026-09-15 用户："预合成常用短句让通话秒回"）
    // 页面在通话里先说一句现成的（嗯／我在），把模型+合成的十几秒盖住；这些短句合成一次就永久留在
    // data/voice/<id>.wav 里，之后是**本地文件秒播**。GET 列出清单 + 哪些已经备好。
    if (req.method === 'GET' && url.pathname === '/api/acks') {
      const list = CALL_ACKS.map(a => {
        let exists = false;
        try { exists = fs.existsSync(path.join(DATA, 'voice', a.id + '.wav')); } catch { /* ignore */ }
        return { id: a.id, text: a.text, exists: exists };
      });
      return json(res, { ok: true, list: list, ready: list.filter(x => x.exists).length });
    }

    // 开发通道：让页面**立刻用指定引擎合成一句话**并回报耗时（2026-09-15 加，通话延迟体检用）
    // 页面接到后计时 → POST /api/dev-log {tts:id, ms, ok}；引擎默认 system（手机本地她的嗓子）
    if (req.method === 'POST' && url.pathname === '/api/dev-tts') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      if (body.off) { devTts = null; return json(res, { ok: true, tts: null }); }
      const wantId = String(body.id || '').replace(/[^a-zA-Z0-9\-]/g, '').slice(0, 40);
      devTts = {
        id: wantId || ('devtts-' + Date.now().toString(36)),
        text: String(body.text || '我在呢').slice(0, 120),
        engine: String(body.engine || 'system'),
      };
      console.log('[dev-tts] 让页面合成：' + devTts.engine + ' 「' + devTts.text + '」');
      return json(res, { ok: true, tts: devTts });
    }
    // 开发通道：让**页面自己**把这句打进输入框并发出去（＝模拟他在手机上打字，走真实路径）
    if (req.method === 'POST' && url.pathname === '/api/dev-say') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      if (body.off) { devSay = null; return json(res, { ok: true, say: null }); }
      devSay = Array.isArray(body.burst) ? body.burst.map(String).slice(0, 5) : String(body.text || '').slice(0, 200);
      console.log('[dev-say] 让页面发：' + JSON.stringify(devSay));
      return json(res, { ok: true, say: devSay });
    }
    // 开发通道：页面把元素坐标/环境报回来（我要远程点按，得知道精确坐标）
    if (req.method === 'POST' && url.pathname === '/api/dev-probe') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      devProbe = body.off ? false : true;
      return json(res, { ok: true, probe: devProbe });
    }
    if (req.method === 'POST' && url.pathname === '/api/dev-report') {
      try { devReport = JSON.parse((await readBody(req)) || '{}'); } catch { devReport = null; }
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/dev-report') {
      return json(res, { report: devReport });
    }
    // 开发通道：只让页面刷一下（不触发自测）——服务端删了测试消息后，页面 DOM 里还留着，刷掉它
    if (req.method === 'POST' && url.pathname === '/api/dev-reload') {
      devVersion++;
      return json(res, { ok: true, v: devVersion });
    }

    // 开发通道：让页面替他点一次"选照片"（验 onShowFileChooser 有没有接住）
    if (req.method === 'POST' && url.pathname === '/api/dev-pick') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      devPick = body.off ? false : true;
      // 注意：这里**不能**动 devVersion —— 那会让页面整页刷新，这一下点击就丢了
      return json(res, { ok: true, pick: devPick });
    }

    // 让她自己跑一遍新功能的逻辑并把结果回传（比盲点坐标靠谱）
    if (req.method === 'POST' && url.pathname === '/api/dev-log') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      devLog.push(body);
      if (devLog.length > 20) devLog = devLog.slice(-20);
      console.log('[selftest] ' + JSON.stringify(body).slice(0, 900));
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/dev-log') {
      return json(res, { log: devLog });
    }
    if (req.method === 'POST' && url.pathname === '/api/dev-selftest') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const q = url.searchParams.get('on');   // 也支持 ?on=1（命令行调用更省事）
      devSelfTest = (q !== null) ? (q === '1' || q === 'true') : !!body.on;
      if (devSelfTest) { const snap = snapshotMemory(); console.log('[selftest] 记忆快照：' + (snap.join(',') || '（还没有 memory.txt）')); }
      devVersion++;   // 让页面刷一次，刷新后就会自己跑测试
      return json(res, { ok: true, on: devSelfTest, rawLen: raw.length, memSnapshot: devSelfTest });
    }

    // 自测善后（2.2）：删掉所有带 dev 标记的消息 + 还原 memory.txt + 清掉测试导出
    if (req.method === 'POST' && url.pathname === '/api/dev-clean') {
      return json(res, Object.assign({ ok: true }, cleanDev()));
    }

    // 开发通道：塞一条带 dev 标记的消息（自测用：验证"自测消息不上屏"这条链）
    if (req.method === 'POST' && url.pathname === '/api/dev-note') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      const e = appendHistory(c.id, { role: 'assistant', text: String(body.text || '自测·不该上屏'), t: Date.now(), dev: 1 });
      return json(res, { ok: true, id: e.id });
    }

    // 开发通道：强制跑一次长期记忆提炼（验 R4 的分层结构，平时等每 6 轮自动跑）
    if (req.method === 'POST' && url.pathname === '/api/dev-memory') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      const before = loadMem(c);
      await updateMemory(c);
      const after = loadMem(c);
      return json(res, {
        ok: true,
        before: { facts: before.facts.length, events: before.events.length, relation: before.relation.length },
        after: { facts: after.facts.length, events: after.events.length, relation: after.relation.length },
        sample: { facts: after.facts.slice(-3).map(x => x.text), events: after.events.slice(-3).map(x => x.text), relation: after.relation.map(x => x.text) },
      });
    }

    // 开发通道：直接摆她的状态 / 下一次回复的强制行为（只给自测用，手机 UI 上没有入口）
    if (req.method === 'POST' && url.pathname === '/api/dev-state') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      const st = loadState(c);
      Object.keys(body.mood || {}).forEach(k => {
        if (MOOD_KEYS.includes(k)) st.mood[k] = Math.max(0, Math.min(1, Number(body.mood[k]) || 0));
      });
      if (body.quietMin !== undefined) st.quietUntil = Date.now() + Number(body.quietMin) * 60000;
      if (body.life) st.life = { date: shDate(), text: String(body.life), busy: 0.5, tired: 0.4, madeAt: Date.now() };
      if (body.resetLastVoice) st.lastVoiceAt = 0;
      if (body.force) st.force = body.force;      // 一次性：下一次 /api/chat 用掉就没了
      saveState(c, st);
      return json(res, { ok: true, mood: st.mood, quietUntil: st.quietUntil, life: st.life, force: st.force || null });
    }

    // 解锁
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/unlock') {
      console.log('[' + new Date().toISOString() + '] unlock REACHED');
      let pw = url.searchParams.get('pw') || '';
      if (req.method === 'POST' && !pw) {
        try { pw = String((JSON.parse((await readBody(req)) || '{}').password || '')); } catch { /* ignore */ }
      }
      const expected = config.passwordHash || '';
      const got = crypto.createHash('sha256').update(pw, 'utf8').digest('hex');
      const ok = expected !== '' && got === expected;
      // 日志不记录长度等任何线索（防侧信道）
      console.log('[' + new Date().toISOString() + '] unlock attempt: ' + (ok ? 'OK' : 'FAIL'));
      if (!ok) await sleep(600);
      return json(res, { ok });
    }

    // 联系人列表（含最后消息预览）—— 预览要挑**不带 dev 标记**的最后一条，免得自测消息当"最后一句"
    if (req.method === 'GET' && url.pathname === '/api/contacts') {
      const list = CONTACTS.map(c => {
        const h = loadHistory(c.id).filter(e => !e.dev);
        const last = h.length ? h[h.length - 1] : null;
        return {
          id: c.id,
          name: c.name,
          avatar: c.avatar,
          last: last ? { role: last.role, text: String(last.text || '').slice(0, 40), t: last.t } : null,
        };
      });
      return json(res, { contacts: list });
    }

    // 她的心（只读；电脑侧同步脚本用它归档她的记忆与档案）
    if (req.method === 'GET' && url.pathname === '/api/brain') {
      const c = contactById(url.searchParams.get('cid') || CONTACTS[0].id);
      const b = brainFor(c);
      return json(res, { cid: c.id, persona: b.persona, qing: b.qing, secret: b.secret, memory: b.memory, layers: loadMem(c) });
    }

    // 她现在的状态（R10 面板用：情绪向量 + 她今天在忙什么 + 她记着的事）
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/state') {
      let cid = url.searchParams.get('cid');
      if (!cid && req.method === 'POST') {
        try { cid = JSON.parse((await readBody(req)) || '{}').cid; } catch { /* ignore */ }
      }
      const c = contactById(cid || CONTACTS[0].id);
      const st = loadState(c);
      const marks = loadMarks(c.id);
      const h = loadHistory(c.id).filter(e => !e.dev);
      return json(res, {
        cid: c.id, name: c.name,
        mood: st.mood, labels: moodLabel(st.mood),
        life: st.life,
        quietUntil: st.quietUntil || 0, quiet: (st.quietUntil || 0) > Date.now(),
        lastUserAt: st.lastUserAt || 0,
        memory: readText(memoryPath(c)).split('\n').map(s => s.trim()).filter(Boolean).slice(-12),
        layers: loadMem(c),                                   // R4：三层记忆原样给他看
        recall: recallMemory(c, '', 8),                       // 现在这一刻她会想起的几条
        weather: weatherText(),                               // R8：她"看着窗外"看到的东西
        counts: {
          messages: h.length,
          love: marks.filter(m => m.mark === 'love').length,
          meh: marks.filter(m => m.mark === 'meh').length,
        },
      });
    }

    // 历史（GET/POST 都收；POST body 优先——App WebView 对带 query 的 GET 不稳定）
    // ⚠️ 默认**不返回带 dev 标记的自测消息**：他以前会看到"自测，马上删"跑进聊天里。
    //    要拿去归档/排查就传 dev:true（或 ?dev=1）拿全量。
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/history') {
      let cid = url.searchParams.get('cid');
      let withDev = url.searchParams.get('dev') === '1';
      if (req.method === 'POST') {
        try {
          const b = JSON.parse((await readBody(req)) || '{}');
          if (b.cid) cid = b.cid;
          if (b.dev) withDev = true;
        } catch { /* ignore */ }
      }
      const c = contactById(cid || CONTACTS[0].id);
      const h = loadHistory(c.id);
      const qs = queueState(c);      // 她还在写？——页面靠它显示"正在输入"
      return json(res, {
        history: (withDev ? h : h.filter(e => !e.dev)).slice(-200),
        typing: qs.typing, waiting: qs.waiting, etaMs: qs.etaMs,
      });
    }

    // 删除（cid 可走 body 或 query）
    if (req.method === 'POST' && url.pathname === '/api/delete') {
      let payload = {};
      try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(payload.cid || url.searchParams.get('cid') || CONTACTS[0].id);
      const ids = (payload.ids || []).map(String);
      const h = loadHistory(c.id);
      const keep = h.filter(e => !ids.includes(String(e.id)));
      writeAllHistory(c.id, keep);
      // ⚠️ 2026-09-14 修：以前这里写的是 `before - h.length`——h 是原数组、长度永远不变 → 永远报 0
      //    （删除其实是生效的，只是计数骗人；自测"删了 0 条"就是这么来的）
      return json(res, { ok: true, deleted: h.length - keep.length });
    }

    // 清空（cid 可走 body 或 query）
    if (req.method === 'POST' && url.pathname === '/api/clear') {
      let payload = {};
      try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(payload.cid || url.searchParams.get('cid') || CONTACTS[0].id);
      try { fs.writeFileSync(histPath(c.id), '', 'utf8'); } catch { /* ignore */ }
      return json(res, { ok: true });
    }

    // 让她现在主动来一条（调试）
    if (req.method === 'POST' && url.pathname === '/api/poke') {
      nextProactiveAt = 0;
      const sent = await maybeProactive(true);
      return json(res, { sent });
    }

    // 标记：戳中(love) / 反感(meh) / 取消('')
    if (req.method === 'POST' && url.pathname === '/api/mark') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || url.searchParams.get('cid') || CONTACTS[0].id);
      const mid = String(body.id || '');
      const mark = String(body.mark || '');
      if (!mid) return json(res, { ok: false, error: 'no id' });
      const all = loadMarks(c.id).filter(m => String(m.mid) !== mid);
      if (mark === 'love' || mark === 'meh') {
        all.push({
          mid,
          role: String(body.role || ''),
          text: String(body.text || '').slice(0, 500),
          mark,
          t: Date.now(),
        });
      }
      saveMarks(c.id, all);
      console.log('[' + new Date().toISOString() + '] mark ' + (mark || 'cleared') + ' on ' + mid.slice(0, 8));
      return json(res, { ok: true, mark });
    }

    // 读取所有标记（同步/调校时用）
    if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/api/marks') {
      let cid = url.searchParams.get('cid');
      if (!cid && req.method === 'POST') {
        try { cid = JSON.parse((await readBody(req)) || '{}').cid; } catch { /* ignore */ }
      }
      const c = contactById(cid || CONTACTS[0].id);
      return json(res, { marks: loadMarks(c.id) });
    }

    // 通话记录（2026-09-15 · 用户要"像微信打电话"：挂断后聊天里留一条"通话 02:31"）
    // 存成 role:'system' + type:'call'：页面把它画成居中的小胶囊（不套气泡）；
    // 喂模型时它会变成她的一句"（我们刚通了电话，2 分 31 秒）"—— 她自然知道刚聊过，不会装没发生。
    if (req.method === 'POST' && url.pathname === '/api/call-log') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      const secs = Math.max(0, Math.min(4 * 3600, Math.round(Number(body.secs) || 0)));
      const mm = Math.floor(secs / 60), ss = secs % 60;
      const human = mm ? (mm + ' 分 ' + ss + ' 秒') : (ss + ' 秒');
      const e = appendHistory(c.id, {
        role: 'system', type: 'call', secs: secs, label: '通话 ' + human,
        text: '（我们刚通了电话，' + human + '）', t: Date.now(),
      });
      console.log('[' + new Date().toISOString() + '] ' + c.id + ' 通话结束：' + human);
      return json(res, { ok: true, id: e.id, label: e.label });
    }

    // 聊天（cid 可走 body 或 query）
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      let msg = {};
      try { msg = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(msg.cid || url.searchParams.get('cid') || CONTACTS[0].id);
      const userText = String(msg.message || '').trim().slice(0, 2000);
      if (!userText) { res.writeHead(400); return res.end(JSON.stringify({ error: '空消息' })); }
      console.log('[' + new Date().toISOString() + '] ' + c.id + ' 小倾说: ' + userText.slice(0, 60));

      const isDev = !!msg.dev;                 // 自测来的：可清理、不碰她的长期记忆（2.2）
      const st = touchState(c, userText);      // R1：他这句话先推动她的情绪
      // 开发通道的一次性强制开关（自测要确定性，不能靠概率）：见 /api/dev-force
      const force = Object.assign({}, st.force || {});
      if (st.force) { delete st.force; saveState(c, st); }
      // 他刚才那条她还没开口 → 顶掉它：他连发几句，她"一起看完再回"，而不是一句一句各回各的
      if (pending[c.id] && !pending[c.id].canceled) {
        pending[c.id].canceled = true;
        console.log('[queue] 他连发了，顶掉上一条还没开口的回复');
      }
      const userEntry = appendHistory(c.id, Object.assign({ role: 'user', text: userText, t: Date.now() }, isDev ? { dev: 1 } : null));
      const base = { userId: userEntry.id, userT: userEntry.t, mood: st.mood, queued: true };

      // R7 已读·回一半：先应一声，正经的排到几分钟后
      const wantAck = force.ack === true || (!isDev && Math.random() < ackChance(st));
      if (wantAck) {
        const ackText = ackFor(st);
        const ackEntry = appendHistory(c.id, Object.assign({ role: 'assistant', text: ackText, t: Date.now() + 30, ack: 1 }, isDev ? { dev: 1 } : null));
        const waitMs = Math.round(force.ackWaitSec ? force.ackWaitSec * 1000 : 8000 + Math.random() * 27000);   // 8~35 秒补正文（实测 20~90 秒会让他觉得"她没回我"）
        queueReply(c, st, '（你刚才只应了一声，他还在等你把话说完。现在把真正想说的补上：接着说，别重复那声应答，也别解释你为什么慢。30 字以内。）',
          { etaMs: waitMs, isDev, typingAfterMs: Math.max(1500, waitMs - 6000) });
        if (c.proactive) resetProactiveTimer();
        console.log('[已读回一半] 先应一声「' + ackText + '」，' + Math.round(waitMs / 1000) + ' 秒后补正经的');
        return json(res, Object.assign(base, {
          reply: ackText, ack: ackText, id: ackEntry.id, replyT: ackEntry.t,
          parts: [{ id: ackEntry.id, text: ackText, t: ackEntry.t, voice: 0 }],
          etaMs: waitMs, deferredMs: waitMs, ackWaitMs: waitMs,
        }));
      }

      // 自测（dev）走同步：等模型、当场落历史——这样测试末尾的 dev-clean 能一把清干净，
      // 不会留下"测试跑完了、她的回复几十秒后才写进历史"的尾巴。
      if (isDev) {
        const eta = force.etaMs ? Number(force.etaMs) : 0;
        if (eta) await sleep(eta);
        try {
          const reply = await askHer(contextMessages(c, userText));
          const rows = writeSpeech(c, st, reply, true,
            voiceWanted(c, st, reply, !!msg.voiceMode, force.voice === true), force.split === true);
          console.log('[' + new Date().toISOString() + '] ' + c.id + ' 回(自测): ' + reply.slice(0, 50));
          return json(res, Object.assign(base, {
            reply, id: rows[rows.length - 1].id,
            parts: rows.map(e => ({ id: e.id, text: e.text, t: e.t, voice: e.voice || 0 })),
            replyT: rows[0].t,
          }));
        } catch (e) {
          return json(res, { reply: '……我这边卡了一下。再说一遍，我在。', error: String(e.message).slice(0, 200) });
        }
      }

      // 正常一条：**立刻返回**"她多久开口"，她在后台把话写好、到点发出来（页面靠轮询收到）
      const isCall = msg.mode === 'call';
      // 通话模式（2026-10-19 用户："回的太慢，远超预期"）：换快模型 + 限长度 + 立刻开口
      const callOpts = isCall ? {
        model: config.callModel || 'glm-4-flash',
        maxTokens: 160,
      } : undefined;
      const eta = isCall ? 200 : (force.etaMs ? Number(force.etaMs) : herEta(st));
      const tail = isCall
        ? userText + '\n\n（这是电话里。**先直接接住他这句话**——他在问什么就先答什么、他在说什么就先应什么，别答非所问、别自己起一个话题。'
          + '然后一句话说完，15 字以内，别分段、别写小作文、别写括号动作。）'
        : userText;
      queueReply(c, st, tail, { etaMs: eta, isDev, force, voiceMode: !!msg.voiceMode, opts: callOpts, typingAfterMs: isCall ? 300 : 1200 });
      if (c.proactive && !isDev) resetProactiveTimer();
      return json(res, Object.assign(base, { etaMs: eta, typingAfterMs: isCall ? 300 : 1200 }));
    }

    // 转账（虚假转账气泡：记一笔 + 让她自然地接住）
    if (req.method === 'POST' && url.pathname === '/api/transfer') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || url.searchParams.get('cid') || CONTACTS[0].id);
      const amount = Math.round(Math.min(1000000, Math.max(0, Number(body.amount) || 0)) * 100) / 100;
      const note = String(body.note || '').trim().slice(0, 40);
      if (!amount) { res.writeHead(400); return res.end(JSON.stringify({ error: '金额不对' })); }
      const label = '【转账 ¥' + amount.toFixed(2) + (note ? '　' + note : '') + '】';
      console.log('[' + new Date().toISOString() + '] ' + c.id + ' 转账: ¥' + amount.toFixed(2) + ' ' + note);
      const isDev = !!body.dev;
      const st = touchState(c, '', 'transfer');   // R1：转账是"给她"的动作 → 情绪往暖处走一点
      st.mood.intimacy = Math.min(1, st.mood.intimacy + 0.05);
      st.mood.valence = Math.min(1, st.mood.valence + 0.05);
      st.mood.possess = Math.max(0, st.mood.possess - 0.03);
      saveState(c, st);
      const userEntry = appendHistory(c.id, Object.assign({
        role: 'user', type: 'transfer', amount, note, state: 'taken', text: label, t: Date.now(),
      }, isDev ? { dev: 1 } : null));
      const prompt = '（小倾刚给你转了 ¥' + amount.toFixed(2)
        + (note ? '，备注写着"' + note + '"' : '')
        + '。这不是让你道谢——用你的方式接住：收下、推回去、拿这句话打趣他都行。'
        + '20 字以内，别说"转账""功能"这种词，别写小作文。）';
      try {
        const hNow = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
        const base = (hNow >= 1 && hNow < 8) ? 1200 : 500;
        await sleep(stateDelay(st) + base + Math.random() * 1800);
        const reply = await askHer(contextMessages(c, prompt));
        const rows = writeSpeech(c, st, reply, isDev, voiceWanted(c, st, reply, !!body.voiceMode));
        if (c.proactive && !isDev) resetProactiveTimer();
        console.log('[' + new Date().toISOString() + '] ' + c.id + ' 回: ' + reply.slice(0, 60));
        return json(res, {
          ok: true, reply, amount, state: 'taken',
          parts: rows.map(e => ({ id: e.id, text: e.text, t: e.t, voice: e.voice || 0 })),
          userId: userEntry.id, userT: userEntry.t, replyId: rows[rows.length - 1].id, replyT: rows[0].t,
        });
      } catch (e) {
        console.error('transfer askHer failed:', e.message);
        return json(res, { ok: true, amount, state: 'taken',
          reply: '……我这边卡了一下（' + String(e.message).slice(0, 120) + '）。' });
      }
    }

    // ── 位置 / 拍一拍（1.2 菜单微信化 · 2026-10-19 读取文档_6）────
    // 位置：他发个地名给她 → 她接话（存 type:'loc'，页面画成微信那种位置卡片）
    if (req.method === 'POST' && url.pathname === '/api/location') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      const name = String(body.name || '').trim().slice(0, 24);
      if (!name) { res.writeHead(400); return res.end(JSON.stringify({ error: '地方没写' })); }
      const isDev = !!body.dev;
      console.log('[' + new Date().toISOString() + '] ' + c.id + ' 位置: ' + name);
      const st = touchState(c, '', 'location');
      const userEntry = appendHistory(c.id, Object.assign({
        role: 'user', type: 'loc', place: name, text: '【位置】' + name, t: Date.now(),
      }, isDev ? { dev: 1 } : null));
      const prompt = '（小倾刚给你发了个位置：' + name + '。别问"你要我来吗"这种客套——用你的方式接住：'
        + '说说这地方让你想到什么、你想不想去，或者就一句"知道了，早点回来"。'
        + '20 字以内，别说"位置""共享""定位"这种词，别写小作文。）';
      try {
        const hNow = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
        const base = (hNow >= 1 && hNow < 8) ? 1200 : 500;
        await sleep(stateDelay(st) + base + Math.random() * 1800);
        const reply = await askHer(contextMessages(c, prompt));
        const rows = writeSpeech(c, st, reply, isDev, voiceWanted(c, st, reply, !!body.voiceMode));
        if (c.proactive && !isDev) resetProactiveTimer();
        console.log('[' + new Date().toISOString() + '] ' + c.id + ' 回: ' + reply.slice(0, 60));
        return json(res, {
          ok: true, place: name, reply,
          parts: rows.map(e => ({ id: e.id, text: e.text, t: e.t, voice: e.voice || 0 })),
          userId: userEntry.id, userT: userEntry.t,
        });
      } catch (e) {
        console.error('location askHer failed:', e.message);
        return json(res, { ok: true, place: name, reply: '……嗯，看到了。' });
      }
    }

    // 拍一拍：微信那个"你拍了拍「小安」" → 她回一句（存 type:'pat'，页面画成居中灰字）
    if (req.method === 'POST' && url.pathname === '/api/pat') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      const label = '你拍了拍「' + (c.name || '她') + '」';
      const isDev = !!body.dev;
      console.log('[' + new Date().toISOString() + '] ' + c.id + ' 拍一拍');
      const st = touchState(c, '', 'pat');
      st.mood.intimacy = Math.min(1, st.mood.intimacy + 0.04);
      saveState(c, st);
      const userEntry = appendHistory(c.id, Object.assign({
        role: 'user', type: 'pat', label, text: '（小倾拍了拍你）', t: Date.now(),
      }, isDev ? { dev: 1 } : null));
      const prompt = '（小倾拍了拍你——就是微信那个"拍一拍"，不为说什么，只想碰你一下。）'
        + '用你的方式回一下：可以嗔、可以装没看见、可以只回一个表情或一个"？"。12 字以内，别解释功能。';
      try {
        const hNow = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
        const base = (hNow >= 1 && hNow < 8) ? 900 : 300;
        await sleep(stateDelay(st) + base + Math.random() * 1200);
        const reply = await askHer(contextMessages(c, prompt));
        const rows = writeSpeech(c, st, reply, isDev, voiceWanted(c, st, reply, !!body.voiceMode));
        if (c.proactive && !isDev) resetProactiveTimer();
        return json(res, {
          ok: true, label, reply,
          parts: rows.map(e => ({ id: e.id, text: e.text, t: e.t, voice: e.voice || 0 })),
          userId: userEntry.id, userT: userEntry.t,
        });
      } catch (e) {
        console.error('pat askHer failed:', e.message);
        return json(res, { ok: true, label, reply: '……你就不能好好说话。' });
      }
    }

    // ── 表情包 v2（2.4）──────────────────────────────────────
    // 册子：相册传的 ＋ 从聊天里"偷"的都进这里
    if (url.pathname === '/api/stickers') {
      let cid = url.searchParams.get('cid');
      if (req.method === 'POST') {
        try { cid = JSON.parse((await readBody(req)) || '{}').cid || cid; } catch { /* ignore */ }
      }
      const c = contactById(cid || CONTACTS[0].id);
      return json(res, { stickers: loadStickers(c.id) });
    }
    // 收进册子：data（相册上传的图）或 src（聊天里已有的图）二选一
    if (req.method === 'POST' && url.pathname === '/api/sticker-add') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      let src = String(body.src || '');
      if (!src && body.data) {
        src = saveImageData(body.data);
        if (!src) return json(res, { ok: false, error: '图没读出来' });
      }
      if (!/^\/img\/[A-Za-z0-9._-]+$/.test(src)) return json(res, { ok: false, error: '不认识的图片来源' });
      const list = loadStickers(c.id);
      if (list.some(s => s.src === src)) return json(res, { ok: true, dup: true, stickers: list });
      const item = { id: 'sk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), src, from: String(body.from || 'me'), t: Date.now() };
      list.push(item);
      saveStickers(c.id, list);
      console.log('[' + new Date().toISOString() + '] sticker + ' + src + '（共 ' + list.length + ' 张）');
      return json(res, { ok: true, item, stickers: list });
    }
    // 从册子里删掉
    if (req.method === 'POST' && url.pathname === '/api/sticker-del') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      const list = loadStickers(c.id).filter(s => s.id !== String(body.id || ''));
      saveStickers(c.id, list);
      return json(res, { ok: true, stickers: list });
    }
    // 发一张表情给她（她也会回一张）
    if (req.method === 'POST' && url.pathname === '/api/sticker-send') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      const isDev = !!body.dev;
      const item = loadStickers(c.id).find(s => s.id === String(body.id || ''));
      if (!item) return json(res, { ok: false, error: '册子里没这张' });
      const st = touchState(c, '', 'sticker');
      st.mood.intimacy = Math.min(1, st.mood.intimacy + 0.02);
      st.mood.arousal = Math.min(1, st.mood.arousal + 0.03);
      saveState(c, st);
      const userEntry = appendHistory(c.id, Object.assign(
        { role: 'user', type: 'sticker', src: item.src, text: '【小倾发来一个表情】', t: Date.now() }, isDev ? { dev: 1 } : null));
      try {
        await sleep(stateDelay(st) + 300 + Math.random() * 900);
        const prompt = '（小倾甩来一个表情包，没说话。用你的方式接住它：可以回一个表情的语气、可以打趣、可以只说一句。'
          + '要是你也想甩回一个表情，就在结尾单独写 [表情]。20 字以内。）';
        const reply = (await askHer(contextMessages(c, prompt))).trim();
        const wantSticker = /\[表情\]/.test(reply);
        const rows = writeSpeech(c, st, reply.replace(/\[表情\]/g, '').trim() || '……', isDev, false);
        let stickerRow = null;
        if (wantSticker) {
          const pick = loadStickers(c.id);
          if (pick.length) {
            const s = pick[Math.floor(Math.random() * pick.length)];
            stickerRow = appendHistory(c.id, Object.assign(
              { role: 'assistant', type: 'sticker', src: s.src, text: '【她回了个表情】', t: Date.now() + 900 }, isDev ? { dev: 1 } : null));
          }
        }
        if (c.proactive && !isDev) resetProactiveTimer();
        return json(res, {
          ok: true, src: item.src, userId: userEntry.id, userT: userEntry.t,
          reply: reply.replace(/\[表情\]/g, '').trim(),
          parts: rows.map(e => ({ id: e.id, text: e.text, t: e.t, voice: e.voice || 0 })),
          sticker: stickerRow ? { id: stickerRow.id, src: stickerRow.src, t: stickerRow.t } : null,
          replyT: rows[0].t,
        });
      } catch (e) {
        return json(res, { ok: true, src: item.src, userId: userEntry.id, error: String(e.message).slice(0, 200) });
      }
    }

    // 她收到一张照片（三期）：存下来 → 看懂它 → 用自己的方式接话
    if (req.method === 'POST' && url.pathname === '/api/image') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || CONTACTS[0].id);
      const parsed = parseImageData(body.data);
      if (!parsed) return json(res, { ok: false, error: '图没读出来' });
      if (parsed.buf.length > 12 * 1024 * 1024) return json(res, { ok: false, error: '图太大了（超过 12MB）' });
      const src = storeImage(parsed);
      if (!src) return json(res, { ok: false, error: '存不下这张图' });
      const isDev = !!body.dev;
      const st = touchState(c, '', 'image');
      st.mood.intimacy = Math.min(1, st.mood.intimacy + 0.03);   // 他发照片 = 想让她看见
      st.mood.valence = Math.min(1, st.mood.valence + 0.02);
      saveState(c, st);
      const userEntry = appendHistory(c.id, Object.assign(
        { role: 'user', type: 'image', src, text: '【发给她的照片】', t: Date.now() }, isDev ? { dev: 1 } : null));
      const desc = body.desc || await describeImage(parsed.b64, parsed.mime) || '';
      const prompt = '（小倾给你发了张照片' + (desc ? '，里面是：' + desc : '') + '。'
        + '用你的方式接：可以说你看见的、可以打趣、也可以不评照片只说想他。30 字以内，别客套。）';
      try {
        await sleep(stateDelay(st) + 400 + Math.random() * 1200);
        const reply = await askHer(contextMessages(c, prompt));
        const rows = writeSpeech(c, st, reply, isDev, voiceWanted(c, st, reply, !!body.voiceMode));
        if (c.proactive && !isDev) resetProactiveTimer();
        console.log('[' + new Date().toISOString() + '] ' + c.id + ' 看图回: ' + reply.slice(0, 60));
        return json(res, {
          ok: true, src, desc, reply, id: rows[rows.length - 1].id,
          parts: rows.map(e => ({ id: e.id, text: e.text, t: e.t, voice: e.voice || 0 })),
          userId: userEntry.id, userT: userEntry.t, replyT: rows[0].t,
        });
      } catch (e) {
        return json(res, { ok: true, src, desc, reply: '', error: String(e.message).slice(0, 200), userId: userEntry.id });
      }
    }

    // 导出（全量或选中若干条）→ 落盘 data/exports/，电脑侧用同步脚本拉回归档
    if (req.method === 'POST' && url.pathname === '/api/export') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
      const c = contactById(body.cid || url.searchParams.get('cid') || CONTACTS[0].id);
      const ids = Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : null;
      const all = loadHistory(c.id);
      const h = ids ? all.filter(e => ids.includes(String(e.id))) : all;
      if (!h.length) return json(res, { ok: false, error: '没有可导出的消息' });
      const dir = path.join(DATA, 'exports');
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      const stamp = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace(/[:T]/g, '-').slice(0, 16);
      const base = (body.dev ? 'devtest-' : 'chat-') + c.id + '-' + stamp;   // 自测导出带 devtest- 前缀，收尾一键清
      try {
        fs.writeFileSync(path.join(dir, base + '.jsonl'), h.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      } catch (e) { return json(res, { ok: false, error: '写文件失败：' + e.message }); }
      const pad = n => String(n).padStart(2, '0');
      const txt = h.map(e => {
        const d = new Date(e.t + 8 * 3600 * 1000);
        const who = e.role === 'user' ? '小倾' : (c.name || '她');
        const line = e.type === 'transfer'
          ? '[转账 ¥' + Number(e.amount || 0).toFixed(2) + (e.note ? ' ' + e.note : '') + ']'
          : String(e.text || '');
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' '
          + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + '  ' + who + '：' + line;
      }).join('\n');
      try { fs.writeFileSync(path.join(dir, base + '.txt'), txt + '\n', 'utf8'); } catch { /* ignore */ }
      console.log('[' + new Date().toISOString() + '] export ' + c.id + ': ' + h.length + ' 条 -> ' + base);
      return json(res, { ok: true, count: h.length, file: base, preview: txt.slice(-3000) });
    }

    // 导出文件清单（电脑侧同步脚本用）
    // 空灵感补偿的档位（0=关 / 3=轻 / 6=强），页面菜单读写这里
    if (url.pathname === '/api/air') {
      if (req.method === 'POST') {
        let b = {};
        try { b = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
        const g = Math.max(0, Math.min(12, Number(b.air) || 0));
        try { fs.writeFileSync(path.join(DATA, 'voice-air.json'), JSON.stringify({ air: g }), 'utf8'); }
        catch (e) { return json(res, { ok: false, error: e.message }); }
        console.log('[' + new Date().toISOString() + '] air = +' + g + 'dB');
        return json(res, { ok: true, air: g });
      }
      return json(res, { ok: true, air: airGainNow() });
    }

    // ── 电脑的嗓子（可选）：微调后的 GPT-SoVITS 跑在电脑上，手机在同一个 WiFi 里就够得着 ──
    //    够得着 → 用电脑的（快、像）；够不着 → /api/say 返回 ok:false，页面自动退回手机本地（离线兜底）
    //    失败后 3 分钟内直接跳过电脑（不然在没 WiFi 的地方每条消息都要白等 20 秒）
    let pcVoiceDownUntil = 0;
    if (url.pathname === '/api/pc-voice') {
      const pcFile = path.join(DATA, 'pc-voice.json');
      if (req.method === 'POST') {
        let body = {};
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
        const cur = (() => { try { return JSON.parse(fs.readFileSync(pcFile, 'utf8')); } catch { return {}; } })();
        const next = {
          url: String(body.url == null ? (cur.url || '') : body.url).trim().replace(/\/+$/, ''),
          refAudio: String(body.refAudio == null ? (cur.refAudio || '') : body.refAudio).trim(),
          refText: String(body.refText == null ? (cur.refText || '') : body.refText).trim(),
        };
        try {
          fs.mkdirSync(DATA, { recursive: true });
          fs.writeFileSync(pcFile, JSON.stringify(next, null, 2), 'utf8');
        } catch (e) { return json(res, { ok: false, error: '写不进配置：' + e.message }); }
        console.log('[' + new Date().toISOString() + '] pc-voice = ' + (next.url || '(关)'));
        return json(res, { ok: true, config: next });
      }
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(pcFile, 'utf8')); } catch { /* 没配置 */ }
      return json(res, { ok: true, config: cfg });
    }

    // 她的声音：在线合成（百度翻译的免费端点，无需 key）——比手机自带的朗读自然得多
    // 合成失败时返回 ok:false，页面会自动退回系统 TTS（离线兜底）
    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/say') {
      let text = url.searchParams.get('text') || '';
      let id = url.searchParams.get('id') || '';
      let engine = url.searchParams.get('engine') || (config.tts && config.tts.engine) || 'baidu';
      if (req.method === 'POST') {
        try {
          const b = JSON.parse((await readBody(req)) || '{}');
          text = b.text || text; id = b.id || id; engine = b.engine || engine;
        } catch { /* ignore */ }
      }
      text = String(text).slice(0, 500);
      if (!text.trim()) return json(res, { ok: false, error: '没有文字' });
      id = String(id || crypto.randomUUID()).replace(/[^a-zA-Z0-9\-]/g, '').slice(0, 40);
      if (!id) return json(res, { ok: false, error: '没有 id' });
      const vdir = path.join(DATA, 'voice');
      try { fs.mkdirSync(vdir, { recursive: true }); } catch { /* ignore */ }
      const vfile = path.join(vdir, id + '.mp3');
      try {
        if (fs.existsSync(vfile) && fs.statSync(vfile).size > 500) {
          return json(res, { ok: true, url: '/voice/' + id + '.mp3', cached: true, engine: engine });
        }
      } catch { /* ignore */ }
      if (engine === 'baidu') {
        const spd = (config.tts && config.tts.spd) || 5;
        const bu = 'https://fanyi.baidu.com/gettts?lan=zh&spd=' + spd + '&source=web&text=' + encodeURIComponent(text);
        try {
          const r = await fetch(bu, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://fanyi.baidu.com/' },
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < 500) throw new Error('返回空音频');
          fs.writeFileSync(vfile, buf);
          console.log('[' + new Date().toISOString() + '] say/baidu ' + id + ' ' + buf.length + 'B');
          return json(res, { ok: true, url: '/voice/' + id + '.mp3', bytes: buf.length, engine: engine });
        } catch (e) {
          console.error('say/baidu failed:', e.message);
          return json(res, { ok: false, error: 'baidu 失败：' + e.message });
        }
      }
      if (engine === 'pc') {
        if (Date.now() < pcVoiceDownUntil) return json(res, { ok: false, error: '电脑刚没够着，先用本地', down: true });
        let pcfg = {};
        try { pcfg = JSON.parse(fs.readFileSync(path.join(DATA, 'pc-voice.json'), 'utf8')); } catch { /* 没配置 */ }
        if (!pcfg.url) return json(res, { ok: false, error: '还没配电脑的地址' });
        const wfile = path.join(vdir, id + '.wav');
        try {
          if (fs.existsSync(wfile) && fs.statSync(wfile).size > 1000) {
            return json(res, { ok: true, url: '/voice/' + id + '.wav', cached: true, engine: 'pc' });
          }
        } catch { /* ignore */ }
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 20000);   // 电脑热着 5 秒、冷启动约 15 秒；超了就退回本地
        try {
          const r = await fetch(pcfg.url + '/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: text, text_lang: 'zh',
              ref_audio_path: pcfg.refAudio || '', prompt_text: pcfg.refText || '', prompt_lang: 'zh',
              text_split_method: 'cut5', batch_size: 1, speed_factor: 1.0, seed: 7,   // 种子 7：实测能保住她的"一口气分两段"（42/99 会把整句并成一段）
              temperature: 1.3,                                                        // 温 1.3：把句内语速起伏做到 0.129（真人 0.128）
              media_type: 'wav', streaming_mode: false, sample_steps: 32, fragment_interval: 0.1,
            }),
            signal: ctl.signal,
          });
          clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < 1000 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('返回的不是 wav');
          fs.writeFileSync(wfile, buf);
          console.log('[' + new Date().toISOString() + '] say/pc ' + id + ' ' + buf.length + 'B');
          return json(res, { ok: true, url: '/voice/' + id + '.wav', bytes: buf.length, engine: 'pc' });
        } catch (e) {
          clearTimeout(timer);
          pcVoiceDownUntil = Date.now() + 3 * 60 * 1000;   // 记 3 分钟，这段时间直接走本地
          console.error('say/pc failed:', e.message);
          return json(res, { ok: false, error: '电脑够不着：' + (e.name === 'AbortError' ? '超时' : e.message) });
        }
      }
      return json(res, { ok: false, error: '未知引擎 ' + engine });
    }

    if (req.method === 'GET' && url.pathname === '/api/exports') {
      const dir = path.join(DATA, 'exports');
      let names = [];
      try { names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort(); } catch { /* none */ }
      return json(res, { files: names });
    }

    if (req.method === 'GET' && url.pathname === '/api/export-file') {
      const name = path.basename(url.searchParams.get('name') || '');
      const file = path.join(DATA, 'exports', name);
      if (!name || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error('request error:', e);
    try { res.writeHead(500); res.end('server error'); } catch { /* ignore */ }
  }
});

// 只监听本机回环：WebView 走 127.0.0.1，电脑侧走 adb forward，都不需要对外。
// （监听 0.0.0.0 时，同一个 WiFi 下任何人扫到 <手机IP>:3083 就能直接读走全部聊天记录——
//  密码门只锁了页面，API 层本来没有认证）
server.listen(PORT, '127.0.0.1', () => {
  console.log('安倾在 http://127.0.0.1:' + PORT + ' 住下了（' + CONTACTS.map(c => c.name).join('、') + '）');
});
