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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveConfig,
  isTransientFailure,
  effectiveCooldown,
  fillTemplate,
  extractErrorFacts,
  sleep,
} from './core.mjs';
import { readState, writeState, sessionEntry, STATE_DIR } from './state.mjs';
import { readStats, writeStats } from './stats.mjs';

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

// ---- 只读 DB 访问（每次开只读连接，容忍并发写者）----

/** 取需评估的终态回合（error/cancelled/completed），限定新鲜窗口。
 * 排除已删除会话与 subagent 子会话：实测 266 个 error 回合中 40 个属于已删会话、
 * 11 个属于 subagent_child —— 对它们 --resume 必然以 code=1 失败（Session not found /
 * Select a model before sending a message），白跑一轮还拖慢轮询。
 */
function fetchTerminalTurns(sinceAt, freshMs) {
  const floor = Math.max(sinceAt, Date.now() - freshMs);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare(
      `SELECT t.session_id, t.turn_id, t.user_message_id, t.status, t.error_type, t.error_code,
              t.cancelled_by_user, t.context_exceeded, t.model_retry_count,
              t.completed_at, t.started_at
       FROM turn_usage t
       JOIN session s ON s.id = t.session_id
       WHERE t.completed_at IS NOT NULL AND t.completed_at > ? AND t.completed_at <= ?
         AND s.time_deleted IS NULL
         AND s.task_type = 'interactive'
       ORDER BY t.completed_at ASC LIMIT 200`
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

/** 读取该会话的原始工作目录与权限模式。
 * 权限模式必须沿用会话自身设置：原实现硬编码 `--mode yolo`，会把用户
 * 原本 build/plan 的会话自动提权为全自动无人值守（实测失败样本里就有 build 会话）。
 */
function fetchSessionMeta(db, sessionId) {
  try {
    const row = db.prepare('SELECT directory, path, permission FROM session WHERE id = ?').get(sessionId);
    if (!row) return { cwd: null, mode: null };
    let mode = null;
    try { mode = JSON.parse(row.permission || '{}')?.mode || null; } catch {}
    if (!['build', 'edit', 'plan', 'yolo', 'guarded'].includes(mode)) mode = null;
    return { cwd: row.directory || row.path || null, mode };
  } catch {
    return { cwd: null, mode: null };
  }
}

/** 经 CLI 注入续跑消息（非交互）。返回 {ok, code, timeout, stderr}。
 * 带超时保护：单个会话的注入挂起不能阻塞其他会话的轮询循环。
 * stderr 必须捕获：原实现用 stdio:'ignore' 丢弃了子进程输出，
 * 导致 code=1 的真实原因（Session not found / Select a model）在日志里完全不可见。
 */
function injectResume(cfg, sessionId, cwd, text, mode, timeoutMs = cfg.injectTimeoutMs) {
  return new Promise((resolve) => {
    if (DRY_RUN) return resolve({ ok: true, code: 0, dry: true, stderr: '' });
    const args = ['--resume', sessionId, '--prompt', text, '--json'];
    if (mode) args.push('--mode', mode);
    if (cwd) args.push('--cwd', cwd);
    const isCliJs = /\.(c|m)?js$/.test(ZCODE_BIN);
    const [cmd, argv] = isCliJs ? [process.execPath, [ZCODE_BIN, ...args]] : [ZCODE_BIN, args];
    let child;
    try {
      child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'], cwd: cwd || undefined, windowsHide: true });
    } catch {
      return resolve({ ok: false, code: -1, stderr: 'spawn threw' });
    }
    let stderr = '';
    child.stderr?.on('data', (b) => { if (stderr.length < 2000) stderr += String(b); });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve({ ok: false, code: -2, timeout: true, stderr });
    }, timeoutMs);
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stderr });
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stderr: e?.message || String(e) });
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
export function classifyTurn(cfg, turn, facts) {
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
    return { changed: false, injected: 0 };
  }
  const freshMs = 15 * 60 * 1000;
  // 首轮水位 = now - freshMs：只接管新鲜的事故，不翻旧账。
  if (!state.watermark) state.watermark = Date.now() - freshMs;

  const turns = fetchTerminalTurns(state.watermark, freshMs);
  if (turns.length === 0) return { changed: false, injected: 0 };

  // 本轮推进水位：只推进到【最终处理完】的回合；宽限/退避跳过的回合
  // 水位不动，下轮重新读它（否则该回合会被永久丢弃，永远无法续跑）。
  // 注意：退避是 per-session 的，而 turns 按 completed_at 全局升序，
  // 所以退避必须 continue 而不是 break——否则一个会话的退避会把后面
  // 所有会话的回合一起卡住（实测：sessA 退避 40s 期间 sessB 一次都没被处理）。
  let newWatermark = state.watermark;
  // 被推迟的回合中最早的 completed_at：循环后把水位夹回它之前，保证下轮重读。
  let deferredAt = null;
  let changed = false;
  // 待注入队列：状态先同步落定（consecutive/handled/水位），注入并发执行。
  // 原实现逐个 await，单个 5 分钟超时会把整轮轮询串行拖死。
  const pending = [];

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    for (const turn of turns) {
      const s = sessionEntry(state, turn.session_id);
      const before = `${s.consecutive}|${s.stopped}|${s.handled.length}|${state.watermark}`;

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

      // 自适应退避：未到冷却则该会话本轮跳过，水位夹回该回合之前 → 下轮重读。
      // 用 continue（非 break）：退避是 per-session 的，break 会连带卡住其他会话。
      const cooldown = effectiveCooldown(s.consecutive, cfg.cooldownMs, cfg.backoffFactor, cfg.backoffMaxMs);
      if (Date.now() - s.lastAttemptAt < cooldown) {
        log(cfg, `backoff ${turn.session_id}: wait ${Math.round((cooldown - (Date.now() - s.lastAttemptAt)) / 1000)}s`);
        deferredAt = deferredAt === null ? turn.completed_at : Math.min(deferredAt, turn.completed_at);
        continue;
      }

      const meta = fetchSessionMeta(db, turn.session_id);
      const text = pickContinueText(cfg, decision, s.consecutive + 1);
      s.consecutive += 1;
      s.lastAttemptAt = Date.now();
      s.handled.push(turn.turn_id); trimHandled(s);
      newWatermark = Math.max(newWatermark, turn.completed_at);
      log(cfg, `resume ${turn.session_id} #${s.consecutive} "${text}" (reason=${decision.reason}, mode=${meta.mode || 'default'})`);
      stats.sent++;
      pending.push(
        injectResume(cfg, turn.session_id, meta.cwd, text, meta.mode).then((res) => {
          if (res.ok) {
            log(cfg, `injected ok ${turn.session_id}`);
            return;
          }
          stats.failed++;
          const why = (res.stderr || '').trim().split('\n')[0].slice(0, 200);
          log(cfg, `inject failed ${turn.session_id} code=${res.code}${res.timeout ? ' (timeout)' : ''}${why ? ` stderr=${why}` : ''}`);
          // 注入失败可重试：原实现只加一个 `turn_id:failed` 标记，而该标记的唯一
          // 消费者（第 238 行的 includes）与普通标记等价 → 回合被永久放弃
          // （实测日志里 code=1/-2 失败十余次，stats 里 sent:9/failed:8 全被丢弃）。
          // 现在：摘掉 handled、回退 consecutive，并把水位夹回该回合之前让它被重读；
          // 用 failedCount 兜住上限，防止持续失败的会话无限重试。
          s.failedCount = (s.failedCount || 0) + 1;
          if (s.failedCount < cfg.maxConsecutive) {
            s.handled = s.handled.filter((h) => h !== turn.turn_id);
            s.consecutive = Math.max(0, s.consecutive - 1);
            deferredAt = deferredAt === null ? turn.completed_at : Math.min(deferredAt, turn.completed_at);
            changed = true;
            log(cfg, `retry queued ${turn.session_id} (attempt ${s.failedCount + 1}/${cfg.maxConsecutive})`);
          } else {
            s.handled.push(turn.turn_id + ':failed'); trimHandled(s);
            log(cfg, `give up injecting ${turn.session_id} after ${s.failedCount} failures`);
          }
        }),
      );

      const after = `${s.consecutive}|${s.stopped}|${s.handled.length}|${newWatermark}`;
      if (after !== before) changed = true;
    }
  } finally {
    db.close();
  }
  // 并发等待本轮全部注入结束，总耗时 = 最慢的一个，而非累加。
  if (pending.length) await Promise.allSettled(pending);
  // 有被推迟/需重试的回合：水位夹回最早的它之前，保证下轮重读。
  if (deferredAt !== null) newWatermark = Math.min(newWatermark, deferredAt - 1);
  if (newWatermark !== state.watermark) changed = true;
  state.watermark = newWatermark;
  // 标记这次水位是"本进程刚设的"：合并时按时间戳取较新的一份，
  // 否则 mergeWithDisk 的取 max 会把注入失败时的水位回退抹掉。
  // 只在真要落盘时才有意义（没问题时 state 不写盘，这个字段自然不持久化）。
  if (changed) state.watermarkSetAt = Date.now();
  return { changed, injected: pending.length };
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
    const stats = readStats();
    // 每轮重读共享 state：Stop hook 可能已更新 consecutive/hookResumeAt，
    // 保持内存副本会造成 lost-update 把 hook 的去重覆盖掉。
    const state = readState();
    let dirty = false;
    try {
      const r = await pollOnce(state, stats);
      dirty = r.changed || r.injected > 0;
    } catch (e) {
      console.warn('[auto-continue] poll error:', e?.message || e);
      dirty = true;
    }
    // 只在真有变化时落盘：空闲时每 5 秒重写 state.json + stats-*.json
    // （各含一次读盘合并）纯属无谓 IO。
    // 注入后必须写盘：若注入后崩溃且 state 未写，下次重启会丢水位。
    if (dirty) {
      writeState(state); // 内含 pruneSessions（24h/50 条）
      writeStats(stats);
    }
    await sleep(POLL_MS);
  }
}

// 仅在被直接执行时启动轮询循环；被 test 导入时只暴露 classifyTurn。
// 判定：argv[1] 与自身路径一致（Node 直接运行 ESM 时的标准做法）。
const isEntry = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === pathResolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntry) main();
