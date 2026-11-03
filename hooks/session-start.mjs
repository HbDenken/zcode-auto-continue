#!/usr/bin/env node
// @ts-check
/**
 * SessionStart hook: 确保 auto-continue 守护进程在运行。
 *
 * 读取 stdin JSON（hook 协议），从环境取 ZCODE_PLUGIN_ROOT。
 * 若守护进程未运行（无 pid 文件或进程已死），spawn 一个 detached
 * 的 watcher 进程，然后 hook 立即退出——不阻塞会话启动。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 插件根自定位：hook 文件位于 <root>/hooks/session-start.mjs，
// 由自身路径推导，不依赖 ZCODE_PLUGIN_ROOT 环境变量（环境变量在某些宿主下不注入）。
const PLUGIN_ROOT = process.env.ZCODE_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT ||
  join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.ZCODE_AC_STATE || join(homedir(), '.zcode', 'auto-continue');
const PID_FILE = join(STATE_DIR, 'watcher.pid');

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureWatcher() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(PID_FILE)) {
    try {
      const pid = Number(readFileSync(PID_FILE, 'utf8'));
      if (isRunning(pid)) return { status: 'already-running', pid };
    } catch {}
  }
  const watcher = join(PLUGIN_ROOT, 'lib', 'watcher.mjs');
  if (!existsSync(watcher)) return { status: 'no-watcher' };
  // watcher 输出（含崩溃原因）追加到 watcher.log，便于诊断 hook 拉起后的死因。
  const logFd = (() => {
    try { return openSync(join(STATE_DIR, 'watcher.log'), 'a'); } catch { return 'ignore'; }
  })();
  let child;
  try {
    child = spawn(process.execPath, [watcher], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    return { status: 'error', message: e?.message || String(e) };
  }
  // 不在 hook 侧写 pid 文件：watcher 自己用独占创建（wx）抢锁决定谁是唯一实例。
  // 原实现在这里无条件写 pid，两个并发 SessionStart 会各自 spawn 一个 watcher
  // 并互相覆盖 pid，两个 watcher 同时轮询 → 同一回合被注入两次（重复扣费）。
  // hook 只负责"拉起"，pid 归属由 watcher 自己仲裁。
  return { status: 'started', pid: child.pid };
}

async function main() {
  let input = '';
  let event = {};
  try {
    for await (const chunk of process.stdin) input += chunk.toString();
    event = JSON.parse(input);
  } catch {}
  const result = ensureWatcher();
  const sessionId = event.session_id || event.sessionId || '';
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `[auto-continue] 守护进程：${result.status}${result.pid ? ` (pid ${result.pid})` : ''}` +
          `。会话 ${sessionId} 若在中途被非人为中断，将自动续跑。` +
          `配置：~/.zcode/auto-continue/config.json；统计：~/.zcode/auto-continue/stats-<日期>.json。`,
      },
    }),
  );
}

main();
