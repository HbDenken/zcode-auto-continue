// @ts-check
/**
 * 当日统计读写：watcher（DB 轮询兜底）与 hooks/*（实时路径）共用。
 *
 * 缺陷修复：原实现只有 watcher.mjs 写 stats，Stop hook 这条实时主路径完全不记账——
 * 实测 2026-11-02 的 stats 全为 0，而当天 [stop] block 确有发生（watcher.log）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { todayKey, emptyDayStats } from './core.mjs';
import { STATE_DIR } from './state.mjs';

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

export function writeStats(stats, path = statsPath()) {
  mkdirSync(STATE_DIR, { recursive: true });
  const payload = JSON.stringify(stats, null, 2);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, payload);
    renameSync(tmp, path);
  } catch {
    try { writeFileSync(path, payload); } catch {}
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
