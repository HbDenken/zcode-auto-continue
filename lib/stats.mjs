// @ts-check
/**
 * 当日统计读写：watcher（DB 轮询兜底）与 hooks/*（实时路径）共用。
 *
 * 缺陷修复：原实现只有 watcher.mjs 写 stats，Stop hook 这条实时主路径完全不记账——
 * 实测 2026-11-02 的 stats 全为 0，而当天 [stop] block 确有发生（watcher.log）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { todayKey, emptyDayStats } from './core.mjs';
import { STATE_DIR, persistWarn } from './state.mjs';

export function statsPath(dateKey = todayKey()) {
  return join(STATE_DIR, `stats-${dateKey}.json`);
}

export function readStats(path = statsPath()) {
  if (!existsSync(path)) return emptyDayStats();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { ...emptyDayStats(), ...raw, byCode: raw.byCode && typeof raw.byCode === 'object' ? raw.byCode : {} };
  } catch {
    return emptyDayStats();
  }
}

/**
 * 合并写盘：先读盘再按字段取 max，避免 lost-update。
 *
 * 缺陷修复：watcher 在轮询开头 readStats() 拿快照、末尾 writeStats() 整份覆盖，
 * 中间任何 hook 进程的 record() 都会丢。窗口不是毫秒级——写盘发生在
 * `await Promise.allSettled(pending)` 之后，有注入在飞时可达 injectTimeoutMs(120s)。
 * 实测：hook 记 skipped=1，被 watcher 的陈旧快照覆盖回 0。
 *
 * 取 max 而非相加：两侧都只从"当日累计快照"递增，同一决策不会被两个进程各记一次
 * （hook 与 watcher 对同一回合互斥），故 max 对"同一回合"是无损的；相加会把并发
 * 窗口里的重复读变成重复计数。
 *
 * 已知边界：两个【不同会话】的 hook 恰好在同一毫秒各记一次（各自 read→+1→write），
 * 后写者的 max 会吞掉前者的 +1。该窗口只有一次读盘的时长（<1ms），且不涉及重复计费，
 * 故不加锁（复杂度大于收益）；真正危险的 120s 级并发窗口由 max 合并解决。
 */
function mergeWithDisk(stats, path) {
  if (!existsSync(path)) return stats;
  const disk = readStats(path);
  const merged = { ...stats };
  for (const k of ['sent', 'delivered', 'skipped', 'recovered', 'failed', 'gaveUp']) {
    merged[k] = Math.max(Number(stats[k]) || 0, Number(disk[k]) || 0);
  }
  const byCode = { ...disk.byCode };
  for (const [code, n] of Object.entries(stats.byCode || {})) {
    byCode[code] = Math.max(Number(n) || 0, Number(byCode[code]) || 0);
  }
  merged.byCode = byCode;
  return merged;
}

export function writeStats(stats, path = statsPath()) {
  mkdirSync(STATE_DIR, { recursive: true });
  const payload = JSON.stringify(mergeWithDisk(stats, path), null, 2);
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
    // rename 失败后 tmp 还在，清掉（同 state.mjs，防 STATE_DIR 累积残留）。
    rmSync(tmp, { force: true });
    return;
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    persistWarn('stats.json', path, e || firstErr);
  }
}

/**
 * 记账一次决策。kind ∈ sent|skipped|recovered|failed|gaveUp，code 可选（错误码分布）。
 * 走读-改-写而非调用方持有的内存副本：hook 是短命进程，必须落盘才算数。
 */
export function record(kind, code) {
  const path = statsPath();
  const stats = readStats(path);
  if (typeof stats[kind] === 'number') stats[kind] += 1;
  if (code) stats.byCode[code] = (stats.byCode[code] || 0) + 1;
  writeStats(stats, path);
}
