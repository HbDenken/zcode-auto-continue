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
 *     续跑上限与冷却合并计数，互不重复注入（watcher 见 hookResumeAt 去重）。
 *
 * 干跑：设 ZCODE_AC_DRY_RUN=1 只记录决策、不真正 block。
 * stdin 字段双兼容（驼峰/下划线），任何异常静默放行，绝不阻塞会话。
 */
import { classifyText, classifyTruncation, loopGuardHash, fillTemplate, resolveConfig, inspectTranscript } from '../lib/core.mjs';
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
  };
}

/**
 * 判定"无文本"是否该视为真空响应。
 * 原实现的 bug：`if (!kind && !msg.trim()) kind = 'empty'` —— 只凭 msg 为空就注入，
 * 导致以工具调用收尾的正常回合被反复注入"上次回复为空"（实测误伤本机审查会话）。
 * 现在要求 transcript 提供正面证据：最后一条 assistant 条目存在、且既无 text 又无 tool。
 */
export function resolveEmptyKind(input, cfg) {
  if (input.lastMessage.trim()) return null;
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
  if (!kind) kind = resolveEmptyKind(input, cfg);

  if (!kind) return { action: 'pass', kind: 'normal' };
  if (kind === 'permanent') return { action: 'pass', kind, reason: '永久性错误，重试无意义' };

  if (entry.consecutive >= maxHookRetries) return { action: 'give-up', kind, reason: `已达续跑上限 ${maxHookRetries}` };

  // 重入防护：stop_hook_active 表示本次停止由我们自己的 block 引发。
  // 此时同样的"空响应"不应被当作新证据（否则 block→空→block 无限循环），
  // 强制计入重复，交给 loopGuard 收敛。
  const hash = loopGuardHash(msg);
  const repeats = hash === entry.lastHash ? entry.repeats + 1 : 1;
  const effectiveRepeats = input.stopHookActive ? Math.max(repeats, entry.repeats + 1) : repeats;
  if (effectiveRepeats > loopGuardRepeats) return { action: 'give-up', kind, reason: '相同错误连续重复，停止重试' };

  // 冷却期：hook 不阻塞，总是放行让 watcher 兜底。
  // watcher 每轮热重载 config + 读 state，能准确计算退避并在冷却结束后注入。
  // Stop hook 阻塞可能被 ZCode 的 hooks.json timeoutMs 杀死，导致 block 丢失。
  const wait = Math.max(0, (entry.lastAttemptAt || 0) + cfg.cooldownMs - Date.now());
  if (wait > 0) return { action: 'cooldown', kind, waitMs: wait, reason: '冷却中，让位 watcher' };

  const text = kind === 'truncation'
    ? fillTemplate(cfg.continueText, {}) + '（上次回复疑似被截断，请接着已输出内容继续，不要重复）'
    : kind === 'empty'
      ? fillTemplate(cfg.continueText, {}) + '（上次回复为空，请重新给出完整回复）'
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
      // ZCode 引擎对 Stop decision:block 有 3 次硬上限（不可配置）。
      // 超过 3 次后引擎会静默丢弃 block，插件无法感知。
      // 这里用 min 兜底：hook 路径最多续跑 3 次，之后主动 give-up，
      // 留给 watcher 通过 --resume 突破 3 次限制（watcher 不受此约束）。
      maxHookRetries: Math.min(cfg.maxConsecutive, 3),
      loopGuardRepeats: cfg.loopGuardRepeats,
    });

    if (d.action === 'pass') {
      if (d.kind === 'normal' && (entry.consecutive > 0 || entry.repeats > 0)) {
        entry.consecutive = 0; entry.repeats = 0; entry.lastHash = ''; entry.stopped = false;
        writeState(state);
        log(`reset ${input.sessionId}: 回合正常结束`);
      } else if (d.kind === 'permanent') {
        entry.consecutive = 0; entry.stopped = true;
        writeState(state);
        record('skipped', d.kind);
        log(`skip ${input.sessionId}: ${d.reason}`);
      }
      return;
    }
    if (d.action === 'give-up') {
      entry.stopped = true;
      writeState(state);
      record('gaveUp');
      log(`give-up ${input.sessionId}: ${d.reason}`);
      return;
    }
    if (d.action === 'cooldown') {
      // 退避期间：放行，让 watcher 兜底。hook 不阻塞，避免 ZCode timeoutMs 杀死进程。
      log(`cooldown ${input.sessionId}: ${Math.round(d.waitMs / 1000)}s → 让位 watcher`);
      return;
    }

    // block 续跑：更新共享计数。
    entry.consecutive += 1;
    entry.lastAttemptAt = Date.now();
    entry.hookResumeAt = Date.now(); // watcher 去重：忽略同会话此刻后的 error 回合
    entry.lastHash = d.hash;
    entry.repeats = d.repeats;
    writeState(state);
    log(`block ${input.sessionId} #${entry.consecutive} kind=${d.kind} "${d.text.slice(0, 80)}"`);

    if (DRY) { log(`DRY-RUN: 不输出 block`); return; }
    record('sent', d.kind);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: d.text }));
  } catch (e) {
    log(`error ${input.sessionId}: ${e?.stack || e}`);
    // 任何异常都放行，绝不阻塞会话。
  }
}

main().catch(() => process.exit(0));
