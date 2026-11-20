#!/usr/bin/env node
// @ts-check
/**
 * Stop hook：回合结束时的实时续跑主路径（借鉴 cv-superding/zcode-auto-resume）。
 *
 * 与 watcher（DB 轮询兜底）分工：
 *   - Stop 触发时回合已正常结束，从 stdin last_assistant_message 取错误横幅/截断/空响应
 *     做文本分类（watcher 覆盖不到的 completed-but-error 盲区在此拦截，且延迟≈0）；
 *   - turn.failed 路径不触发任何钩子（客户端故障致死），由 watcher 轮询 DB 兜底；
 *   - 两条路径共享 state.json 的 per-session consecutive/lastAttemptAt，
 *     续跑上限与冷却合并计数，互不重复注入（watcher 见 hookTurnIds 去重）。
 *
 * 干跑：设 ZCODE_AC_DRY_RUN=1 只记录决策、不真正 block。
 * stdin 字段双兼容（驼峰/下划线），任何异常静默放行，绝不阻塞会话。
 */
import { classifyText, classifyTruncation, classifyDangling, loopGuardHash, fillTemplate, resolveConfig, inspectTranscript } from '../lib/core.mjs';
import { readState, writeState, sessionEntry, consumeSuppress } from '../lib/state.mjs';
import { record } from '../lib/stats.mjs';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../lib/state.mjs';

const DRY = process.env.ZCODE_AC_DRY_RUN === '1';
const CONFIG_PATH = process.env.ZCODE_AC_CONFIG || join(STATE_DIR, 'config.json');

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) return resolveConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  } catch {}
  return resolveConfig({});
}

function log(msg) {
  try {
    appendFileSync(join(STATE_DIR, 'watcher.log'), `[${new Date().toISOString()}] [stop] ${msg}\n`);
  } catch {}
}

function pick(obj, ...keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

/** stdin 字段双兼容归一化（ZCode 驼峰 / Claude 下划线）。 */
export function normalizeInput(raw) {
  return {
    event: String(pick(raw, 'hook_event_name', 'hookEventName') || ''),
    sessionId: String(pick(raw, 'session_id', 'sessionId') || 'unknown'),
    lastMessage: String(pick(raw, 'last_assistant_message', 'lastAssistantMessage', 'responseText', 'responsePreview') ?? ''),
    transcriptPath: String(pick(raw, 'transcript_path', 'transcriptPath') || ''),
    stopHookActive: Boolean(pick(raw, 'stop_hook_active', 'stopHookActive')),
    // 本回合的工具调用数（宿主 runStopHooks 传入，实测在 Stop 载荷里）。
    // 这是"回合是否真的做了事"的唯一权威信号：transcript 与 last_assistant_message 同源，
    // 无法证明"无工具调用"（见 inspectTranscript 注释）。
    toolCallCount: (() => {
      const v = Number(pick(raw, 'tool_call_count', 'toolCallCount'));
      return Number.isFinite(v) && v > 0 ? v : 0;
    })(),
    // 宿主在 Stop 载荷里带了 turnId（QWo → hookRunner.run 的 turnId）。
    // watcher 靠它做去重：hookResumeAt 与 completed_at 的时间序是错的——
    // Stop 钩子在【回合结束之前】执行，hookResumeAt 必然早于 completed_at，
    // 原条件 hookResumeAt >= completed_at 恒不成立（实测日志该分支 0 次命中）。
    turnId: String(pick(raw, 'turn_id', 'turnId') || ''),
  };
}

/**
 * 判定"无文本"是否该视为真空响应。
 *
 * 证据链（按可靠性从高到低）：
 *   1. lastMessage 有文本 → 不是空响应；
 *   2. toolCallCount > 0 → 本回合做过工具调用，以工具收尾后没有文本是【正常结束】
 *      （README 承诺"a turn that merely ended after tool calls is *not* treated as empty"）；
 *   3. transcript 可读且最后一条 assistant 既无 text 也无 tool → 真空响应。
 *
 * 原实现只用第 3 条：而 ZCode 的 transcript 内容恒等于 last_assistant_message
 * （同一行纯 text，永不产出 tool part），hasText 与"lastMessage 非空"是同一个布尔，
 * hasTool 分支不可达 → 逻辑退化成"text 为空即判 empty"，声称的"避免误伤工具收尾回合"
 * 实际未实现。toolCallCount 补上了这个缺口。
 */
export function resolveEmptyKind(input, cfg) {
  if (input.lastMessage.trim()) return null;
  if (input.toolCallCount > 0) return null; // 做过工具调用：无文本是正常收尾
  if (cfg.scanTranscript === false) return null; // 显式关闭取证则不猜，保守放行
  const t = inspectTranscript(input.transcriptPath);
  if (!t.decisible) return null;      // 读不到 transcript：保守放行
  if (t.hasText || t.hasTool) return null; // 有文本或工具调用 → 正常结束
  return 'empty';
}

/**
 * 纯决策函数（可单测）：输入归一化信息 + 会话状态 + 配置，输出动作。
 * @returns {{action:'pass'|'block'|'give-up'|'cooldown'|'suppress', reason?:string, text?:string, waitMs?:number, kind?:string}}
 */
export function decide({ input, entry, cfg, maxHookRetries, loopGuardRepeats }) {
  // 一次性豁免：用户手动叫停本轮续跑，消费后放行。
  // （suppress 的清除在调用方做，这里只读）
  const msg = input.lastMessage;

  let kind = classifyText(msg, cfg);
  if (!kind && msg.trim()) kind = classifyTruncation(msg, cfg) ? 'truncation' : null;
  // 悬空意图：回合只宣布了下一步却结束（completed + 最后一步无工具调用），
  // 既无错误也无截断，前面几类全部放行。判为未完成，要求直接给出结果。
  if (!kind) kind = classifyDangling(msg, cfg);
  if (!kind) kind = resolveEmptyKind(input, cfg);

  if (!kind) return { action: 'pass', kind: 'normal' };
  if (kind === 'permanent') return { action: 'pass', kind, reason: '永久性错误，重试无意义' };

  // 已放弃的会话：直接放行。原实现在这里继续往下走 → 每次 Stop 都命中 give-up，
  // 消费方每次都 record('gaveUp') + 写盘，把统计稀释（stopped 只应计一次）。
  // kind 用 'stopped' 而非 'normal'：调用方只在 kind==='normal' 时重置计数，
  // 用 normal 会顺手把 stopped 复位、闸门重开。
  if (entry.stopped) return { action: 'pass', kind: 'stopped' };

  if (entry.consecutive >= maxHookRetries) return { action: 'give-up', kind, reason: `已达续跑上限 ${maxHookRetries}` };

  // 重入防护：stop_hook_active 表示本次停止由我们自己的 block 引发。
  // 此时同样的"空响应"不应被当作新证据（否则 block→空→block 无限循环），
  // 强制计入重复，交给 loopGuard 收敛。
  const hash = loopGuardHash(msg);
  const repeats = hash === entry.lastHash ? entry.repeats + 1 : 1;
  const effectiveRepeats = input.stopHookActive ? Math.max(repeats, entry.repeats + 1) : repeats;
  if (effectiveRepeats > loopGuardRepeats) return { action: 'give-up', kind, reason: '相同错误连续重复，停止重试' };

  // 冷却期：hook 处理的回合状态是 completed，watcher 接不住，所以这里不能长冷却，
  // 否则该回合被静默丢弃（实测 20s 内连续两个悬空回合，第二个直接没了）。
  // 限速交给引擎的 3 次 block 硬上限 + maxConsecutive + loopGuard。
  const wait = Math.max(0, (entry.lastAttemptAt || 0) + cfg.hookCooldownMs - Date.now());
  if (wait > 0) return { action: 'cooldown', kind, waitMs: wait, reason: 'hook 冷却中' };

  const text = kind === 'truncation'
    ? fillTemplate(cfg.continueText, {}) + cfg.truncationSuffix
    : kind === 'empty'
      ? fillTemplate(cfg.continueText, {}) + cfg.emptySuffix
      : kind === 'dangling'
        // 悬空意图：模型只说"让我…"就结束了，用户没拿到结果。
        // 明确要求直接给出结果，而不是又描述一遍下一步计划。
        ? fillTemplate(cfg.continueText, {}) + cfg.danglingSuffix
        : fillTemplate(cfg.continueText, { facts: { code: '', message: msg.slice(0, 200), status: '' }, errorCount: entry.consecutive + 1 });

  return { action: 'block', kind, text, repeats: effectiveRepeats, hash };
}

async function main() {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch {}
  let input;
  try { input = normalizeInput(JSON.parse(raw || '{}')); } catch { return; }
  if (input.event !== 'Stop') return;

  const cfg = loadConfig();
  const state = readState();
  const entry = sessionEntry(state, input.sessionId);

  try {
    if (cfg.paused || (state.pausedUntil && state.pausedUntil > Date.now())) {
      log(`skip ${input.sessionId}: paused`);
      return;
    }
    if (consumeSuppress(state, input.sessionId)) {
      writeState(state);
      log(`suppress consumed ${input.sessionId}`);
      return;
    }

    const d = decide({
      input, entry, cfg,
      // hook 路径自限 3 次：到达后 give-up 并置 stopped，该会话停止自动续跑
      // （直到用户输入、或某个回合正常完成后复位；可选 stoppedRetryAfterMs 复燃）。
      // 注意：这不是"交给 watcher 继续"——Stop 钩子处理的回合最终状态是 completed，
      // watcher 的 classifyTurn 对 completed 一律 none，结构上接不住；且 stopped 会让
      // watcher 的续跑分支直接跳过。原注释写成"交给 watcher"是错的（审查确认）。
      // 引擎侧确有同值硬上限（zcode.cjs：shouldContinueAfterStopHooks 要求
      // stopHookContinuationCount < 3，block 的 reason 会进 additionalContexts，
      // 故本插件输出 {decision:'block', reason} 的契约成立）；取 min 是双保险。
      maxHookRetries: Math.min(cfg.maxConsecutive, 3),
      loopGuardRepeats: cfg.loopGuardRepeats,
    });

    if (d.action === 'pass') {
      if (d.kind === 'normal' && (entry.consecutive > 0 || entry.repeats > 0)) {
        entry.consecutive = 0; entry.repeats = 0; entry.lastHash = ''; entry.stopped = false;
        entry.failedCount = 0;
        entry.resetAt = Date.now(); // 让合并判据认得这次重置（否则被 watcher 旧快照覆盖）
        writeState(state);
        log(`reset ${input.sessionId}: 回合正常结束`);
      } else if (d.kind === 'permanent') {
        entry.consecutive = 0; entry.stopped = true;
        entry.resetAt = Date.now();
        writeState(state);
        record('skipped');
        log(`skip ${input.sessionId}: ${d.reason}`);
      }
      return;
    }
    if (d.action === 'give-up') {
      entry.stopped = true;
      // 写 resetAt：一是让合并判据（含 resetAt）认得这次写入，
      // 二是 watcher 复燃窗口的计时起点（hook give-up 不写 lastAttemptAt）。
      entry.resetAt = Date.now();
      writeState(state);
      record('gaveUp');
      log(`give-up ${input.sessionId}: ${d.reason}`);
      return;
    }
    if (d.action === 'cooldown') {
      // 极短冷却（默认 3s）：只防同刻重复注入，不再长期放行。
      log(`cooldown ${input.sessionId}: ${Math.round(d.waitMs / 1000)}s`);
      return;
    }

    // 干跑：只记日志，不动共享状态。原实现把 DRY 判在写 state 之后，干跑会把
    // consecutive/hookTurnIds/lastHash 写进真实状态。
    if (DRY) { log(`DRY-RUN ${input.sessionId} kind=${d.kind} 将续跑：${d.text.slice(0, 80)}`); return; }

    // block 续跑：更新共享计数。
    entry.consecutive += 1;
    entry.lastAttemptAt = Date.now();
    // watcher 去重：记下本回合已被 hook 续跑过（按 turnId，见 normalizeInput 注释）。
    if (input.turnId) {
      entry.hookTurnIds = [...new Set([...(entry.hookTurnIds || []), input.turnId])].slice(-20);
    }
    entry.lastHash = d.hash;
    entry.repeats = d.repeats;
    writeState(state);
    log(`block ${input.sessionId} #${entry.consecutive} kind=${d.kind} "${d.text.slice(0, 80)}"`);

    record('sent');
    process.stdout.write(JSON.stringify({ decision: 'block', reason: d.text }));
  } catch (e) {
    log(`error ${input.sessionId}: ${e?.stack || e}`);
    // 任何异常都放行，绝不阻塞会话。
  }
}

main().catch(() => process.exit(0));
