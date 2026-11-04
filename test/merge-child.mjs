#!/usr/bin/env node
// @ts-check
/**
 * e2e-merge.mjs 的子进程：读状态 → 停顿（放大竞态窗口）→ 写回。
 * 用法：node test/merge-child.mjs <statePath> <sessionId> <handledMark> <delayMs>
 *
 * 刻意在"读"和"写"之间停顿，使两个并发子进程各自持有陈旧快照：
 * 若 writeState 的合并逻辑失效，后写者会把先写者的内容整体覆盖掉。
 */
import { readState, writeState, sessionEntry } from '../lib/state.mjs';

const [statePath, sessionId, mark, delayRaw] = process.argv.slice(2);
if (!statePath || !sessionId || !mark) {
  console.error('usage: merge-child.mjs <statePath> <sessionId> <mark> <delayMs>');
  process.exit(2);
}
const delayMs = Number(delayRaw) || 0;

const state = readState(statePath);
const entry = sessionEntry(state, sessionId);
entry.handled.push(mark);
entry.lastAttemptAt = Date.now();

// 读与写之间停顿：让另一个进程有机会在此之后、写回之前读到不含本条的磁盘状态。
await new Promise((r) => setTimeout(r, delayMs));

writeState(state, statePath);
console.log(`child ${sessionId} wrote ${mark}`);