# 飞书消息 + 会议日程 从 0 到 1 配置指南

> 本指南覆盖 dsh-office 插件的两个「飞书数据源」功能：
> **💬 飞书消息流** 与 **📅 会议日程（+ ⏰ 提醒 + 📝 妙记/纪要）**。
> 两者**同源**：都通过本机的 `lark-cli`（用户身份）拉取飞书数据，共用同一个配置文件
> `~/.dsh/office/feishu-config.json`，只是脚本不同。配置好一次，两个功能都能用。

---

## 目录

1. [原理：插件如何拿到飞书数据](#1-原理插件如何拿到飞书数据)
2. [安装 lark-cli 并授权](#2-安装-lark-cli-并授权)
3. [准备数据源脚本](#3-准备数据源脚本)
4. [写配置文件 feishu-config.json](#4-写配置文件-feishu-configjson)
5. [在面板中验证](#5-在面板中验证)
6. [常见问题（报错兜底）](#6-常见问题报错兜底)

---

## 1. 原理：插件如何拿到飞书数据

dsh-office **不直接调用飞书 API**，而是"配置驱动"：

```
lark-cli（用户身份） → 你的本地脚本 → 输出 JSON → dsh-office 面板展示
```

你在 `feishu-config.json` 里配置**脚本的绝对路径**，插件在需要时用 Node 执行这些脚本、
解析它们的 stdout JSON。所以：

- 插件包本身**不含**任何飞书凭据、路径、域名——发布到 GitHub/npm 后别人拿到也能用，
  只要按本指南配置自己的脚本即可。
- 数据**只在本机**流转：lark-cli → 脚本 → 面板，不上传到任何服务器。

| 脚本 | 作用 | 由谁触发 |
|------|------|----------|
| `sync`（ingestor） | 拉取飞书消息并入库（含向量化，可选） | 手动点「同步」/ 定时自动同步 |
| `latest`（读取器） | 从本地库读取最近消息，供 💬 视图展示 | 面板打开 / 刷新 |
| `calendar`（日程） | 拉取我的会议日程（+已开完会议的妙记/纪要） | 消息同步完成后顺带 / 📅 视图打开 |

> 前两个支撑 💬 飞书消息；第三个支撑 📅 会议。三者**缺一不可**，但可独立配置——
> 只想用会议，`sync`/`latest` 可以不填（会得到"未配置"引导卡，不影响会议功能）。

---

## 2. 安装 lark-cli 并授权

### 2.1 安装

```bash
npm install -g @larksuite/cli
```

验证：

```bash
lark-cli --version
```

### 2.2 授权（用户身份）

会议和消息都以**登录用户**身份读取，需要用户授权。建议一次性申请以下 scope：

```bash
lark-cli auth login --profile <你的profile名> \
  --scope "auth:user.id:read calendar:calendar.event:read im:chat:read \
           im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user \
           im:message.reactions:read im:message:readonly \
           vc:meeting.meetingevent:read vc:record:readonly \
           minutes:minutes.artifacts:read minutes:minutes:readonly offline_access" \
  --no-wait --json
```

- `--profile`：自定义名称（如 `myself`），之后所有 lark-cli 命令都带 `--profile`。
- 授权链接会在浏览器打开，扫码/登录确认即可。
- `im:*` 是**消息**需要的；`calendar:*` + `vc:*` + `minutes:*` 是**会议/妙记**需要的。

### 2.3 验证授权

```bash
lark-cli --profile <profile名> auth status
```

看到 `"identity": "user"`、`"status": "ready"`、scope 列表包含上述权限即成功。

---

## 3. 准备数据源脚本

脚本放任意目录（建议与消息库同目录），**必须是 Node 脚本**，**stdout 只输出一行 JSON**。

### 3.1 `calendar.js`（会议日程 + 妙记/纪要）

调用 lark-cli 的 `calendar +agenda`，把已开完的会议再走
`calendar +meeting` → `vc +detail` → `note +detail` 关联妙记/纪要。

```js
'use strict';
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite'); // 不需要库可删

// lark-cli 的 Node 入口（全局安装后的真实路径，用 `npm prefix -g` 查）
const RUN_JS = '<npm全局目录>/node_modules/@larksuite/cli/scripts/run.js';
const PROFILE = '<你的profile名>';

function lark(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN_JS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (code === 0) { try { resolve(JSON.parse(out)); } catch { resolve(out); } }
      else reject(new Error('lark-cli exit ' + code + ': ' + (err || out).slice(0, 400)));
    });
    child.on('error', reject);
  });
}

function toLocal(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function main() {
  const now = new Date();
  const since = now.toISOString().slice(0, 10);
  const end = new Date(now); end.setDate(end.getDate() + 7);
  const res = await lark(['--profile', PROFILE, 'calendar', '+agenda', '--as', 'user',
    '--start', since, '--end', end.toISOString().slice(0, 10), '--format', 'json']);
  if (!res || !res.ok) throw new Error((res && res.error && res.error.message) || 'calendar 调用失败');
  const raw = Array.isArray(res.data) ? res.data : [];
  const events = raw.map((e) => ({
    event_id: e.event_id || '',
    summary: e.summary || '',
    start_ts: e.start_time ? new Date(e.start_time.datetime).getTime() : null,
    end_ts: e.end_time ? new Date(e.end_time.datetime).getTime() : null,
    start: toLocal(e.start_time && e.start_time.datetime),
    end: toLocal(e.end_time && e.end_time.datetime),
    meeting_url: (e.vchat && e.vchat.meeting_url) || '',
    app_link: e.app_link || '',
    organizer: (e.event_organizer && e.event_organizer.display_name) || '',
    rsvp: e.self_rsvp_status || '',
    busy: e.free_busy_status || 'busy',
  })).sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
  console.log(JSON.stringify({ ok: true, since, days: 7, total: events.length, events }));
  process.exit(0);
}

main().catch((e) => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
```

> 妙记/纪要（`meeting_id` / `minute_token`）是**可选增强**：脚本不返回这些字段，
> 📅 视图也能正常显示日程，只是已开完的会议不显示「📝 妙记」入口。
> 完整带妙记的版本见 [scripts/calendar.js](../scripts/calendar.js)（含 `calendar +meeting` → `vc +detail` 链路）。

### 3.2 `ingestor.js`（消息同步）与 `latest.js`（消息读取）

这两只支撑 💬 飞书消息。核心是：

- **ingestor**：`lark-cli im +chat-list --as user` 列出会话 → 对每个会话
  `lark-cli im +chat-messages-list --as user --chat-id <id> --page-size 50` 读消息，
  去重后写入本地 SQLite；最后打印
  `轮询完成 | 新增=X 跳过=Y 总消息=Z 耗时=Ns`（插件靠这行统计）。
- **latest**：从同一 SQLite 读最近消息，输出
  `{ ok: true, chats: [{ chat_id, chat_name, count, new_count, last_at, messages: [...] }] }`。

> **这两个脚本需要你自己准备**：它们属于你的「数据源」侧（本地消息库），不是插件包的一部分——
> 插件包只负责「执行脚本 + 解析 stdout JSON」，**不含任何你的库表结构或数据路径**（隐私边界）。
> 最小实现要点见上文：ingestor 走 `+chat-list` + `+chat-messages-list` 落 SQLite，
> latest 只读库输出 JSON。任何能按上述契约输出 JSON 的本地脚本都适用（不限于飞书）。
> 消息数据只存本机 SQLite，插件只读它的输出，不上传任何数据。

---

## 4. 写配置文件 feishu-config.json

路径：`~/.dsh/office/feishu-config.json`（`~` 即用户主目录；Windows 上通常是
`C:\Users\<用户名>\.dsh\office\feishu-config.json`）

```jsonc
{
  "profile": "myself",                    // 可选但推荐：lark-cli 授权 profile 名（§2.2 建的）
  "mention": ["你的名字"],            // 可选：消息里提到这个词 → 卡片标黄 + 📢 悬浮提示
  "autoSync": {                       // 可选：定时自动同步消息
    "enabled": true,
    "intervalMin": 60
  },
  "scripts": {
    "sync": "D:/你的目录/ingestor.js",     // 消息同步（ingestor）
    "latest": "D:/你的目录/latest.js",     // 消息读取（latest）
    "calendar": "D:/你的目录/calendar.js", // 会议日程（可选，填了才有 📅 视图）
    "transcript": "D:/你的目录/transcript.js",  // 可选：妙记逐字稿（有才显示 📄 功能）
    "permission": "D:/你的目录/permission.js"   // 可选：妙记权限申请（有才显示【申请权限】）
  },
  "manualWindowDays": 30,             // 可选：手动「同步」的深捞窗口（天）
  "manualMinutes": {}                 // 可选：妙记 token 手动绑定兜底（见下方说明）
}
```

要点：

- `profile` 显式指定 lark-cli 授权身份：dsh web 进程没有 `LARK_PROFILE` 环境变量，
  不写会走 CLI 默认 `default` profile，可能用错身份。
- `manualMinutes`：**手动绑定妙记 token 的兜底**。当某会议「你通过分享链接有妙记查看权限、
  但 vc 接口仍拒绝访问」时（飞书把两种权限分开判定），把 token 手动补上：
  `{ "manualMinutes": { "<event_id 或会议标题>": "<minute_token>" } }`。
  幂等：已查到的 token 不会被覆盖。
- `transcript` / `permission`：可选脚本（仓库 `scripts/` 下有开箱示例），
  不填则 📄 逐字稿与【申请权限】功能不显示，不影响其它功能。

注意：

- 路径用**绝对路径**；JSON 里反斜杠要转义（`\\`）或用正斜杠（`/`）。
- 文件有 UTF-8 BOM 也能读（插件会剥离），但建议无 BOM。
- 改完配置**刷新面板**即可，无需重启插件（每次读取都重新读文件）。

---

## 5. 在面板中验证

1. 重启/刷新 dsh web，右下角出现「🏢 办公室」。
2. 点开面板：
   - **💬 飞书**：应显示会话卡片流（按新消息数排序）。点「同步」触发一次深捞。
   - **📅 会议**：应显示双列日程（左=未开始、右=已结束）。右上角显示上次同步时间。
   - 会议室开始前 1 小时，右下角办公室按钮旁出现 **⏰** 按钮（倒计时，每 5 分钟刷新）。
3. 有妙记的已结束会议，卡片上有 **📝 妙记** 链接。

---

## 6. 常见问题（报错兜底）

| 现象 | 原因 | 解决 |
|------|------|------|
| 💬/📅 视图显示「未配置」引导卡 | `feishu-config.json` 缺失或 `scripts` 路径不对 | 按第 4 节核对配置；脚本路径必须存在 |
| 面板报 `lark-cli ... missing_scope` | 授权 scope 不够 | 按第 2.2 节重新授权（补 `--scope`） |
| `calendar` 拉取失败：`authentication / token_missing` | 用户身份未授权 | `lark-cli --profile <名> auth login` |
| 📅 有日程但没有「📝 妙记」 | 缺 `vc:*` scope，或该会议没有妙记产物 | 补授权后重开 📅 视图（自动重拉） |
| 会议视图显示「进行中」但会议已结束 | 旧缓存 | 点 📅 右上角「同步」，或等自动刷新 |
| 时区错乱（差 8 小时） | 脚本里用 UTC 转本地 | 用 `new Date(iso)` 解析后按本地时区格式化（见 3.1 的 `toLocal`） |

---

## 附：插件包内开箱脚本（scripts/ 目录）

- [`scripts/calendar.js`](../scripts/calendar.js) — 会议日程 + 妙记/纪要（含 `--days` / `--history` 参数，直接可配）
- [`scripts/transcript.js`](../scripts/transcript.js) — 妙记逐字稿生成（配合 `scripts.transcript`）
- [`scripts/permission.js`](../scripts/permission.js) — 妙记查看权限申请（配合 `scripts.permission`）
- [`scripts/lark-cli.js`](../scripts/lark-cli.js) — 上述脚本共用的 lark-cli 调用封装（run.js 探测 / stderr 解析 / 错误码映射）

> `ingestor.js` / `latest.js`（消息库脚本）属于你的数据源侧，不随插件包分发，需按 §3.2 自备。
