#!/usr/bin/env node
// @ts-check
/**
 * 跨进程状态合并的竞态验证。运行：node test/e2e-merge.mjs
 *
 * 背景：writeState 是"读盘 → 合并 → 原子替换"，没有文件锁。两个 watcher 进程
 * （或 watcher + 钩子）可能同时持有一份快照各自写回。既有的 self-check 只用
 * "磁盘 + 陈旧内存副本"在同一进程里模拟，测不到真实的并发交错。
 *
 * 本脚本起两个真实子进程，各自 readState → 停顿（放大竞态窗口）→ writeState，
 * 验证：
 *   1) 不同会话的写入互不丢失；
 *   2) 同一会话的 handled 取并集，不丢任何一边。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = join(root, 'test', 'merge-child.mjs');
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

/** 起一个子进程：读→停顿→写。返回 Promise<{code, out}>。 */
function runChild(statePath, sessionId, mark, delayMs) {
  return new Promise((res) => {
    const c = spawn(process.execPath, [CHILD, statePath, sessionId, mark, String(delayMs)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { out += b; });
    c.on('close', (code) => res({ code, out }));
  });
}

function freshStatePath() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-merge-e2e-'));
  tmpDirs.push(dir);
  const p = join(dir, 'state.json');
  writeFileSync(p, JSON.stringify({
    watermark: 0, watermarkSetAt: 0, sessions: {}, suppress: null, suppressClearedAt: 0, pausedUntil: 0,
  }));
  return p;
}

let n = 0;
const ok = (name) => { n++; console.log(`ok ${n} - ${name}`); };

// ---- 场景 1：不同会话并发写，互不覆盖 ----
{
  const p = freshStatePath();
  // A 先读（早写），B 后读（晚写）——B 的快照里没有 A 的会话，
  // 若合并缺失，B 的写回会把 A 整个抹掉。
  const [a, b] = await Promise.all([
    runChild(p, 'sess_A', 'turn_A', 150),
    runChild(p, 'sess_B', 'turn_B', 400),
  ]);
  assert.equal(a.code, 0, '子进程 A 应正常退出\n' + a.out);
  assert.equal(b.code, 0, '子进程 B 应正常退出\n' + b.out);
  const st = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(st.sessions.sess_A, 'A 的会话被 B 的写回覆盖（合并失效）');
  assert.ok(st.sessions.sess_B, 'B 的会话应存在');
  assert.deepEqual(st.sessions.sess_A.handled, ['turn_A']);
  ok('两个进程并发写不同会话 → 互不丢失（合并生效）');
}

// ---- 场景 2：同一会话并发写，handled 取并集 ----
{
  const p = freshStatePath();
  const [a, b] = await Promise.all([
    runChild(p, 'sess_X', 'turn_X1', 150),
    runChild(p, 'sess_X', 'turn_X2', 400),
  ]);
  assert.equal(a.code, 0, '子进程 A 应正常退出\n' + a.out);
  assert.equal(b.code, 0, '子进程 B 应正常退出\n' + b.out);
  const st = JSON.parse(readFileSync(p, 'utf8'));
  const handled = st.sessions.sess_X.handled.slice().sort();
  assert.deepEqual(handled, ['turn_X1', 'turn_X2'], `两个进程的 handled 应取并集，实际 ${JSON.stringify(handled)}`);
  ok('同一会话并发写 → handled 取并集（不丢更新）');
}

console.log(`\nAll ${n} scenarios passed.`);