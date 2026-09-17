import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// 静态资源（随包走，只读）+ 运行时数据（用户 dsh home，可写）
// 不 import dsh-home-paths：file: 安装时其 peer 依赖解析可能失败，导致 Host 半整体加载失败
export const DSH_HOME = (process.env.DSH_HOME && String(process.env.DSH_HOME).trim()) || join(homedir(), ".dsh");
export const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
export const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
export const DATA_DIR = join(DSH_HOME, "office");
// 飞书消息采集脚本（随包提供）：用户未在 feishu-config 配 scripts.sync/latest 时默认使用
export const FEISHU_INGESTOR_DEFAULT = join(SCRIPTS_DIR, "feishu", "ingestor.js");
export const FEISHU_LATEST_DEFAULT = join(SCRIPTS_DIR, "feishu", "latest.js");
// 会议日程/妙记逐字稿/妙记权限申请脚本（随包 scripts/ 开箱示例）：未配置时默认使用
export const FEISHU_CALENDAR_DEFAULT = join(SCRIPTS_DIR, "calendar.js");
export const FEISHU_TRANSCRIPT_DEFAULT = join(SCRIPTS_DIR, "transcript.js");
export const FEISHU_PERMISSION_DEFAULT = join(SCRIPTS_DIR, "permission.js");
export const FEISHU_INSIGHTS_DEFAULT = join(SCRIPTS_DIR, "feishu", "insights.js");
export const HTML_PATH = join(ASSETS_DIR, "office.html");
export const BUBBLE_TEXTS_PATH = join(ASSETS_DIR, "bubble-texts.json");
export const CONFIG_PATH = join(DATA_DIR, "office-config.json");
export const TOKEN_USAGE_PATH = join(DATA_DIR, "token-usage.json");
export const TITLE_CACHE_PATH = join(DATA_DIR, "title-cache.json");

// P1-2: cache size caps to prevent unbounded memory growth
export const MAX_TOKEN_CACHE = 500;
export const MAX_TITLE_CACHE = 500;
export const MAX_TOKEN_DISK_ENTRIES = 1000;
export const MAX_TITLE_DISK_ENTRIES = 1000;

// P2-6: magic number constants
export const BODY_LIMIT_1MB = 1_048_576;
export const BODY_LIMIT_2MB = 2_097_152;
export const AGENTLY_TIMEOUT_MS = 60_000;
export const COLD_SUBAGENT_THROTTLE_MS = 30_000;

/* ── 补充常量 ── */
export const WEBSERVER_RETRY_DELAY_MS = 2000;
export const AGENTLY_RETRY_DELAY_MS = 600;
export const MAX_BUFFER_16MB = 16 * 1024 * 1024;
export const COLD_SNAPSHOT_TIMEOUT_MS = 15000;
export const CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const SAVE_DEBOUNCE_MS = 3000;
export const COLD_READ_BATCH_SIZE = 5;
export const BG_REFRESH_MAX_FAIL_COUNT = 5;
export const BG_REFRESH_WARN_THRESHOLD = 3;
export const UPCOMING_MEETING_WINDOW_MIN = 120;
export const ONGOING_MEETING_GRACE_MIN = -60;
export const CALENDAR_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
export const NEXT_SYNC_MIN_DELAY_MS = 1000;
export const MESSAGE_ID_MAX_LENGTH = 200;
export const MAIL_LIST_DEFAULT_LIMIT = 20;
export const MAIL_LIST_MAX_LIMIT = 50;
export const FEISHU_PER_CHAT_DEFAULT_LIMIT = 20;
export const FEISHU_PER_CHAT_MAX_LIMIT = 50;
// 图片/文件资源缓存默认目录：DSH_HOME 下通用位置（不含用户私有路径，隐私红线）；
// 用户可用 feishu-config.resourceDir 覆盖为自定义目录
export const FEISHU_RESOURCE_DEFAULT_DIR = join(DATA_DIR, "feishu-resources");
export const FEISHU_RESOURCE_TIMEOUT_MS = 60 * 1000;                 // 单资源下载超时
export const FEISHU_RESOURCE_KEY_MAX_LENGTH = 200;                   // resource_key 长度上限（防路径注入）
export const CACHE_PUBLIC_1D = "public, max-age=86400";              // 资源文件不变，缓存 1 天
export const MENTION_SNIPPET_LENGTH = 40;
export const LAYOUT_COLUMN_COUNT = 6;
export const RECENT_TOOL_NAMES_LIMIT = 3;
export const SESSION_ID_PREFIX_LENGTH = 6;
export const FEISHU_MANUAL_WINDOW_DAYS_DEFAULT = 30;
export const FEISHU_AUTOSYNC_INTERVAL_MIN_DEFAULT = 30;
export const FEISHU_AUTOSYNC_INTERVAL_MIN_MIN = 5;
export const FEISHU_AUTOSYNC_INTERVAL_MIN_MAX = 1440;
export const FEISHU_MANUAL_WINDOW_DAYS_MIN = 1;
export const FEISHU_MANUAL_WINDOW_DAYS_MAX = 90;
export const FEISHU_SYNC_TIMEOUT_MS = 5 * 60 * 1000;   // 全量轮询 + embedding 可能较久
export const FEISHU_LATEST_TIMEOUT_MS = 30 * 1000;
export const CALENDAR_SYNC_TIMEOUT_MS = 60 * 1000;
export const CALENDAR_DAYS_DEFAULT = 7;                // 拉取未来 N 天的日程
export const CALENDAR_HISTORY_DAYS_DEFAULT = 7;        // 额外拉取「已开完」的历史会议天数（含妙记/纪要入口）
export const STDERR_LOG_SLICE_LENGTH = 300;

// 💡 每日洞察（scripts.insights 脚本接入；LLM key 走 feishu-config insights.llmKeyFile 文件）
export const INSIGHTS_STATE_FILE = "insights-state.json";
export const INSIGHTS_HISTORY_FILE = "insights-history.json";   // 30 天按日快照（历史保留）
export const INSIGHTS_RETENTION_DAYS = 30;                       // 保留自然日数（含今天）
export const INSIGHTS_SECTIONS = ["todos", "unreplied", "highlights"];   // 与 insights.js 输出契约一致（删除校验用）
export const INSIGHTS_TIMEOUT_MS = 3 * 60 * 1000;            // 预同步 + 预筛 + LLM 精判可能较久
export const INSIGHTS_WINDOW_DAYS_DEFAULT = 1;
export const INSIGHTS_WINDOW_DAYS_MAX = 30;
export const INSIGHTS_TODOS_TOP_DEFAULT = 10;
export const INSIGHTS_TODOS_TOP_MAX = 50;
export const INSIGHTS_HIGHLIGHTS_TOP_DEFAULT = 5;
export const INSIGHTS_HIGHLIGHTS_TOP_MAX = 30;
export const INSIGHTS_UNREPLIED_HOURS_DEFAULT = 12;
export const INSIGHTS_UNREPLIED_HOURS_MAX = 168;
export const LLM_KEY_ENV = "DEEPSEEK_API_KEY";               // insights LLM 密钥的环境变量注入名（--llm-key-env 值；密钥值来自 feishu-config insights.llmKeyFile 文件）
export const INSIGHTS_PRESYNC_WINDOW_HOURS = 24;             // 生成前增量同步的兜底窗口

// 📝 待办（全局存储：项目 + 条目；用户自写数据，无自动清理）
export const TODOS_FILE = "todos.json";
export const TODO_PRIORITIES = ["高", "中", "低"];            // 优先级标签（与洞察待办一致）
export const TODO_TEXT_MAX = 500;                             // 单条待办标题上限（防异常膨胀）
export const TODO_NOTE_MAX = 2000;                            // 单条待办备注上限
export const TODO_PROJECT_MAX = 50;                           // 项目名长度上限
export const TODO_PROJECT_COUNT_MAX = 50;                     // 项目数量上限

/* 办公室日志（内存环形缓冲，供 /office-ui/logs 实时查看） */
export const OFFICE_LOG_MAX = 500;
export const OFFICE_LOG_LEVELS = new Set(['info', 'warn', 'error']);

/* 逐字稿（transcript） */
export const TRANSCRIPTS_DIR = join(DATA_DIR, "transcripts");
export const TRANSCRIPTS_STATE_PATH = join(DATA_DIR, "transcripts-state.json");
export const TRANSCRIPT_TIMEOUT_MS = 120 * 1000;
export const TRANSCRIPT_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
export const TRANSCRIPT_BATCH_MAX = 2;
export const TRANSCRIPT_SAVE_HISTORY_MAX = 5;
export const PERMISSION_TIMEOUT_MS = 30 * 1000;

/* Content-Type */
export const CT_JSON = 'application/json; charset=utf-8';
export const CT_TEXT = 'text/plain; charset=utf-8';
export const CT_HTML = 'text/html; charset=utf-8';
export const CT_BINARY = 'application/octet-stream';
export const CACHE_NO_STORE = 'no-store';
export const CACHE_PUBLIC_1H = 'public, max-age=3600';

/* 重复字符串 */
export const FEISHU_CONFIG_PATH_DISPLAY = '~/.dsh/office/feishu-config.json';
export const URL_PARSE_BASE = 'http://localhost';
export const DEFAULT_SESSION_TITLE_PREFIX = '会话 ';
export const MAIL_DIRS_ALLOWED = ['inbox', 'sent', 'trash', 'spam'];

/* CLI 错误码 */
export const CLI_ERROR_TRANSIENT = 1;
export const CLI_ERROR_AUTH_REQUIRED = 3;
export const CLI_ERROR_LOCAL_NETWORK = 4;

/* 瞬态网络错误 */
export const TRANSIENT_ERROR_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']);

// ============================================================
// Agent Mail（agently-cli）集成：面板「邮箱」页签
// 直接以 Node 执行 CLI 入口（不经 cmd 外壳），规避注入与 .cmd 兼容问题
// ============================================================
export const AGENTLY_PKG = "@tencent-qqmail/agently-cli";
export const AGENTLY_ENTRY_REL = ["scripts", "run.js"];

// 高频只读轮询路径：不记请求日志（避免 3 秒轮询刷屏）
// 含 /office-ui/logs：日志 tab 自身 2.5 秒轮询，若不过滤会把真实动作日志挤出缓冲
export const HIGH_FREQ_READ_PATHS = new Set([
  "/office-ui/data",
  "/office-ui/health",
  "/office-ui/bubble-texts",
  "/office-ui/logs"
]);

// 飞书主配置（消息流 / 群聊助理 / 会话通知共用同一份授权与脚本声明）
export const FEISHU_CONFIG_PATH = join(DATA_DIR, "feishu-config.json");

// ============================================================
// 🔔 会话跑完通知（notify.js）：agent 回到 idle 且属于白名单工作区时私聊推送
// 独立配置文件：office-config.json 由 office.js 的 saveConfig() 整体重写，不能共用
// ============================================================
export const NOTIFY_CONFIG_PATH = join(DATA_DIR, "notify-config.json");
export const NOTIFY_SETTLE_MS_DEFAULT = 60000;       // idle 后先等这么久再发（期间又跑起来则撤回）；这段同时是留给你自己先看完的窗口
export const NOTIFY_SNIPPET_MAX = 200;               // 通知正文引用最后一段回答的字数上限
export const NOTIFY_SEND_TIMEOUT_MS = 30 * 1000;     // 单次 lark-cli 调用超时
export const NOTIFY_STATUS_PATH = "/office-ui/notify/status";
