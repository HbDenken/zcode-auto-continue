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
 *     hookTurnIds,           // Stop hook 已 block 续跑过的 turn_id（watcher 去重用）
 *     injectAt, injectConsumedAt, // watcher 注入标记 + 消费墓碑（见 consumeInjectMarker）
 *     indeterminate,          // 超时未确认的注入 {turnId, preSeq, at}（见 watcher 对账）
 *     indeterminateAt,        // indeterminate 的写入/清除时刻（墓碑，防旧快照复活）
 *   }},
 *   suppress: { sessionId, setAt } | null,  // 一次性豁免：下一次 Stop 放行并清除
 *   suppressClearedAt,       // 豁免的清除墓碑时刻（防旧快照复活）
 *   pausedUntil,             // TTL 暂停截止时间戳（到期自动恢复）
 *   pausedUntilSetAt,        // pausedUntil 的写入时刻：resume 写 0 也要生效（墓碑语义，同 suppress）
 * }
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = process.env.ZCODE_AC_STATE || join(homedir(), '.zcode', 'auto-continue');
export const STATE_PATH = join(STATE_DIR, 'state.json');

/**
 * 持久化失败告警：向 stderr 输出并尽力追加到 watcher.log。
 * writeState/writeStats 的写盘异常此前被 try/catch 完全吞掉——状态文件
 * 更新失败时系统"看起来在正常跑"，但水位/冷却/maxConsecutive 全部失效，
 * 可能重复注入、重复扣费却无任何痕迹。失败必须留痕。
 */
export function persistWarn(what, path, err) {
  const line = `[${new Date().toISOString()}] [persist] WARN 写盘失败 ${what} ${path}: ${err?.message || err}`;
  try { appendFileSync(join(STATE_DIR, 'watcher.log'), `${line}\n`); } catch {}
  console.error(line);
}

export function emptyState() {
  return { watermark: 0, watermarkSetAt: 0, sessions: {}, suppress: null, suppressClearedAt: 0, pausedUntil: 0, pausedUntilSetAt: 0 };
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
      pausedUntilSetAt: typeof raw.pausedUntilSetAt === 'number' ? raw.pausedUntilSetAt : 0,
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
  let firstErr = null;
  try {
    writeFileSync(tmp, payload);
    renameSync(tmp, path);
    return;
  } catch (e) {
    firstErr = e;
  }
  // Windows rename 偶发 EPERM（目标被读端打开），降级直写。
  try {
    writeFileSync(path, payload);
    // tmp 已被 rename 走；走到这里说明 rename 失败过，tmp 还在，清掉。
    rmSync(tmp, { force: true });
    return;
  } catch (e) {
    // 两次都失败：绝不能静默。状态文件写不进 → 水位/冷却/上限全部失效，
    // 会静默重复注入/重复扣费。必须留痕，否则无从诊断。
    // tmp 清理尽力而为：rename 失败后 tmp 一定还在，不清会在 STATE_DIR 累积（实测复现）。
    try { rmSync(tmp, { force: true }); } catch {}
    persistWarn('state.json', path, e || firstErr);
  }
}

/**
 * 防 lost-update：调用方内存里的副本可能比磁盘旧（watcher 读快照后跑完一轮
 * 才写盘，期间 Stop hook 已修改）。写盘前读盘，按字段取"更新的那份"：
 *   - 单调递增的时间戳取 max（lastAttemptAt/resetAt/pausedUntil）；
 *   - consecutive/stopped/lastHash/repeats/failedCount 取 <lastAttemptAt|resetAt>
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
    const stamp = (v) => Math.max(v.lastAttemptAt || 0, v.resetAt || 0);
    const newer = stamp(mine) >= stamp(theirs) ? mine : theirs;
    // 注入标记：injectAt 取 max；injectConsumedAt 是墓碑（UPS 钩子消费后写下），
    // 晚于 injectAt 即表示"已消费"，不再保留（防旧快照把已消费的标记复活，
    // 那会让下一条真人输入被误判成注入而跳过重置）。
    const injectAt = Math.max(mine.injectAt || 0, theirs.injectAt || 0);
    const injectConsumedAt = Math.max(mine.injectConsumedAt || 0, theirs.injectConsumedAt || 0);
    // 待对账的注入：按 indeterminateAt 取较新的一份（清除也是一种写入，需要墓碑语义，
    // 否则"已对账完成并清空"会被另一进程的旧快照复活，导致重复对账/重复注入）。
    const indMineAt = mine.indeterminateAt || 0;
    const indTheirsAt = theirs.indeterminateAt || 0;
    const indSrc = indMineAt >= indTheirsAt ? mine : theirs;
    sessions[id] = {
      consecutive: newer.consecutive || 0,
      lastAttemptAt: Math.max(mine.lastAttemptAt || 0, theirs.lastAttemptAt || 0),
      stopped: Boolean(newer.stopped),
      handled: [...new Set([...(theirs.handled || []), ...(mine.handled || [])])].slice(-50),
      lastHash: newer.lastHash || '',
      repeats: newer.repeats || 0,
      resetAt: Math.max(mine.resetAt || 0, theirs.resetAt || 0),
      failedCount: newer.failedCount || 0,
      injectAt: injectConsumedAt >= injectAt ? 0 : injectAt,
      injectConsumedAt,
      indeterminate: indSrc.indeterminate || null,
      indeterminateAt: Math.max(indMineAt, indTheirsAt),
      // hook 去重表取并集（两边都可能各自 block 过不同回合）。
      hookTurnIds: [...new Set([...(theirs.hookTurnIds || []), ...(mine.hookTurnIds || [])])].slice(-20),
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
  // pausedUntil 同样带墓碑：谁最近写过听谁的（相等时取 max）。
  // 旧实现只取 max 会让 resume 写的 0 被磁盘上的旧截止时间吞掉——定时暂停一旦设置
  // 就无法提前取消（实测复现）。写入方（user-prompt-submit 的 pause/resume）负责
  // 每次写 pausedUntil 时同步写 pausedUntilSetAt。
  const minePuAt = state.pausedUntilSetAt || 0;
  const theirsPuAt = disk.pausedUntilSetAt || 0;
  const pausedUntil = minePuAt > theirsPuAt
    ? (state.pausedUntil || 0)
    : minePuAt < theirsPuAt
      ? (disk.pausedUntil || 0)
      : Math.max(state.pausedUntil || 0, disk.pausedUntil || 0);
  return {
    watermark,
    watermarkSetAt: Math.max(mineWsAt, theirsWsAt),
    sessions,
    suppress: cleared ? null : (state.suppress || disk.suppress),
    suppressClearedAt: clearedAt,
    pausedUntil,
    pausedUntilSetAt: Math.max(minePuAt, theirsPuAt),
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
  // 待消费的注入标记同理：被裁掉会让 UPS 钩子读不到它、误判真人输入。
  const activeAt = (v) => Math.max(v.lastAttemptAt || 0, v.resetAt || 0, v.injectAt || 0, v.injectConsumedAt || 0, v.indeterminateAt || 0);
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
    lastHash: '', repeats: 0, resetAt: 0, failedCount: 0,
    injectAt: 0, injectConsumedAt: 0, hookTurnIds: [],
    indeterminate: null, indeterminateAt: 0,
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

/**
 * 消费注入标记：若本会话有一个未过期的 injectAt（watcher 刚用 --resume 注入过），
 * 则清掉它、写下 injectConsumedAt 墓碑，返回 true。
 *
 * 用途：--resume --prompt 注入会触发 UserPromptSubmit，钩子据此判定"这条输入
 * 是我自己注入的"，从而跳过"人工介入重置"（否则自动续跑会把自己的 consecutive
 * 清零，maxConsecutive 上限失效）。
 * 窗口用 injectMarkerMs：过期标记不消费，避免真人输入被陈旧标记误判。
 */
export function consumeInjectMarker(state, sessionId, windowMs) {
  const entry = state.sessions[sessionId];
  if (!entry || !entry.injectAt) return false;
  // 0/负值 = 关闭标记识别（与 stoppedRetryAfterMs 的"0 即关闭"语义一致）：
  // 若当成"永不过期"，陈旧标记会把真人输入误判成自己的注入，从而跳过人工重置。
  if (!(windowMs > 0)) return false;
  if (Date.now() - entry.injectAt > windowMs) return false;
  entry.injectAt = 0;
  entry.injectConsumedAt = Date.now();
  return true;
}
