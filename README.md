# 安倾 AnQing

**An offline, on-device AI companion that lives inside an Android app.**
No cloud, no account, no server — the LLM chat, text-to-speech and speech-to-text all run on the phone itself.
Pull the USB cable, shut down your PC, and she still works.

> 一个**完全离线**的 AI 陪伴 App：对话、语音合成、语音识别全在手机本地跑。
> 拔掉数据线、关掉电脑，照样能用。

<p align="center">
  <em>「她住在你手机里，不在云上。」</em>
</p>

---

## ✨ Why it's different

| | 云端聊天 App | 服务器 Bot（QQ/微信） | **AnQing** |
|---|---|---|---|
| 模型跑在哪 | 云 | 服务器 | **手机本地** |
| 断网能用吗 | ❌ | ❌ | **✅** |
| 聊天记录去哪 | 厂商服务器 | 第三方平台 | **只在你手机里** |
| 要账号/服务器吗 | 要 | 要 | **都不要** |

这是"端侧 AI 陪伴"的一个完整实现：**Node 运行时被塞进 App 进程里**（nodejs-mobile 的 `libnode.so` + 自编 JNI 胶水），
所以引擎不是远程服务，而是**随 App 一起启动的本机服务**（`127.0.0.1:3083`），页面用 WebView 打开它。

---

## 🧠 它能做什么（不是套壳聊天）

- **人格与三层记忆**：事实 / 事件 / 关系分层存储，**按话题召回**（不是每轮把整本记忆灌给模型）
- **情绪状态机**：六维情绪（心情、精力、亲密、占有、兴致、激动），会随时间衰减、被你说的话推动，
  并且**真的影响**她的语气、句长、回得多快、要不要发语音
- **像人一样的聊天节奏**：先"已读"，几秒到几十秒后补正文；一次回 2~3 条而不是一大段；偶尔走神
- **她会主动找你**：结合当前时间与天气找由头，而不是定时群发
- **语音**：按住说话 → 本地离线识别（SenseVoice）→ 她回语音条（本地神经 TTS，ZipVoice 零样本克隆）
- **通话页**：振铃 / 接通 / 计时 / 静音 / 挂断，挂断后聊天里留一条通话记录
- **微信式交互细节**：多条气泡、转账气泡、表情包、发图片、长按菜单、多选导出删除
- **多角色架构**：`contacts` ＋ 每人独立的 `her/<id>/` 人格三件套 ＋ 独立聊天历史（开箱只有一个角色，
  架构上可扩展——这正是留给后续版本的地方）

---

## 🏗 架构

```
Android App (Java)
├── MainActivity        原生密码锁 + WebView
├── XiaoanService       前台服务：释放资产 → 启动 Node → 看护重启 → 消息通知
├── Engine              assets/engine/** → filesDir/engine/**（代码每次覆盖，data/ 只在缺失时播种）
├── Voice / SherpaTts   本地 TTS（sherpa-onnx + ZipVoice）
├── VoiceInput          本地 ASR（sherpa-onnx + SenseVoice）
├── SherpaAsr / AecProbe
└── node_shim.cpp       JNI 胶水 → libnode.so（nodejs-mobile 18.x）

Node 引擎 (server.js)
└── HTTP 服务 127.0.0.1:3083 —— 聊天 / 历史 / 记忆 / 情绪 / 语音 / 图片 / 状态

WebView 页面 (web/index.html)
└── 单页应用：联系人列表 / 聊天 / 通话 / 设置
```

**构建不用 Gradle**：`aapt2 → javac → d8 → aapt add → zipalign → apksigner` 全流程脚本化（见 `scripts/`），
没有 Android Studio 也能复现构建。

---

## 🚀 快速开始

```bash
git clone https://github.com/moqing86/AnQing.git
cd AnQing

# 1) 配置（模型服务的 key 填这里；仓库里只有占位符）
cp config.example.json config.json
#   然后编辑 config.json，把 "apiKey" 换成你自己的

# 2) 准备模型（体积大，自己下，见下节）放进 assets/tts 与 assets/asr
# 3) 打包
powershell -File scripts/prepare-app-assets.ps1
powershell -File scripts/build-apk.ps1
```

### ⚠️ 首次运行必做：改掉默认密码

App 有两把锁，用的是**同一个密码的 sha256**：

| 锁 | 位置 | 默认值 |
|---|---|---|
| 原生锁（冷启动要输） | `app/src/com/xiaoan/app/MainActivity.java` 的 `PW_HASH` | **`anqing2026`** |
| 页面锁（浏览器直开 3083） | `config.json` 的 `passwordHash` | 同上 |

一行命令同时改两处，然后重新打包：

```powershell
powershell -File scripts/set-password.ps1 -Password "你自己的密码"
powershell -File scripts/prepare-app-assets.ps1
powershell -File scripts/build-apk.ps1
```

> 别用默认密码就上真机——那是公开的。

### 模型从哪来（不入库）

| 用途 | 模型 | 来源 |
|---|---|---|
| TTS | sherpa-onnx + ZipVoice（中英） | sherpa-onnx 官方 release（含现成 AAR）与 ONNX 模型 |
| ASR | sherpa-onnx + SenseVoice | 同上，或 ModelScope |
| Node 运行时 | nodejs-mobile 18.x `libnode.so` | nodejs-mobile 仓库 |

体积参考：`tts.zip` ≈ 148 MB、`asr.zip` ≈ 157 MB、`libnode.so` ≈ 60 MB —— 所以**不进 Git**。

---

## 🔒 隐私

- **没有账号、没有云同步、没有埋点**；聊天记录、记忆、性格文件都在 App 私有目录，卸载即清
- 文本与语音默认**不出本机**（除非你自己把 `config.json` 的模型地址配成远程服务）
- 仓库里只有 `config.example.json` 占位符，**不含任何真实密钥**

---

## 🧭 路线图（会持续更新）

- [x] 本地 Node 引擎内嵌 + 无 Gradle 构建链
- [x] 人格 / 三层记忆 / 情绪状态机 / 主动消息
- [x] 本地 TTS + 本地 ASR + 通话页
- [ ] **真全双工通话**（她说的时候你也能插话）+ 回声消除探针
- [ ] 菜单"微信化"整理（设置项与聊天功能分离）
- [ ] 多角色界面（列表人多时的排版/搜索）
- [ ] 语音合成的首句延迟优化（预合成短语已就绪）
- [ ] 桌面端（把同一套引擎搬出手机）

> 这个项目还在持续开发里，欢迎 Issue / PR 提需求。

---

## ⚠️ 已知限制

- 部分 ROM（如 ColorOS）会冻结后台；本项目用前台服务 + 静音保活缓解，但不是 100% 常驻
- 本地 TTS 首句合成偏慢（参考音频编码开销），正式版会用"预合成短句"顶住
- 语音克隆需要你自备**有权使用**的参考音频；**不要**用他人作品训练或分发
- 只测过 arm64-v8a 单 ABI

---

## 📄 License

[MIT](LICENSE) © 2026 Mo

## 🙏 致谢

[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) · [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) ·
ZipVoice · SenseVoice · 以及所有开源模型作者。

---

<p align="center"><sub>如果这个项目给了你一点灵感，欢迎点个 ⭐ </sub></p>
