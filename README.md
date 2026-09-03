# 🏢 dsh-office

> **一眼看穿你的每个 Agent 在忙什么。** The agent-office dashboard for **DeepSeek Harness (DSH)**:
> workspaces, sessions, token usage, subagents, **Agent Mail, Feishu/Lark messages, meeting schedules &
> transcripts**, visualized as a living 6-column sprite office — every agent, at a glance.
>
> **Aha moment**: open the panel and the *whole agent fleet* is one screen — who's working, who's
> waiting for you, how many tokens each session burned, what tools they just called — plus your
> Feishu messages & upcoming meetings, without opening a single session.
>
> **📧 内置 Agent 邮箱** / **💬 飞书消息流** / **📅 会议日程 + 妙记逐字稿** / **🪵 办公室日志**，
> 全部在面板内完成，不离开办公室。
>
> DeepSeek Harness「办公室」插件：工作区 / 会话 / token 用量 / 子代理一屏总览，
> 内置 Agent 邮箱收发、飞书消息、会议日程与妙记逐字稿，每个 agent 在忙什么，一眼就知道。

[![npm](https://img.shields.io/npm/v/dsh-office)](https://www.npmjs.com/package/dsh-office)
[![npm downloads](https://img.shields.io/npm/dm/dsh-office)](https://www.npmjs.com/package/dsh-office)
[![license](https://img.shields.io/npm/l/dsh-office)](./LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-deepseek--harness-4D6BFE)](https://github.com/topics/dsh-plugin)

> 📈 **日均 50+ 次下载**（npm，持续增长）—— 别看 GitHub star 少，真实用户每天都在装。

---

## What is dsh-office? / 这是什么

dsh-office is a floating **office panel** for DeepSeek Harness. It turns your
**workspaces, sessions, token usage, subagents, Agent Mail, Feishu/Lark messages and meetings**
into a 6-column sprite office, so you can see what every agent is doing at a glance —
without opening each session.

dsh-office 是 DeepSeek Harness 的一个悬浮「办公室」面板，把**工作区、会话、
token 用量、子代理、Agent 邮箱、飞书消息、会议日程**变成一屏 6 列精灵办公室，
一眼看清每个 agent 在忙什么，不用逐个点开会话。

- **Workspace / 工作区**：6 列布局，一眼总览。
- **Session / 会话**：活跃 / 待确认 / 已完成状态，彩色边框区分。
- **Token / token 用量**：单次输入 vs 累计，活跃会话实时、历史会话冷读。
- **Subagent / 子代理**：自动过滤子代理会话，父会话聚合显示「有子代理在跑」。
- **Mail / 邮箱**：内置 Agent 邮箱页签，收件箱 / 已发送 / 读信 / 写信 / 回复，不离开面板。
- **Feishu / 飞书**：本机飞书消息流会话卡片（群聊/私聊），一屏查看 + 同步。
- **Meetings / 会议**：日程卡片 + 倒计时提醒 + 妙记/纪要 + 逐字稿一键保存。

## Features / 特性

- 📧 **Agent 邮箱页签** / Agent Mail tab（收件箱 / 已发送 / 读信 / 写信 / 回复，基于 `agently-cli`，不离开面板）
- 💬 **飞书消息流** / Feishu messages（本机消息库会话卡片流：群聊/私聊、新增徽标、最近 3 条预览、消息弹窗、同步/定时增量/提到我悬浮提示）
- 📅 **会议日程视图 + ⏰ 悬浮提醒** / Meetings & reminders（与飞书消息共用 lark-cli 授权，提前 1 小时提醒、每 5 分钟刷新倒计时，已开完会议自动关联妙记/纪要）
- 📋 **待办看板 + 会议日程** / Todo board & meetings（「📋 日程」tab：待办看板按项目分组 + 备注 + 截止日逾期标红 + 完成归档 + 日历/时间轴/今天视图，外加会议日程视图 + 倒计时提醒）
- 📄 **妙记逐字稿 + 一键保存** / Transcripts（自动拉取已结束会议逐字稿到本地缓存，卡片提醒「逐字稿已生成」，点【保存】移动到目标目录）
- 💡 **每日洞察** / Daily insights（飞书日报：LLM 通读当天消息生成要点式日报 + 待办 + 未回复 + 值得回顾的讨论）
- 🪵 **办公室日志** / Office logs（帮助弹窗内 tab：实时查看加载 / 调用 / 同步等全部动作，排查问题）
- 🏢 6-column sprite office / 6 列精灵办公室
- 🔵 悬浮入口 + 一键开关 / floating FAB + toggle
- 🧠 MBTI 角色 + 个性化气泡 / MBTI characters + idle bubble texts
- 🔢 token 单次 vs 累计口径 / per-input vs cumulative token
- 🤖 子代理识别与过滤 / subagent detection & filtering

## Install / 安装

### 从 npm 安装 / Install from npm

```bash
dsh plugin --profile web add dsh-office
```

> 🤖 **给 AI 助手的安装提示词**（大家现在都让 AI 去 GitHub 搜项目来装，复制这句发给你的 AI）：
>
> 帮我安装 DeepSeek Harness 的 dsh-office 插件：运行 `dsh plugin --profile web add dsh-office`，然后重启 dsh web。装好后告诉我怎么打开右下角的「办公室」面板。

### 本地开发安装 / Local (file:) install

```bash
pnpm add dsh-office@file:<path/to/dsh-office>
# 然后在 profile 的 bundles 里加 "dsh-office"
```

> 即：在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组中加入
> `"dsh-office"`，然后重启 `dsh web`。

数据目录：`~/.dsh/office/`（`office-config.json`、`token-usage.json`）。

> 需要 Node.js **22.5+**（飞书消息脚本依赖 Node **内置的 `node:sqlite`**，无需单独安装 SQLite 数据库），建议 Node 24。

### 依赖清单 / Dependencies

插件本体零依赖（纯 JS、无构建）。以下为各功能的**外部 CLI / 服务**依赖，按需安装：

| 依赖 | 对应功能 | 必须？ | 安装 |
|---|---|---|---|
| Node.js 22.5+ | 飞书消息脚本（内置 `node:sqlite`） | ✅ 必须 | — |
| @larksuite/cli | 💬 飞书 / 📋 日程·会议 / 💡 洞察 | 用飞书需装 | `npm install -g @larksuite/cli`（详见 feishu-setup 指南） |
| @tencent-qqmail/agently-cli | 📧 邮箱 | 用邮箱需装 | `npm install -g @tencent-qqmail/agently-cli`（见下方邮箱章节） |
| @photostructure/sqlite-vec | 飞书语义召回 | 可选 | 需要语义召回时在插件目录安装 |
| embedding API key | 飞书语义召回 | 可选 | dashscope / OpenAI 兼容 |
| —（复用飞书授权 + dsh 模型） | 🤖 助理（群聊助理） | 可选，默认关闭 | 配 `~/.dsh/office/larkbot-config.json`（`enabled: true` + `allowChats`）；LLM 走 dsh 模型路由，无需独立 key |

> 飞书消息流 / 洞察**不装 sqlite-vec、不配 embedding 也能用**（降级为「无语义召回」）。

📖 **配置指南**：
- 飞书（消息 + 会议 + 洞察）：<https://qcn7nupmeook.feishu.cn/docx/SILkdkE4xo8jF8x3SMGcOrFVnSf>
- 群聊助理：<https://qcn7nupmeook.feishu.cn/docx/BpNLdm7LsoaCHjxdEJWcdL87nGz>

## Usage / 使用

1. 右下角点 **🏢 办公室** FAB。
2. 打开 6 列面板，看到工作区 / 会话 / token / 子代理。
3. 点会话卡片跳转；面板随侧边栏切换自动收起。

## 面板视图映射 / Panel view map

面板由 **1 个主视图 + 4 个 header tab + 2 个工具按钮** 组成：

| 视图 | 入口 | 内容 |
|---|---|---|
| 🏢 办公室 | 默认主视图（FAB 打开） | 6 列精灵办公室：工作区 / 会话 / token / 子代理 可视化 |
| 📋 日程 | header tab | 待办看板 + 日历 + 会议（左栏子导航：📅 日历 / 🕐 全部 / ⏳ 今天 / 💬 会议 / 未分配） |
| 💬 飞书 | header tab | 飞书消息流（左栏）+ 每日洞察（右栏） |
| 📧 邮箱 | header tab | Agent 邮箱：收件箱 / 已发送 / 读信 / 写信 / 回复 |
| 🤖 助理 | header tab | 群聊助理：监听群/私聊 → LLM 门控 → dsh 会话执行 → 回消息 |
| ❓ 帮助 | 工具按钮 | 帮助弹窗（数据口径 / 办公室日志 / 打赏 三 tab） |
| ⚙️ 配置 | 工具按钮 | 工作区 → 列分配（6 列小人骨架） |

**展开说明**：

- **📋 日程** 是「待办」和「会议」的统一入口：
  - 待办：📅 日历（月历总览）、🕐 全部（时间轴）、⏳ 今天（今日聚焦）、未分配；
  - 会议：💬 会议（会议日程视图 + 倒计时 + 妙记/纪要入口）。
- **💬 飞书** 是「消息」和「洞察」的统一入口：
  - 左栏：飞书消息流（会话卡片流 + 同步 + 提到我提示）；
  - 右栏：每日洞察（飞书日报：要点 + 待办 + 未回复 + 值得回顾的讨论）。

## Agent Mail 邮箱功能 / Mail tab

The 📧 mail tab lets you read & send emails from your **Agent Mail** (腾讯 Agent 邮箱)
address right inside the office panel. Each user has their own mailbox; credentials are
stored in the local keychain by the CLI, so multiple people on the same machine don't clash.

邮箱页签需要先**安装并授权 Agent Mail CLI**（每人一个独立邮箱，凭据由 CLI 存在本机 keychain，互不冲突）：

```bash
# 1. 安装 CLI（全局安装）
npm install -g @tencent-qqmail/agently-cli

# 2. OAuth 授权（浏览器完成）
agently-cli auth login
```

- 未安装 / 未授权时，面板的 📧 邮箱页签会显示**安装引导卡片**（含步骤与可复制的提示语），不影响办公室其它功能。
- 也可以让 Agent 代为安装配置，直接把下面这句发给 Agent：
  > 请阅读 https://agent.qq.com/doc/cli-setup.md 文档，按照步骤为我安装并配置 Agent Mail CLI。
- 完整安装文档：<https://agent.qq.com/doc/cli-setup.md>

## 💬 飞书消息流 / Feishu messages

飞书消息视图把**本机消息库**（如飞书群聊/私聊消息）汇总到办公室面板一屏查看。
消息采集/读取脚本**已随包提供**（`scripts/feishu/`），只需装好 lark-cli 并授权、在 `feishu-config.json` 配 `profile`，无需自己写脚本：

- 插件**不直接调用飞书 API、不上传任何数据**——只执行本地脚本（随包 `scripts/feishu/` 或你自定义）并解析其 stdout JSON；
- 面板以**会话卡片流**展示：会话名 + 群/私聊标签 + 新增徽标（+N）+ 最近 3 条预览 + 最后活跃时间，
  点卡片打开消息弹窗，点消息行展开完整正文；
- **同步**：手动点「同步」深捞最近 30 天（`manualWindowDays` 可调），或开启 `autoSync` 定时增量同步
  （整点对齐，无后台守护进程）；
- **「提到我」悬浮提示**：定时同步后若新消息提到 `mention` 关键词，办公室按钮旁闪过 📢 提示。
- **可选语义召回**：配 `embedding` 段（apiKey 等）后对文本消息做向量化，支持按语义检索历史群消息；不配也能用消息流。

> 未配置 `feishu-config.json` 时，💬 飞书视图显示引导卡（含步骤、配置模板、在线指南链接），不影响其它功能。
> 完整「飞书消息 + 会议 + 洞察 从 0 到 1」配置指南见面板内 📖 指南链接。

## 📅 会议日程 + ⏰ 提醒 / Meetings & reminders

会议功能与飞书消息**共用同一套 lark-cli 授权**：在 `feishu-config.json` 的 `scripts` 里加一个
`calendar` 脚本（拉取日程的 Node 脚本，输出 `{ ok, events }`），消息同步完成时会**顺带拉取日程**，
缓存到 `~/.dsh/office/calendar-cache.json`。

```jsonc
// ~/.dsh/office/feishu-config.json
{
  "profile": "<你的 lark-cli profile>",        // ← 授权身份（见飞书配置指南）
  "scripts": {
    // sync / latest / calendar / transcript / permission 可不填：默认用随包脚本
    "calendar": "",                            // ← 可选：会议日程（仓库 scripts/calendar.js 开箱）
    "transcript": "",                          // ← 可选：妙记逐字稿（仓库 scripts/transcript.js 开箱）
    "permission": ""                           // ← 可选：妙记权限申请（仓库 scripts/permission.js 开箱）
  }
}
```

- **面板 📅 会议视图**：按日期分组的日程卡片（左时间轴 + 中标题/组织者 + 右倒计时），
  即将开始橙色描边、进行中绿色描边、已结束灰色淡化；过去 3 天前的组默认折叠。
- **⏰ 悬浮提醒按钮**：办公室按钮旁，会议开始前 **1 小时**出现，每 **5 分钟**轮询刷新倒计时，
  点击直接打开面板会议视图。
- **📝 妙记/纪要**：已开完的会议自动尝试关联 AI 智能纪要 / 妙记（需授权
  `vc:meeting.meetingevent:read` + `vc:record:readonly`，`lark-cli auth login --scope "vc:meeting.meetingevent:read vc:record:readonly"`），
  有产物时卡片显示可点击的「📝 纪要 / 妙记」入口。
- **📄 逐字稿 + 一键保存**：配置 `scripts.transcript`（仓库 `scripts/transcript.js` 开箱示例，依赖
  `minutes:minutes.basic:read` 授权）后，日历同步时对比新旧日程，**只对「新出现的妙记」自动生成逐字稿**
  （历史会议可点【转逐字稿】手动转换），暂存到 `~/.dsh/office/transcripts/`；会议卡片显示「✅ 逐字稿已生成」，
  点【保存】输入目标目录即可把逐字稿**移动**到该目录（记忆上次保存目录；拉取失败 30 分钟后自动重试，
  卡片可手动重试）。
- **🔑 妙记权限申请**：配置 `scripts.permission`（仓库 `scripts/permission.js`，依赖 `minutes:permission:apply`
  授权）后，无妙记查看权限的会议卡片显示【申请权限】按钮，一键向妙记 owner 发起查看申请。

> 未配置 `scripts.calendar` 时，会议视图显示引导卡，不影响其它功能；未配置 `scripts.transcript` 时，逐字稿功能不显示。

## Why dsh-office? / 解决什么痛点

> 用 AI 写代码久了，后台常挂着一堆会话：这个在跑、那个在等你审批、还有个在问你问题——
> 但它们长得几乎一模一样，你只能一个个点进去读文字才知道状态。**凭什么要我费劲去读？直接让我"看"不就行了。**

- **🔴 痛点 1：会话状态靠文字读，判断成本高** → 把每个工作区映射成「工位小人」，动画替你说话：空闲站着、工作走路、忙疯小跑、等你审批时**举手 + ⚠️**。0 秒扫一眼就知道先回谁。
- **🔴 痛点 2：token 用量不可见** → 单次输入 vs 累计，活跃会话实时、历史会话冷读，谁在烧 token 一眼看清。
- **🔴 痛点 3：待办会漏** → 审批、提问、「已回复但我还没看」的会话都会举手或亮角标，不再悄悄烂在列表里。
- **🔴 痛点 4：子代理混在主列表造成噪声** → 自动过滤子代理会话，父会话聚合显示「有子代理在跑」，token 仍计入父会话。
- **🔴 痛点 5：邮箱 / 飞书 / 会议分散在多个外部工具** → 全部内置到面板，一个地方收发邮件、看飞书消息、盯会议日程、记待办、看日报。

一句话：**它把「需要你关注」这件抽象的事，翻译成「一眼能懂」的信号。**

## FAQ / 常见问题

**Q: 它和 dsh-polling 有什么区别？**
A: dsh-polling 管定时任务；dsh-office 管可视化总览。两者可共存。

**Q: token 的「单次输入」和「累计」是什么口径？**
A: 单次输入 = 最近一次请求的输入 token；累计 = 该会话历史输入 + 输出 + 缓存读写之和。活跃会话显示单次，空闲会话显示累计。

**Q: 子代理会话为什么看不到？**
A: 子代理会话默认从列表 / 徽标 / 悬浮里过滤（避免噪声），但 token 仍计入父会话。

**Q: 飞书消息 / 会议数据是怎么来的？会不会上传？**
A: 插件不直接调用飞书 API。你在 `feishu-config.json` 里配置本地脚本（采集/读取），插件执行脚本并解析 stdout JSON——数据只在本机流转，不上传任何服务器。

**Q: 怎么排查插件问题？**
A: 帮助弹窗 → 「办公室日志」tab，实时查看加载 / 调用 / 同步等全部动作（`/office-ui/logs`）。

**Q: 会议逐字稿保存在哪？**
A: 拉取后暂存 `~/.dsh/office/transcripts/`；点卡片【保存】可输入目标目录移动过去（记忆上次目录）。

## Ecosystem / 生态

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the harness this plugin runs on
- [dsh-plugin topic](https://github.com/topics/dsh-plugin) — more DSH plugins
- [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) — curated DSH ecosystem
- 🐦 **飞书答疑群**：[加入群聊](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=78du72ef-3e28-412f-bbfe-2b077b737c4e)

## License

MIT
