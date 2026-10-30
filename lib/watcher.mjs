#!/usr/bin/env node
// @ts-check
/**
 * zcode-auto-continue 守护进程。
 *
 * 适配自 dsh-auto-continue 的 host 引擎模型，改为 ZCode 机制：
 *   - DSH:   引擎跑在 host 进程内，订阅 session/event，经 agent.followup 发送。
 *   - ZCode: 守护进程只读轮询 turn_usage 表，检测到 status='error' 且非用户
 *            取消的回合后，按错误分类 + 自适应退避，经
 *            `zcode --resume <sessionId> --prompt "继续"` 注入续跑消息。
 *
 * 状态与配置都在 ~/.zcode/auto-continue/：watcher.pid / state.json /
 * stats-<日期>.json / config.json（每次轮询热重载，paused 即时生效）。
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveConfig,
  isTransientFailure,
  effectiveCooldown,
  fillTemplate,
  extractErrorFacts,
  sleep,
  todayKey,
  emptyDayStats,
} from './core.mjs';
import { readState, writeState, sessionEntry, STATE_DIR } from './state.mjs';

const HOME = homedir();
const DB_PATH = process.env.ZCODE_DB || join(HOME, '.zcode', 'cli', 'db', 'db.sqlite');
const ZCODE_BIN = process.env.ZCODE_BIN || resolveZcodeBin();
const CONFIG_PATH = process.env.ZCODE_AC_CONFIG || join(STATE_DIR, 'config.json');
const DRY_RUN = process.env.ZCODE_AC_DRY_RUN === '1';
const POLL_MS = Number(process.env.ZCODE_AC_POLL_MS) || 5000;

function resolveZcodeBin() {
  // 优先环境变量；其次桌面版内置 CLI；最后 PATH 中的 zcode。
  const desktop = 'D:\\ZCode\\resources\\glm\\zcode.cjs';
  if (process.platform === 'win32' && existsSync(desktop)) return desktop;
  return 'zcode';
}

function loadConfig() {
  let raw = {};
  if (existsSync(CONFIG_PATH)) {
    try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  }
  return resolveConfig(raw);
}

function log(cfg, ...args) {
  if (cfg.verbose) console.log('[auto-continue]', ...args);
}

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, v) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(v, null, 2));
    renameSync(tmp, p);
  } catch {
    // Windows renameSync 在目标被打开时偶发 EPERM，降级直接写。
    try { writeFileSync(p, JSON.stringify(v, null, 2)); } catch {}
  }
}

// ---- 只读 DB 访问（每次开只读连接，容忍并发写者）----

/** 取需评估的终态回合（error/cancelled/completed），限定新鲜窗口。 */
function fetchTerminalTurns(sinceAt, freshMs) {
  const floor = Math.max(sinceAt, Date.now() - freshMs);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare(
      `SELECT session_id, turn_id, user_message_id, status, error_type, error_code,
              cancelled_by_user, context_exceeded, model_retry_count,
              completed_at, started_at
       FROM turn_usage
       WHERE completed_at IS NOT NULL AND completed_at > ? AND completed_at <= ?
       ORDER BY completed_at ASC LIMIT 200`
    ).all(floor, Date.now() - 500); // 末尾 500ms 容差避开正在写入的行
  } finally {
    db.close();
  }
}

/** 取该错误回合内的 error 载荷，作为失败事实。
 * 关联键：turn_usage.user_message_id → message.id（取 sequence 作为窗口起点）；
 * 错误回合的 assistant 消息即 sequence 落在 [起点, 下一用户消息起点) 区间内的 assistant 消息。
 * 这样按 turn 精确取 facts，不会误读其他回合的错误或把成功回合当作"无错误"而误注入。
 */
function fetchLastErrorFacts(db, turn) {
  try {
    if (!turn.user_message_id) return null;
    const startRow = db.prepare(`SELECT sequence FROM message WHERE id = ?`).get(turn.user_message_id);
    if (!startRow) return null;
    const startSeq = startRow.sequence;
    // 下一用户消息的 sequence 作为窗口上限（开区间）；若已是会话末尾，用一个大数兜底。
    const nextUser = db.prepare(
      `SELECT sequence FROM message
       WHERE session_id = ? AND sequence > ? AND json_extract(data, '$.role') = 'user'
       ORDER BY sequence ASC LIMIT 1`
    ).get(turn.session_id, startSeq);
    const endSeq = nextUser ? nextUser.sequence : Number.MAX_SAFE_INTEGER;
    // 取该窗口内最新的一条 assistant 消息（含 error）。
    const rows = db.prepare(
      `SELECT data FROM message
       WHERE session_id = ? AND sequence >= ? AND sequence < ?
       ORDER BY sequence DESC LIMIT 20`
    ).all(turn.session_id, startSeq, endSeq);
    return extractErrorFacts(rows.map(r => r.data));
  } catch {
    return null;
  }
}

function fetchSessionCwd(db, sessionId) {
  try {
    const row = db.prepare('SELECT directory, path FROM session WHERE id = ?').get(sessionId);
    return row?.directory || row?.path || null;
  } catch {
    return null;
  }
}

// ---- 注入 ----

/** 经 CLI 注入续跑消息（非交互）。返回 {ok, code, timeout}。
 * 带超时保护：单个会话的注入挂起不能阻塞其他会话的轮询循环。
 */
function injectResume(cfg, sessionId, cwd, text, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    if (DRY_RUN) return resolve({ ok: true, code: 0, dry: true });
    const args = ['--resume', sessionId, '--prompt', text, '--mode', 'yolo', '--json'];
    if (cwd) args.push('--cwd', cwd);
    const isCliJs = /\.(c|m)?js$/.test(ZCODE_BIN) || ZCODE_BIN.includes('zcode.cjs');
    const [cmd, argv] = isCliJs ? [process.execPath, [ZCODE_BIN, ...args]] : [ZCODE_BIN, args];
    let child;
    try {
      child = spawn(cmd, argv, { stdio: 'ignore', cwd: cwd || undefined, windowsHide: true });
    } catch {
      return resolve({ ok: false, code: -1 });
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve({ ok: false, code: -2, timeout: true });
    }, timeoutMs);
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1 });
    });
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1 });
    });
  });
}

// ---- 决策 ----

/**
 * 判定一个终态回合是否应触发自动续跑。对齐 DSH 语义：
 * - 用户取消(cancelled/cancelled_by_user) → 永不续跑（aborted）
 * - context_exceeded → 永久失败，跳过（对齐 max-tokens 不可恢复）
 * - error → 分类：临时 → 续跑；永久 → 跳过
 * - completed → 永不续跑（静默回合重启会与用户/系统消息竞态，
 *   且 DSH 的 silent 检测依赖事件流可见性判断，DB 无等价信号）
 */
function classifyTurn(cfg, turn, facts) {
  if (turn.cancelled_by_user || turn.status === 'cancelled') return { kind: 'none' };
  if (turn.context_exceeded) return { kind: 'skip', reason: 'context_exceeded' };
  if (turn.status === 'error') {
    // classify 关闭时跳过分类，直接续跑（用户明确表示对所有错误都重试）。
    if (!cfg.classify) return { kind: 'continue', reason: 'error' };
    // facts 为 null 意味着无法从 DB 提取错误载荷（DB schema 字段缺失/解析失败等）。
    // 保守处理：跳过，而非盲目续跑（否则永久性 auth/401 错误可能被错误续跑）。
    if (!facts) return { kind: 'skip', reason: 'unknowable_error', facts };
    if (!isTransientFailure(facts, cfg.retryableErrorPatterns)) {
      return { kind: 'skip', reason: 'permanent', facts };
    }
    return { kind: 'continue', reason: 'error', facts };
  }
  return { kind: 'none' };
}

function pickContinueText(cfg, decision, errorCount) {
  return fillTemplate(cfg.continueText, { facts: decision.facts, errorCount });
}

// ---- 主循环 ----

async function pollOnce(state, stats) {
  const cfg = loadConfig(); // 热重载：paused/文案改动即时生效
  if (cfg.paused || (state.pausedUntil && state.pausedUntil > Date.now())) {
    log(cfg, 'paused, skip scan');
    return;
  }
  const freshMs = 15 * 60 * 1000;
  // 首轮水位 = now - freshMs：只接管新鲜的事故，不翻旧账。
  if (!state.watermark) state.watermark = Date.now() - freshMs;

  const turns = fetchTerminalTurns(state.watermark, freshMs);
  if (turns.length === 0) return;

  // 本轮推进水位：只推进到【最终处理完】的回合；宽限/退避跳过的回合
  // 水位不动，下轮重新读它（否则该回合会被永久丢弃，永远无法续跑）。
  // 因 turns 按 completed_at 升序，遇到第一个需等待的回合即 break——后续回合
  // 只是晚一两个轮询周期，不会丢。
  let newWatermark = state.watermark;

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    for (const turn of turns) {
      const s = sessionEntry(state, turn.session_id);

      // 去重：同一 turn 只处理一次（尽力而为，进程重启后依赖水位 + handled）。
      if (s.handled.includes(turn.turn_id) || s.handled.includes(turn.turn_id + ':failed')) continue;

      // hook 去重：Stop hook 刚在本回合结束后 block 续跑过（hookResumeAt 晚于
      // 回合完成时间），watcher 不再重复注入；hook 已计入 consecutive。
      if (s.hookResumeAt && s.hookResumeAt >= turn.completed_at) {
        s.handled.push(turn.turn_id); trimHandled(s);
        newWatermark = Math.max(newWatermark, turn.completed_at);
        log(cfg, `skip ${turn.session_id}: Stop hook already resumed this turn`);
        continue;
      }

      // 宽限期：刚结束的回合等一等再动（对齐 graceMs）。水位不推进 → 下轮重读。
      if (Date.now() - turn.completed_at < cfg.graceMs) break;

      const facts = turn.status === 'error' ? fetchLastErrorFacts(db, turn) : null;
      const decision = classifyTurn(cfg, turn, facts);

      // 正常完成/用户取消：恢复计数，重置 stopped，推进水位。
      if (decision.kind === 'none') {
        if (turn.status === 'completed') {
          if (s.consecutive > 0) { stats.recovered++; log(cfg, `recovered ${turn.session_id}`); }
          s.consecutive = 0;
          s.stopped = false;
        }
        s.handled.push(turn.turn_id); trimHandled(s);
        newWatermark = Math.max(newWatermark, turn.completed_at);
        continue;
      }

      if (decision.kind === 'skip') {
        stats.skipped++;
        const code = decision.facts?.code || turn.error_code || decision.reason;
        stats.byCode[code] = (stats.byCode[code] || 0) + 1;
        s.consecutive = 0; // 永久失败：终止本串
        s.handled.push(turn.turn_id); trimHandled(s);
        newWatermark = Math.max(newWatermark, turn.completed_at);
        log(cfg, `skip ${turn.session_id} (${decision.reason}: ${decision.facts?.code || ''} ${decision.facts?.message?.slice(0, 80) || ''})`);
        continue;
      }

      // 连续上限：停止该会话的自动续跑（除非用户手动恢复），gaveUp 仅计一次。
      if (s.consecutive >= cfg.maxConsecutive) {
        if (!s.stopped) { stats.gaveUp++; s.stopped = true; }
        s.handled.push(turn.turn_id); trimHandled(s);
        newWatermark = Math.max(newWatermark, turn.completed_at);
        log(cfg, `stop ${turn.session_id}: ${s.consecutive} consecutive auto-continues`);
        continue;
      }

      // 自适应退避：未到冷却则本轮等待，水位不推进 → 下轮重读该回合。
      const cooldown = effectiveCooldown(s.consecutive, cfg.cooldownMs, cfg.backoffFactor, cfg.backoffMaxMs);
      if (Date.now() - s.lastAttemptAt < cooldown) {
        log(cfg, `backoff ${turn.session_id}: wait ${Math.round((cooldown - (Date.now() - s.lastAttemptAt)) / 1000)}s`);
        break;
      }

      const cwd = fetchSessionCwd(db, turn.session_id);
      const text = pickContinueText(cfg, decision, s.consecutive + 1);
      s.consecutive += 1;
      s.lastAttemptAt = Date.now();
      s.handled.push(turn.turn_id); trimHandled(s);
      newWatermark = Math.max(newWatermark, turn.completed_at);
      log(cfg, `resume ${turn.session_id} #${s.consecutive} "${text}" (reason=${decision.reason})`);
      stats.sent++;

      const res = await injectResume(cfg, turn.session_id, cwd, text);
      if (res.ok) {
        log(cfg, `injected ok ${turn.session_id}`);
      } else {
        stats.failed++;
        s.handled.push(turn.turn_id + ':failed'); trimHandled(s);
        log(cfg, `inject failed ${turn.session_id} code=${res.code}`);
      }
    }
  } finally {
    db.close();
  }
  state.watermark = newWatermark;
}

function trimHandled(s) {
  if (s.handled.length > 50) s.handled = s.handled.slice(-50);
}

/** 单实例守卫：若 pid 文件指向一个存活进程，说明已有 watcher 在运行，直接退出。 */
function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const pidFile = join(STATE_DIR, 'watcher.pid');
  // 单实例：已运行则退出，避免重复注入同一会话。
  // 注意排除自身 pid：hook 先写 pid 文件再启动本进程，读到的可能是自己。
  try {
    const oldPid = Number(readFileSync(pidFile, 'utf8'));
    if (oldPid !== process.pid && isRunning(oldPid)) {
      console.log(`[auto-continue] already running (pid ${oldPid}), exit`);
      return;
    }
  } catch {}
  writeFileSync(pidFile, String(process.pid));
  const cfg = loadConfig();
  log(cfg, `watching ${DB_PATH} poll=${POLL_MS}ms bin=${ZCODE_BIN} dry=${DRY_RUN}`);
  log(cfg, `cooldown=${cfg.cooldownMs}ms max=${cfg.maxConsecutive} factor=${cfg.backoffFactor} classify=${cfg.classify}`);
  for (;;) {
    const statsPath = join(STATE_DIR, `stats-${todayKey()}.json`);
    const stats = readJson(statsPath, emptyDayStats());
    // 每轮重读共享 state：Stop hook 可能已更新 consecutive/hookResumeAt，
    // 保持内存副本会造成 lost-update 把 hook 的去重覆盖掉。
    const state = readState();
    try {
      await pollOnce(state, stats);
    } catch (e) {
      console.warn('[auto-continue] poll error:', e?.message || e);
    }
    // 每轮落盘：注入是子进程一次性动作，若注入后崩溃且 state 未写，
    // 下次重启会丢水位；写盘比崩溃去重更重要（handled + 水位共同去重）。
    writeState(state); // 内含 pruneSessions（24h/50 条）
    writeJson(statsPath, stats);
    await sleep(POLL_MS);
  }
}

main();
