# 安倾 · AnQing

**简体中文** | [English](README.en.md)

> 一个**完全离线**的安卓 AI 陪伴 App：对话、语音合成、语音识别全部跑在**手机本地**。
> 没有云、没有账号、没有服务器——拔掉数据线、关掉电脑，她照样在。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Android%20(arm64)-3ddc84.svg)](#)
[![Offline](https://img.shields.io/badge/runs-100%25%20offline-blue.svg)](#)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#)

<p align="center">
  <img src="docs/demo.gif" width="290" alt="演示：联系人 → 聊天" />
</p>

<p align="center">
  <img src="docs/screenshot-chat.png" width="250" alt="聊天界面" />
  <img src="docs/screenshot-call.png" width="250" alt="通话界面" />
  <img src="docs/screenshot-list.png" width="250" alt="联系人界面" />
</p>

<p align="center"><sub>截图使用仓库自带的 demo 数据（全部虚构），不含任何真实用户数据。</sub></p>

---

## 它和别的不一样在哪

| | 云端聊天 App | 服务器 Bot（QQ/Discord） | **安倾** |
|---|---|---|---|
| 模型跑在哪 | 云 | 你的服务器 | **手机本地** |
| 断网能用吗 | ❌ | ❌ | **✅** |
| 聊天记录在哪 | 厂商服务器 | 第三方平台 | **只在你手机里** |
| 要账号/服务器吗 | 要 | 要 | **都不要** |

有意思的是**怎么做到的**：**Node 运行时被塞进了 App 进程里**
（nodejs-mobile 的 `libnode.so` + 手写 JNI 胶水），所以引擎不是远程服务——
它随 App 启动和退出，在 `127.0.0.1:3083` 上提供服务，WebView 页面加载它。

---

## 它能做什么

- **人格 + 三层记忆**：事实 / 事件 / 关系分开存，**按话题召回**，而不是每轮把整本记忆灌给模型。
- **情绪状态机**：六维（心情、精力、亲密、占有、兴致、激动），会随时间衰减、被你说的话推动，
  并且**真的影响**她的措辞、句长、回复节奏、发文字还是发语音。
- **像人一样的聊天节奏**：先标"已读"，回 2~3 条气泡而不是一大段，偶尔三十秒才回，偶尔"走神"。
- **她会主动找你**：带着由头（几点、天气）来找，不是固定时间群发。
- **全本地语音**：按住说话 → 本地离线识别（SenseVoice）→ 她回语音条（本地神经 TTS，ZipVoice 零样本克隆）。
- **通话页**：振铃 → 接通 → 计时 / 静音 / 挂断，挂断后聊天里留一条通话记录。
- **微信式细节**：多条气泡、转账卡片、表情包、发照片、长按菜单、多选导出/删除。
- **多角色架构**：`contacts` ＋ 每人独立的 `her/<id>/` 人格包 ＋ 独立聊天历史。
  开箱一个角色，架构留给后续版本扩展。

---

## 架构

```
Android App (Java)
├── MainActivity        原生密码门 + WebView
├── XiaoanService       前台服务：释放资产 → 启动 Node → 看护重启 → 消息通知
├── Engine              assets/engine/** → filesDir/engine/**（代码每次覆盖，data/ 只在缺失时播种）
├── Voice / SherpaTts   本地 TTS（sherpa-onnx + ZipVoice）
├── VoiceInput          本地 ASR（sherpa-onnx + SenseVoice）
├── SherpaAsr / AecProbe
└── node_shim.cpp       JNI 胶水 → libnode.so（nodejs-mobile 18.x）

Node 引擎 (server.js)
└── HTTP 服务 127.0.0.1:3083 —— 聊天 / 历史 / 记忆 / 情绪 / 语音 / 图片 / 状态

WebView 页面 (web/index.html)
└── 单页应用：联系人 · 聊天 · 通话 · 设置
```

**不需要 Gradle**：`aapt2 → javac → d8 → aapt add → zipalign → apksigner`，全流程脚本化在 `scripts/`，
没有 Android Studio 也能复现构建。

---

## 快速开始

```bash
git clone https://github.com/moqing86/AnQing.git
cd AnQing

# 1) 配置（模型 key 填你自己的；仓库里只有占位符）
cp config.example.json config.json

# 2) 准备模型（体积大，不进仓库，见下节），放到 assets/tts 与 assets/asr
# 3) 打包
powershell -File scripts/prepare-app-assets.ps1
powershell -File scripts/build-apk.ps1
```

### ⚠️ 首次运行必做：改掉默认密码

App 有两把锁，用的是**同一个密码的 SHA-256**：

| 锁 | 位置 | 默认值 |
|---|---|---|
| 原生锁（冷启动要输） | `app/src/com/xiaoan/app/MainActivity.java` 的 `PW_HASH` | **`anqing2026`** |
| 页面锁（浏览器 → `127.0.0.1:3083`） | `config.json` 的 `passwordHash` | 同上 |

一行命令同时改两处，然后重新打包：

```powershell
powershell -File scripts/set-password.ps1 -Password "你自己的密码"
powershell -File scripts/prepare-app-assets.ps1
powershell -File scripts/build-apk.ps1
```

> 别把默认密码带上真机——它是公开的。

### 模型从哪来（不在本仓库）

| 用途 | 模型 | 来源 |
|---|---|---|
| TTS | sherpa-onnx + ZipVoice（中英） | sherpa-onnx 官方 release（含现成 AAR 与 ONNX 模型） |
| ASR | sherpa-onnx + SenseVoice | 同上 / ModelScope |
| Node 运行时 | nodejs-mobile 18.x `libnode.so` | nodejs-mobile 仓库 |

体积参考：`tts.zip` ≈ 148 MB、`asr.zip` ≈ 157 MB、`libnode.so` ≈ 60 MB —— 所以**不进 Git**。

---

## 隐私

- 没有账号、没有云同步、没有埋点。聊天、记忆、人格文件都在 App 私有目录，卸载即清。
- 文本与音频**默认不出本机**（除非你自己把 `config.json` 指向远程模型服务）。
- 仓库里只有 `config.example.json` 占位符，**没有任何真实密钥**。

---

## 路线图（在持续开发）

- [x] Node 引擎内嵌 + 无 Gradle 构建链
- [x] 人格 / 三层记忆 / 情绪状态机 / 主动消息
- [x] 本地 TTS + 本地 ASR + 通话页
- [ ] **真全双工通话**（她说话时你能插话）+ 回声消除探针
- [ ] 菜单"微信化"整理（聊天动作与设置分离）
- [ ] 多角色界面（列表人多时的排版与搜索）
- [ ] 语音首句延迟优化（已做短语预合成）
- [ ] 桌面端（同一套引擎，搬出手机）

> 项目仍在持续开发中，欢迎 Issue / PR。

---

## 已知限制

- 部分 ROM（如 ColorOS）会冻结后台；本项目用前台服务 + 静音保活缓解，但不保证 100% 常驻。
- 本地 TTS 首句合成偏慢（参考音频编码开销），正式版用"预合成短语"顶住。
- 语音克隆需要你自备**有权使用**的参考音频——**不要**拿他人作品训练或分发。
- 只测过 `arm64-v8a`。

---

## 许可

[MIT](LICENSE) © 2026 Mo

## 参与贡献

欢迎 Issue / PR —— 构建与自测方法、隐私红线（不要提交真实聊天记录、密钥、语音样本）见
[CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请先看 [SECURITY.md](SECURITY.md) 并通过私密渠道报告。

## 致谢

[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) · [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) ·
ZipVoice · SenseVoice —— 以及背后所有的开源模型作者。

---

<p align="center"><sub>如果这个项目给了你一点灵感，欢迎点个 ⭐</sub></p>
