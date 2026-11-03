#!/usr/bin/env node
// @ts-check
/**
 * UserPromptSubmit hook：人工介入路径。
 *
 * 解决两个缺陷：
 *  1. state.json 的 suppress / pausedUntil 原先只读不写（死字段）——这里给出真实写入点；
 *  2. 人工提交新提示词时，原实现不重置连续计数（只有"回合正常结束"才重置），
 *     导致用户手动救活会话后，下一次偶发错误仍可能直接撞上续跑上限。
 *
 * 支持的命令（作为普通提示词提交即可，本 hook 在调模型前拦截并生效）：
 *   /auto-continue pause [30s|10m|2h]  → 暂停（无时长=长期暂停，写 config.json 的 paused）
 *   /auto-continue resume              → 恢复（清 paused / pausedUntil）
 *   /auto-continue skip-once           → 本轮结束后不自动续跑（一次性豁免）
 *
 * 除上述命令外，任何真实用户输入都会重置该会话的连续计数。
 * 任何异常静默放行，绝不阻塞用户输入。
 */
import { readState, writeState, sessionEntry, STATE_DIR } from '../lib/state.mjs';
import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_PATH = process.env.ZCODE_AC_CONFIG || join(STATE_DIR, 'config.json');

function log(msg) {
  try { appendFileSync(join(STATE_DIR, 'watcher.log'), `[${new Date().toISOString()}] [prompt] ${msg}\n`); } catch {}
}

function pick(obj, ...keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

/** 解析时长："30s" / "10m" / "2h" / 纯数字(视作分钟)；无参数返回 null。 */
export function parseDuration(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(raw).trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
  return n * factor;
}

/** 识别 /auto-continue 子命令。非命令返回 null。 */
export function parseCommand(prompt) {
  const m = /^\/auto-continue(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i.exec(String(prompt || '').trim());
  if (!m) return null;
  return { sub: (m[1] || 'status').toLowerCase(), arg: m[2] };
}

function setPausedFlag(value) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    let cfg = {};
    if (existsSync(CONFIG_PATH)) { try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {} }
    cfg.paused = value;
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch {}
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return; }
  const event = String(pick(input, 'hook_event_name', 'hookEventName') || '');
  if (event !== 'UserPromptSubmit') return;

  const sessionId = String(pick(input, 'session_id', 'sessionId') || 'unknown');
  const prompt = String(pick(input, 'prompt', 'userPrompt') ?? '');

  try {
    const state = readState();

    // 命令分支：不重置计数（命令是管理动作，不是继续任务）。
    const cmd = parseCommand(prompt);
    if (cmd) {
      if (cmd.sub === 'pause') {
        const ms = parseDuration(cmd.arg);
        if (Number.isNaN(ms)) {
          log(`pause: 时长无法解析 "${cmd.arg}"，忽略`);
          return;
        }
        if (ms === null) {
          setPausedFlag(true);
          state.pausedUntil = 0;
          log(`pause: 长期暂停（config.paused=true）`);
        } else {
          state.pausedUntil = Date.now() + ms;
          log(`pause: ${Math.round(ms / 1000)}s（到期自动恢复）`);
        }
        writeState(state);
        return;
      }
      if (cmd.sub === 'resume') {
        setPausedFlag(false);
        state.pausedUntil = 0;
        writeState(state);
        log('resume: 已清除 paused / pausedUntil');
        return;
      }
      if (cmd.sub === 'skip-once') {
        state.suppress = { sessionId, setAt: Date.now() };
        writeState(state);
        log(`skip-once: ${sessionId} 本轮结束后放行一次`);
        return;
      }
      return; // status/stats 交给命令文档处理，不动状态
    }

    // 人工介入：重置该会话的续跑计数与循环守卫（对齐参考实现的语义）。
    const existing = state.sessions[sessionId];
    if (existing && (existing.consecutive > 0 || existing.repeats > 0 || existing.stopped || existing.lastHash)) {
      const entry = sessionEntry(state, sessionId);
      entry.consecutive = 0;
      entry.repeats = 0;
      entry.lastHash = '';
      entry.stopped = false;
      entry.failedCount = 0;
      // 必须写 resetAt：重置不改 lastAttemptAt，而合并按时间戳取"较新那份"，
      // 没有这个时间戳时重置会被 watcher 的较新快照整份覆盖回去（实测复现：
      // 重置后 consecutive 又回到 3）。
      entry.resetAt = Date.now();
      writeState(state);
      log(`reset ${sessionId}: 人工提交新提示词`);
    }
  } catch (e) {
    log(`error ${sessionId}: ${e?.stack || e}`);
    // 任何异常都放行，绝不阻塞用户输入。
  }
}

main().catch(() => process.exit(0));
