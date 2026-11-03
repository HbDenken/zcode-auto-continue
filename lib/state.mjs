// @ts-check
/**
 * 共享状态读写：watcher.mjs（轮询兜底）与 hooks/stop.mjs（实时主路径）
 * 共用 <STATE_DIR>/state.json 的会话计数/冷却/豁免标记，保证
 * maxConsecutive 上限对两条注入路径合并生效、互不重复注入。
 *
 * schema（向后兼容，缺字段取默认）：
 * {
 *   watermark,               // watcher 轮询水位
 *   sessions: { [sid]: {
 *     consecutive,           // 连续自动续跑次数（两条路径合并计数）
 *     lastAttemptAt,         // 上次注入时刻（冷却基准，两条路径共享）
 *     stopped,               // 达到上限后置 true（新错误回合不再续跑，completed 复位）
 *     handled: [],           // watcher 已处理的 turn_id 列表
 *     lastHash, repeats,     // 循环守卫：相同错误内容连续重复
 *     hookResumeAt,          // Stop hook 最近一次 block 续跑的时刻（watcher 去重用）
 *   }},
 *   suppress: { sessionId, setAt } | null,  // 一次性豁免：下一次 Stop 放行并清除
 *   pausedUntil,             // TTL 暂停截止时间戳（到期自动恢复）
 * }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = process.env.ZCODE_AC_STATE || join(homedir(), '.zcode', 'auto-continue');
export const STATE_PATH = join(STATE_DIR, 'state.json');

export function emptyState() {
  return { watermark: 0, watermarkSetAt: 0, sessions: {}, suppress: null, suppressClearedAt: 0, pausedUntil: 0 };
}

export function readState(path = STATE_PATH) {
  const fallback = emptyState();
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return {
      watermark: typeof raw.watermark === 'number' ? raw.watermark : 0,
      watermarkSetAt: typeof raw.watermarkSetAt === 'number' ? raw.watermarkSetAt : 0,
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      suppress: raw.suppress && raw.suppress.sessionId ? raw.suppress : null,
      suppressClearedAt: typeof raw.suppressClearedAt === 'number' ? raw.suppressClearedAt : 0,
      pausedUntil: typeof raw.pausedUntil === 'number' ? raw.pausedUntil : 0,
    };
  } catch {
    return fallback;
  }
}

export function writeState(state, path = STATE_PATH) {
  mkdirSync(STATE_DIR, { recursive: true });
  // 先合并（磁盘较新条目会进来）再裁剪，否则合并结果可能超 50 条。
  const payload = JSON.stringify(pruneTo(mergeWithDisk(state, path)), null, 2);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, payload);
    renameSync(tmp, path);
  } catch {
    // Windows rename 偶发 EPERM（目标被读端打开），降级直写。
    try { writeFileSync(path, payload); } catch {}
  }
}

/**
 * 防 lost-update：调用方内存里的副本可能比磁盘旧（watcher 读快照后跑完一轮
 * 才写盘，期间 Stop hook 已修改）。写盘前读盘，按字段取"更新的那份"：
 *   - 单调递增的时间戳取 max（lastAttemptAt/hookResumeAt/resetAt/pausedUntil）；
 *   - consecutive/stopped/lastHash/repeats/failedCount 取 <lastAttemptAt|hookResumeAt|resetAt>
 *     最大的那份（resetAt 入判据：人工重置不改 lastAttemptAt，旧判据会把重置吞掉，
 *     实测 consecutive 重置后又被合并回 3）；
 *   - watermark 按 watermarkSetAt 时间戳取较新的一份：watcher 注入失败时需要把
 *     水位【回退】以便重读该回合，若一律取 max 回退会被抹掉；
 *   - handled 取并集；
 *   - suppress 用墓碑语义：suppressClearedAt（清除意图的时间戳）晚于豁免的
 *     setAt 则视为已清除（防被旧快照复活），否则保留值（防丢新豁免）。
 */
function mergeWithDisk(state, path) {
  if (!existsSync(path)) return state;
  const disk = readState(path);
  const ids = new Set([...Object.keys(disk.sessions), ...Object.keys(state.sessions)]);
  const sessions = {};
  for (const id of ids) {
    const mine = state.sessions[id];
    const theirs = disk.sessions[id];
    if (!mine) { sessions[id] = theirs; continue; }
    if (!theirs) { sessions[id] = mine; continue; }
    const stamp = (v) => Math.max(v.lastAttemptAt || 0, v.hookResumeAt || 0, v.resetAt || 0);
    const newer = stamp(mine) >= stamp(theirs) ? mine : theirs;
    sessions[id] = {
      consecutive: newer.consecutive || 0,
      lastAttemptAt: Math.max(mine.lastAttemptAt || 0, theirs.lastAttemptAt || 0),
      stopped: Boolean(newer.stopped),
      handled: [...new Set([...(theirs.handled || []), ...(mine.handled || [])])].slice(-50),
      lastHash: newer.lastHash || '',
      repeats: newer.repeats || 0,
      hookResumeAt: Math.max(mine.hookResumeAt || 0, theirs.hookResumeAt || 0),
      resetAt: Math.max(mine.resetAt || 0, theirs.resetAt || 0),
      failedCount: newer.failedCount || 0,
    };
  }
  const clearedAt = Math.max(state.suppressClearedAt || 0, disk.suppressClearedAt || 0);
  const cleared = clearedAt > 0 &&
    ((state.suppress == null && clearedAt >= (disk.suppress?.setAt || 0)) ||
     (disk.suppress == null && clearedAt >= (state.suppress?.setAt || 0)));
  // 水位：谁最近主动设过听谁的（相等时取 max，保持单调推进的原有语义）。
  const mineWsAt = state.watermarkSetAt || 0;
  const theirsWsAt = disk.watermarkSetAt || 0;
  const watermark = mineWsAt > theirsWsAt
    ? (state.watermark || 0)
    : mineWsAt < theirsWsAt
      ? (disk.watermark || 0)
      : Math.max(state.watermark || 0, disk.watermark || 0);
  return {
    watermark,
    watermarkSetAt: Math.max(mineWsAt, theirsWsAt),
    sessions,
    suppress: cleared ? null : (state.suppress || disk.suppress),
    suppressClearedAt: clearedAt,
    pausedUntil: Math.max(state.pausedUntil || 0, disk.pausedUntil || 0),
  };
}

/** 状态清理：只保留 24h 内活跃的至多 50 个会话，防状态文件无限增长。 */
export function pruneSessions(state) {
  state.sessions = pruneTo(state).sessions;
}

function pruneTo(state) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  // resetAt 也算活跃依据：只被 watcher 触达（none/skip 分支从不写 lastAttemptAt）的
  // 会话，旧判据算出 activeAt=0，下一次写盘就被裁掉，连带丢掉 handled/stopped。
  const activeAt = (v) => Math.max(v.lastAttemptAt || 0, v.hookResumeAt || 0, v.resetAt || 0);
  return {
    ...state,
    sessions: Object.fromEntries(
      Object.entries(state.sessions || {})
        .filter(([, v]) => activeAt(v) >= cutoff)
        .sort((a, b) => activeAt(b[1]) - activeAt(a[1]))
        .slice(0, 50),
    ),
  };
}

/** 取/建会话条目（字段全初始化）。 */
export function sessionEntry(state, sessionId) {
  return (state.sessions[sessionId] ||= {
    consecutive: 0, lastAttemptAt: 0, stopped: false, handled: [],
    lastHash: '', repeats: 0, hookResumeAt: 0, resetAt: 0, failedCount: 0,
  });
}

/** 消费一次性豁免标记：命中本会话则清除并记下清除时刻（墓碑），返回 true。
 * 墓碑让 writeState 的合并知道"这是主动清除"，避免 watcher 旧快照把豁免复活。
 */
export function consumeSuppress(state, sessionId) {
  if (state.suppress && state.suppress.sessionId === sessionId) {
    state.suppress = null;
    state.suppressClearedAt = Date.now();
    return true;
  }
  return false;
}
