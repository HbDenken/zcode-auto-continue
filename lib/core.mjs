// @ts-check
/**
 * 共享核心：平台无关的纯逻辑（从 dsh-auto-continue src/shared/core.ts 移植）。
 *
 * ZCode 没有 DSH 的 host 进程内事件订阅与 agent.followup API，
 * 故把"错误分类 / 自适应退避 / 模板填充 / 幂等护栏 / 循环守卫"
 * 这些平台无关的纯逻辑原样保留，仅去掉 DSH 专属类型与回显识别。
 */
import { readFileSync } from 'node:fs';

/** 支持的 UI/配置语言；未知浏览器语言回退中文。 */
export const AutoContinueLocale = { ZH: 'zh', EN: 'en' };

/** 本地化默认文案（仅保留实际生效项；silent/interrupted 静默回合检测在 ZCode 不可移植）。 */
export const LOCALIZED_TEXT_DEFAULTS = {
  zh: { continueText: '继续' },
  en: { continueText: 'Continue' },
};

/** 完整解析后的配置（内置默认 + 用户覆盖）。 */
export const DEFAULT_CONFIG = {
  locale: 'zh',
  continueText: '继续',
  graceMs: 3000,
  cooldownMs: 20000,
  maxConsecutive: 3,
  verbose: true,
  classify: true,
  retryableErrorPatterns: '',
  backoffFactor: 2,
  backoffMaxMs: 300000,
  paused: false,
  loopGuardRepeats: 3,
  maxErrorLength: 500,
  bannerMaxLength: 80,
  minErrorCoverage: 0.2,
  truncationGuard: true,
  minTruncationLength: 300,
  suppress: false,
  permanentPatterns: null,
  transientPatterns: null,
  scanTranscript: true,
  injectTimeoutMs: 120000,
};

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 把（可能缺失的）配置段解析为完整配置。 */
export function resolveConfig(section = {}) {
  const value = section;
  const locale = value.locale === 'en' ? 'en' : 'zh';
  const localized = LOCALIZED_TEXT_DEFAULTS[locale];
  return {
    locale,
    continueText:
      typeof value.continueText === 'string' && value.continueText.trim() !== ''
        ? value.continueText
        : localized.continueText,
    graceMs: numberOr(value.graceMs, DEFAULT_CONFIG.graceMs),
    cooldownMs: numberOr(value.cooldownMs, DEFAULT_CONFIG.cooldownMs),
    maxConsecutive: Math.max(1, numberOr(value.maxConsecutive, DEFAULT_CONFIG.maxConsecutive)),
    verbose: booleanOr(value.verbose, DEFAULT_CONFIG.verbose),
    classify: booleanOr(value.classify, DEFAULT_CONFIG.classify),
    retryableErrorPatterns:
      typeof value.retryableErrorPatterns === 'string'
        ? value.retryableErrorPatterns.trim()
        : DEFAULT_CONFIG.retryableErrorPatterns,
    backoffFactor: Math.max(1, numberOr(value.backoffFactor, DEFAULT_CONFIG.backoffFactor)),
    backoffMaxMs: numberOr(value.backoffMaxMs, DEFAULT_CONFIG.backoffMaxMs),
    paused: booleanOr(value.paused, DEFAULT_CONFIG.paused),
    loopGuardRepeats: Math.max(1, numberOr(value.loopGuardRepeats, DEFAULT_CONFIG.loopGuardRepeats)),
    maxErrorLength: numberOr(value.maxErrorLength, DEFAULT_CONFIG.maxErrorLength),
    bannerMaxLength: numberOr(value.bannerMaxLength, DEFAULT_CONFIG.bannerMaxLength),
    minErrorCoverage: numberOr(value.minErrorCoverage, DEFAULT_CONFIG.minErrorCoverage),
    truncationGuard: booleanOr(value.truncationGuard, DEFAULT_CONFIG.truncationGuard),
    minTruncationLength: numberOr(value.minTruncationLength, DEFAULT_CONFIG.minTruncationLength),
    suppress: booleanOr(value.suppress, DEFAULT_CONFIG.suppress),
    // 自定义分类正则：数组或非空字符串才生效，否则用内置表（classifyText 据此分支）。
    permanentPatterns: Array.isArray(value.permanentPatterns) && value.permanentPatterns.length
      ? value.permanentPatterns
      : DEFAULT_CONFIG.permanentPatterns,
    transientPatterns: Array.isArray(value.transientPatterns) && value.transientPatterns.length
      ? value.transientPatterns
      : DEFAULT_CONFIG.transientPatterns,
    scanTranscript: booleanOr(value.scanTranscript, DEFAULT_CONFIG.scanTranscript),
    // 单次注入子进程超时。原实现硬编码 5 分钟且串行等待，实测连续 8 次超时
    // 会让所有会话的轮询停摆近 40 分钟。
    injectTimeoutMs: Math.max(5000, numberOr(value.injectTimeoutMs, DEFAULT_CONFIG.injectTimeoutMs)),
  };
}

/**
 * 从最近的消息行（ZCode message 表 data 列 JSON，role 内嵌于 data）
 * 中提取最近一条 assistant 消息的 error 载荷，作为失败事实。
 * 注意：ZCode 的 message 表无 role 列，role 嵌在 data JSON 内。
 */
export function extractErrorFacts(messageDataRows) {
  for (const raw of messageDataRows) {
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    if (d.role !== 'assistant') continue;
    if (!d.error) return null; // 最近的 assistant 消息无 error
    const data = d.error.data ?? {};
    const message = String(data.message || '');
    return {
      code: data.code || d.error.name || 'UNKNOWN',
      message,
      status: extractHttpStatus(message),
    };
  }
  return null;
}

function extractHttpStatus(msg) {
  if (!msg) return undefined;
  // 优先匹配 "HTTP 4xx/5xx" / "status 4xx" / "error 5xx" 格式，避免误伤普通数字（如 "4096 tokens"）。
  const m = /HTTP[:\s]+(\d{3})/i.exec(msg)
    || /status[:\s]+(\d{3})/i.exec(msg)
    || /error[:\s]+(\d{3})/i.exec(msg);
  if (m) return Number(m[1]);
  // 回退：仅匹配独立的 4xx/5xx 三位数（周围有空格或标点），不匹配 4096 之类。
  const fb = /(?:^|[^\d])(4\d\d|5\d\d)(?:[^\d]|$)/.exec(msg);
  return fb ? Number(fb[1]) : undefined;
}

/**
 * 错误分类：该失败是否值得自动继续。
 * 用户填写的 provider 专属文本片段优先覆盖内置结果；未命中时，
 * 永久性失败（认证/余额/模型不存在/上下文超限等）重试也不会成功，应跳过并通知用户；
 * 其余（网络、超时、5xx、429 等）视为临时性失败，允许自动恢复。
 */
export function isTransientFailure(failure, retryableErrorPatterns = '') {
  const haystack = `${failure.code} ${failure.status ?? ''} ${failure.message}`.toLowerCase();
  const explicitlyRetryable = retryableErrorPatterns
    .split(/\r?\n/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '')
    .some((p) => haystack.includes(p));
  if (explicitlyRetryable) return true;
  const status = failure.status;
  if (status !== undefined && (status === 401 || status === 403)) return false;
  const permanent =
    /auth|unauthor|forbidden|credential|api[ _-]?key|permission/i.test(haystack) ||
    /insufficient.*(balance|quota)|billing|payment|quota.*exceeded/i.test(haystack) ||
    /model.*not[ _-]?found|unknown[ _-]?model|no model found|does not exist.*model|model.*does not exist|not.*support.*model/i.test(haystack) ||
    /context.*(length|limit|overflow|exceed)|token.*limit|max.*context/i.test(haystack) ||
    /invalid[ _-]?request|bad[ _-]?request/i.test(haystack);
  return !permanent;
}

/** 自适应退避：同一会话连续失败时的有效冷却间隔。 */
export function effectiveCooldown(consecutive, base, factor, max) {
  const multiplier = Math.pow(factor, consecutive);
  return Math.min(Math.max(base, base * multiplier), Math.max(base, max));
}

/** 模板填充：把 {code}/{message}/{status}/{tool}/{turn}/{errorCount} 等占位符替换为实际值。 */
export function fillTemplate(template, ctx = {}) {
  const facts = ctx.facts;
  const vars = {
    code: facts?.code ?? '',
    message: facts?.message ?? '',
    status: facts?.status ?? '',
    tool: ctx.tool ?? '',
    turn: ctx.turn ?? '',
    errorCount: ctx.errorCount ?? '',
    sessionTitle: ctx.sessionTitle ?? '',
  };
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

/** 睡眠。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 本地日期键 YYYY-MM-DD。 */
export function todayKey() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 空统计桶。 */
export function emptyDayStats() {
  return { date: todayKey(), sent: 0, skipped: 0, recovered: 0, failed: 0, gaveUp: 0, byCode: {} };
}

// ---------------------------------------------------------------------------
// Stop hook 文本分类（纯逻辑，可单测）
// ---------------------------------------------------------------------------

/** 永久性错误关键词（正则源串）。命中则不重试。 */
export const PERMANENT_PATTERNS = [
  '\\b40[123]\\b',
  'unauthorized|unauthorised|forbidden|authentication|authenticat',
  'invalid[ _-]?api[ _-]?key|apikey|credential|鉴权|认证失败|凭证|无效的密钥',
  'insufficient (balance|funds|quota)|余额不足|欠费|余额已不足',
  'billing|payment required|quota exceeded|配额(不足|已用|用尽)|免费额度',
  'model not found|unknown model|模型不存在|无可用模型',
  'context[_ -]length|prompt (is )?too long|maximum context|上下文(超|过|长度)|输入过长|token limit|too many tokens',
];

/** 临时性错误关键词（正则源串）。命中则可重试。 */
export const TRANSIENT_PATTERNS = [
  '当前系统繁忙|系统繁忙|服务器繁忙|稍后再试|请切换模型|过载|繁忙，请',
  'overloaded|over capacity|temporar|try again later|please retry|please try again',
  'rate[- _]?limit|too many requests|\\b429\\b|限流|请求过于频繁',
  '\\b50[0234]\\b|bad gateway|service unavailable|gateway timeout|internal server error|upstream error',
  'time[- _]?out|timed ?out|超时',
  'econnreset|econnrefused|econnaborted|etimedout|enotfound|ehostunreach|enetunreach',
  'socket hang up|fetch failed|network error|connection (error|reset|closed|interrupted)|网络错误|网络异常|网络连接|连接中断|连接失败|请求失败',
  'stream (error|ended unexpectedly|closed|terminated)|sse error|request failed|upstream stream (terminated|closed|reset)|provider_code=streaming_error|streaming_error',
];

/** 长消息只认尾部错误横幅时使用的严格标记。 */
const STRICT_PATTERNS = [
  '当前系统繁忙|系统繁忙|api error|internal server error|overloaded',
  'rate limit|service unavailable|bad gateway|network error',
];

function compile(patterns) {
  return patterns.map((s) => {
    try { return new RegExp(s, 'i'); } catch { return null; }
  }).filter(Boolean);
}

function anyMatch(regexes, text) {
  return regexes.some((re) => re.test(text));
}

/** 命中片段去重后总长度占消息长度的比例。 */
function matchRatio(regexes, message) {
  const spans = [];
  for (const re of regexes) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(message)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (m.index === g.lastIndex) g.lastIndex += 1;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0, lastEnd = -1;
  for (const [s, e] of spans) {
    if (s >= lastEnd) { covered += e - s; lastEnd = e; }
    else if (e > lastEnd) { covered += e - lastEnd; lastEnd = e; }
  }
  return covered / message.length;
}

/** 模块级预编译：避免每次 classifyText 调用都重复 new RegExp（GC 压力）。 */
const PERM_COMPILED = compile(PERMANENT_PATTERNS);
const TRANS_COMPILED = compile(TRANSIENT_PATTERNS);
const STRICT_COMPILED = compile(STRICT_PATTERNS);

/**
 * 文本错误分类。返回 'transient' | 'permanent' | null。
 * 永久性判定优先；临时性判定有长消息尾部 / 覆盖率门槛双重误报防护。
 */
export function classifyText(text, config = {}) {
  const message = String(text || '').trim();
  if (!message) return null;
  const maxLen = config.maxErrorLength ?? 500;
  if (message.length > maxLen) {
    return anyMatch(STRICT_COMPILED, message.slice(-120)) ? 'transient' : null;
  }
  const perm = config.permanentPatterns ? compile(config.permanentPatterns) : PERM_COMPILED;
  const trans = config.transientPatterns ? compile(config.transientPatterns) : TRANS_COMPILED;
  if (anyMatch(perm, message)) return 'permanent';
  if (anyMatch(trans, message)) {
    const bannerMax = config.bannerMaxLength ?? 80;
    if (message.length <= bannerMax) return 'transient';
    if (matchRatio(trans, message) >= (config.minErrorCoverage ?? 0.2)) return 'transient';
  }
  return null;
}

/** 输出截断判定：未闭合代码块 / 尾部省略号 / 悬空标点。 */
export function classifyTruncation(text, config = {}) {
  if (config.truncationGuard === false) return null;
  const trimmed = String(text || '').trimEnd();
  if (trimmed.length < (config.minTruncationLength ?? 300)) return null;
  if ((trimmed.match(/```/g) || []).length % 2 === 1) return 'truncation';
  if (/(\.\.\.|…)\s*$/.test(trimmed)) return 'truncation';
  if (/[:：(\[{【]\s*$/.test(trimmed)) return 'truncation';
  return null;
}

/** 循环守卫 hash：相同错误内容重复出现时去重。 */
export function loopGuardHash(text) {
  return Buffer.from(String(text || '')).toString('base64').slice(0, 64);
}

/**
 * 读 transcript（临时 JSONL）最后一条 assistant 条目，判定"无文本"是否可信。
 * ZCode 的 Stop 钩子在回合以工具调用收尾时，last_assistant_message 常常为空——
 * 那是正常结束，不该当空响应注入续跑（实测：本机 300 个 completed 回合里
 * 30 个最后一条 assistant 无 text part，其中 29 个只有 tool）。
 * 返回 { decisible, hasText, hasTool }；decisible=false 表示文件不可读/无 assistant 条目。
 * bug 修复：原实现 `if (!kind && !msg.trim()) kind = 'empty'` 只凭 msg 为空就注入。
 */
export function inspectTranscript(transcriptPath) {
  if (!transcriptPath) return { decisible: false };
  let lines;
  try {
    lines = String(readFileSync(transcriptPath, 'utf8')).trimEnd().split('\n');
  } catch {
    return { decisible: false };
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    const message = entry.message || entry;
    const role = message.role || entry.type;
    if (role !== 'assistant') continue;
    const parts = message.content ?? message.parts ?? entry.parts ?? entry.content;
    let hasText = false;
    let hasTool = false;
    if (typeof parts === 'string') hasText = parts.trim() !== '';
    else if (Array.isArray(parts)) {
      for (const p of parts) {
        const type = String(p?.type || '');
        if (type === 'text' && String(p?.text || '').trim() !== '') hasText = true;
        else if (/tool/.test(type)) hasTool = true;
      }
    }
    return { decisible: true, hasText, hasTool };
  }
  return { decisible: false };
}

// ponytail: 完整 DSH 循环守卫（工具调用关联/短句窗口/流内重复）未移植——
// ZCode 的 turn_usage 表已含 context_exceeded/cancelled_by_user/retryable，
// 且无 host 事件流可做实时关联；仅在纯逻辑层保留 isTransientFailure/effectiveCooldown/fillTemplate。
// 升级路径：当 ZCode 提供 turn 级实时事件流时，再从 core.ts 移植 LoopGuard 类。
