# 🏢 dsh-office

> **一眼看穿你的每个 Agent 在忙什么。** The agent-office dashboard for **DeepSeek Harness (DSH)**:
> workspaces, sessions, token usage and subagents, visualized as a living 6-column sprite office —
> every agent, at a glance.
>
> **📧 内置 Agent 邮箱**：收件箱 / 读信 / 写信 / 回复，不离开面板直接收发。
> Built-in **Agent Mail** — read, send & reply to email right inside the panel.
>
> DeepSeek Harness「办公室」插件：工作区 / 会话 / token 用量 / 子代理一屏总览，
> 内置 Agent 邮箱收发，每个 agent 在忙什么，一眼就知道。

[![npm](https://img.shields.io/npm/v/dsh-office)](https://www.npmjs.com/package/dsh-office)
[![npm downloads](https://img.shields.io/npm/dm/dsh-office)](https://www.npmjs.com/package/dsh-office)
[![license](https://img.shields.io/npm/l/dsh-office)](./LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-deepseek--harness-4D6BFE)](https://github.com/topics/dsh-plugin)

---

## What is dsh-office? / 这是什么

dsh-office is a floating **office panel** for DeepSeek Harness. It turns your
**workspaces, sessions, token usage, subagents and Agent Mail** into a 6-column sprite office,
so you can see what every agent is doing at a glance — without opening each session.

dsh-office 是 DeepSeek Harness 的一个悬浮「办公室」面板，把**工作区、会话、
token 用量、子代理、Agent 邮箱**变成一屏 6 列精灵办公室，一眼看清每个 agent
在忙什么，不用逐个点开会话。

- **Workspace / 工作区**：6 列布局，一眼总览。
- **Session / 会话**：活跃 / 待确认 / 已完成状态，彩色边框区分。
- **Token / token 用量**：单次输入 vs 累计，活跃会话实时、历史会话冷读。
- **Subagent / 子代理**：自动过滤子代理会话，父会话聚合显示「有子代理在跑」。
- **Mail / 邮箱**：内置 Agent 邮箱页签，收件箱 / 已发送 / 读信 / 写信 / 回复，不离开面板。

## Features / 特性

- 📧 **Agent 邮箱页签** / Agent Mail tab（收件箱 / 已发送 / 读信 / 写信 / 回复，基于 `agently-cli`，不离开面板）
- 📅 **会议日程视图 + ⏰ 悬浮提醒** / Meetings & reminders（与飞书消息共用 lark-cli 授权，提前 1 小时提醒、每 5 分钟刷新倒计时，已开完会议自动关联妙记/纪要）
- 📄 **妙记逐字稿 + 一键保存** / Transcripts（自动拉取已结束会议逐字稿到本地缓存，卡片提醒「逐字稿已生成」，点【保存】移动到目标目录）
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

### 本地开发安装 / Local (file:) install

```bash
pnpm add dsh-office@file:<path/to/dsh-office>
# 然后在 profile 的 bundles 里加 "dsh-office"
```

> 即：在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组中加入
> `"dsh-office"`，然后重启 `dsh web`。

数据目录：`~/.dsh/office/`（`office-config.json`、`token-usage.json`）。

## Usage / 使用

1. 右下角点 **🏢 办公室** FAB。
2. 打开 6 列面板，看到工作区 / 会话 / token / 子代理。
3. 点会话卡片跳转；面板随侧边栏切换自动收起。

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

## 📅 会议日程 + ⏰ 提醒 / Meetings & reminders

会议功能与飞书消息**共用同一套 lark-cli 授权**：在 `feishu-config.json` 的 `scripts` 里加一个
`calendar` 脚本（拉取日程的 Node 脚本，输出 `{ ok, events }`），消息同步完成时会**顺带拉取日程**，
缓存到 `~/.dsh/office/calendar-cache.json`。

```jsonc
// ~/.dsh/office/feishu-config.json
{
  "scripts": {
    "sync": "<ingestor.js 绝对路径>",
    "latest": "<latest.js 绝对路径>",
    "calendar": "<calendar.js 绝对路径>",      // ← 可选：会议日程脚本
    "transcript": "<transcript.js 绝对路径>",   // ← 可选：妙记逐字稿脚本
    "permission": "<permission.js 绝对路径>"    // ← 可选：妙记权限申请脚本
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

> 📖 **从 0 到 1 配置指南**：飞书消息流 + 会议日程 + 妙记/逐字稿的完整搭建步骤（安装 lark-cli、授权 scope、脚本契约、配置示例）见 [`docs/feishu-setup.md`](docs/feishu-setup.md)。

## Why dsh-office? / 解决什么问题

- **Before / 之前**：工作区多、会话散、token 不可见、子代理混在主列表里。
- **After / 之后**：一屏总览所有 agent 状态与资源占用。

## FAQ / 常见问题

**Q: 它和 dsh-polling 有什么区别？**
A: dsh-polling 管定时任务；dsh-office 管可视化总览。两者可共存。

**Q: token 的「单次输入」和「累计」是什么口径？**
A: 单次输入 = 最近一次请求的输入 token；累计 = 该会话历史输入 + 输出 + 缓存读写之和。活跃会话显示单次，空闲会话显示累计。

**Q: 子代理会话为什么看不到？**
A: 子代理会话默认从列表 / 徽标 / 悬浮里过滤（避免噪声），但 token 仍计入父会话。

## Ecosystem / 生态

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the harness this plugin runs on
- [dsh-plugin topic](https://github.com/topics/dsh-plugin) — more DSH plugins
- [awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) — curated DSH ecosystem

## License

MIT
