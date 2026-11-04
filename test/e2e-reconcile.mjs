#!/usr/bin/env node
// @ts-check
/**
 * 端到端：注入超时（结果未知）的对账行为。运行：node test/e2e-reconcile.mjs
 *
 * 守住两条互斥的承诺，二者缺一不可：
 *   1) 动作【已送达】但本地超时 → 必须判定 delivered，**不得重试**（否则重复计费）
 *   2) 动作【未送达】且本地超时 → 必须判定 not-delivered，**重试但有界**（否则漏续跑/死循环）
 *
 * 只针对 fixture 库操作；mock CLI 在拿不到 ZCODE_DB 时拒绝执行，避免误碰真实会话库。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildFixture } from './make-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

/** 已受理并落库、但进程挂住不退出（模拟"远端在跑、本地超时"）。 */
const MOCK_DELIVERED = `
import { DatabaseSync } from 'node:sqlite';
const dbPath = process.env.ZCODE_DB;
if (!dbPath) { console.error('ZCODE_DB not set; refusing to touch real db'); process.exit(9); }
const sid = process.argv[process.argv.indexOf('--resume') + 1];
const db = new DatabaseSync(dbPath);
const max = db.prepare('SELECT COALESCE(MAX(sequence),0) m FROM message WHERE session_id=?').get(sid).m;
db.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data,sequence) VALUES (?,?,?,?,?,?)')
  .run('inj_'+Date.now(), sid, Date.now(), Date.now(),
    JSON.stringify({ role:'user', metadata:{ inputIntent:{ clientId:'cli' } } }), max+1);
db.close();
setTimeout(()=>{}, 3600000);
`;
/** 从未受理、进程挂住（模拟"确实没送达"）。 */
const MOCK_UNDELIVERED = `setTimeout(()=>{}, 3600000);\n`;

/** 已受理落库、随后以非 0 退出（模拟"CLI 先受理、后出错"）。 */
const MOCK_DELIVERED_THEN_NONZERO = `
import { DatabaseSync } from 'node:sqlite';
const dbPath = process.env.ZCODE_DB;
if (!dbPath) { console.error('ZCODE_DB not set; refusing to touch real db'); process.exit(9); }
const sid = process.argv[process.argv.indexOf('--resume') + 1];
const db = new DatabaseSync(dbPath);
const max = db.prepare('SELECT COALESCE(MAX(sequence),0) m FROM message WHERE session_id=?').get(sid).m;
db.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data,sequence) VALUES (?,?,?,?,?,?)')
  .run('inj_'+Date.now(), sid, Date.now(), Date.now(),
    JSON.stringify({ role:'user', metadata:{ inputIntent:{ clientId:'cli' } } }), max+1);
db.close();
process.exit(1);
`;

/** 立即成功退出（不落库），用于验证成功路径会清零 failedCount。 */
const MOCK_OK = `process.exit(0);\n`;
/** 立即失败且不落库（确定性"未送达"），用于验证重试上限。 */
const MOCK_DIE = `process.exit(1);\n`;

async function runScenario(label, mockSource, { waitMs = 20000, extraErrorTurn = false, cooldownMs = 100, preseed } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-e2e-rec-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'fixture.sqlite');
  buildFixture(dbPath);
  // fixture 的 directory 是占位值 K:\test，spawn 时 cwd 不存在会 ENOENT；改成本次临时目录
  {
    const d = new DatabaseSync(dbPath);
    d.prepare('UPDATE session SET directory = ?').run(dir);
    if (extraErrorTurn) {
      // 同一会话补第二个 error 回合：用于验证 per-session 在途互斥，
      // 防止同一会话在一轮里被并发注入两次（重复计费）。
      const now = Date.now();
      const turnId = 'turn_sess_t1_second';
      d.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data,sequence) VALUES (?,?,?,?,?,?)')
        .run('um2_sess_t1', 'sess_t1', now - 1500, now - 1500, JSON.stringify({ role: 'user', anchor: { turnId } }), 10);
      d.prepare('INSERT INTO message (id,session_id,time_created,time_updated,data,sequence) VALUES (?,?,?,?,?,?)')
        .run('am2_sess_t1', 'sess_t1', now - 1200, now - 1200,
          JSON.stringify({ role: 'assistant', anchor: { turnId }, error: { name: 'X', data: { message: 'upstream connection lost', code: 'STREAM' } } }), 11);
      d.prepare(`INSERT INTO turn_usage (session_id,turn_id,user_message_id,status,started_at,completed_at,cancelled_by_user,context_exceeded,error_type,error_code)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('sess_t1', turnId, 'um2_sess_t1', 'error', now - 2500, now - 1000, 0, 0, 'unknown_error', 'STREAM');
    }
    d.close();
  }
  const mockPath = join(dir, 'mock.mjs');
  writeFileSync(mockPath, mockSource);
  const cfgPath = join(dir, 'cfg.json');
  writeFileSync(cfgPath, JSON.stringify({
    verbose: true, graceMs: 0, cooldownMs, backoffFactor: 1,
    maxConsecutive: 3, injectTimeoutMs: 5000,
  }));
  const stateDir = join(dir, 'state');
  // 预置 state.json：用于模拟"上一轮遗留状态"（崩溃/重启后仍有未确认注入、或历史失败计数）。
  if (preseed) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
      watermark: 0, watermarkSetAt: 0, sessions: preseed, suppress: null, suppressClearedAt: 0, pausedUntil: 0,
    }));
  }

  const w = spawn(process.execPath, [join(root, 'lib', 'watcher.mjs')], {
    env: {
      ...process.env, ZCODE_DB: dbPath, ZCODE_AC_STATE: stateDir,
      ZCODE_AC_CONFIG: cfgPath, ZCODE_BIN: mockPath, ZCODE_AC_POLL_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  w.stdout.on('data', (b) => { out += b; });
  w.stderr.on('data', (b) => { out += b; });
  await new Promise((r) => setTimeout(r, waitMs));
  w.kill();
  await new Promise((r) => setTimeout(r, 600));

  const count = (re) => (out.match(re) || []).length;
  let state = null;
  const sp = join(stateDir, 'state.json');
  if (existsSync(sp)) state = JSON.parse(readFileSync(sp, 'utf8')).sessions || {};
  return {
    label, out, state,
    resumes: count(/resume sess_t1 /g),
    indeterminates: count(/indeterminate sess_t1/g),
    reconciledDelivered: count(/reconciled sess_t1: 上次注入已送达/g),
    reconciledUndelivered: count(/reconciled sess_t1: 上次注入未送达/g),
    giveUps: count(/give up injecting sess_t1/g),
    mutex: count(/mutex sess_/g),
  };
}

let n = 0;
const ok = (name) => { n++; console.log(`ok ${n} - ${name}`); };

// ---- 场景 1：已送达（落库）但本地超时 → 不得重试 ----
{
  const r = await runScenario('delivered', MOCK_DELIVERED);
  assert.equal(r.resumes, 1, `已送达时只能注入 1 次（否则重复计费），实际 ${r.resumes} 次\n` + r.out);
  assert.equal(r.state?.sess_t1?.handled?.includes('turn_sess_t1'), true, '应登记 handled 以防下轮重复');
  assert.equal(r.state?.sess_t1?.indeterminate, null, '对账后应清除在途记录');
  assert.equal(r.state?.sess_t1?.failedCount, 0, '已送达不应计入失败次数');
  ok('已送达但超时 → 确认已受理，只注入 1 次（不重复计费）');
}

// ---- 场景 2：未送达 + 超时 → 重试，但有界 ----
{
  const r = await runScenario('undelivered', MOCK_UNDELIVERED);
  assert.equal(r.resumes, 3, `重试应受 maxConsecutive=3 约束，实际 ${r.resumes} 次\n` + r.out);
  assert.equal(r.giveUps, 1, '达上限后应放弃且只放弃一次');
  assert.equal(r.state?.sess_t1?.handled?.includes('turn_sess_t1:failed'), true, '应登记 :failed 防重复');
  ok('未送达 + 超时 → 重试，上限 3 次后放弃（不死循环）');
}

// ---- 场景 3：同一会话两个 error 回合 → per-session 在途互斥，不得并发注入 ----
{
  // 冷却设为 0：否则第二个回合会被退避先拦住，测不到互斥这条路径。
  const r = await runScenario('mutex', MOCK_DELIVERED, { extraErrorTurn: true, cooldownMs: 0 });
  assert.ok(r.mutex >= 1, '同一会话的两个回合不得在同一轮并发注入（应命中互斥）\n' + r.out);
  // 两个回合各注入一次即止：第一个送达后不再重试，第二个轮到下一轮。
  assert.equal(r.resumes, 2, `两个回合应各注入 1 次（共 2 次），实际 ${r.resumes} 次\n` + r.out);
  ok('同一会话两个回合 → 命中在途互斥，各注入 1 次（不并发、不重复）');
}

// ---- 场景 4：已受理但以非 0 退出（非超时） → 同样不得重试 ----
// 回归 oracle H2：原实现只对超时做对账，这类"先受理后出错"会被当未送达重复注入。
{
  const r = await runScenario('delivered-then-nonzero', MOCK_DELIVERED_THEN_NONZERO, { waitMs: 6000 });
  assert.equal(r.resumes, 1, `已受理（非 0 退出）时不得重试，实际 ${r.resumes} 次\n` + r.out);
  assert.equal(r.state?.sess_t1?.handled?.includes('turn_sess_t1'), true, '应登记 handled');
  assert.equal(r.state?.sess_t1?.failedCount, 0, '不应计入失败次数');
  ok('已受理但非 0 退出 → 对账确认已送达，不重试（回归 H2：不只堵超时）');
}

// ---- 场景 5：遗留未确认记录属于【已不在窗口内的旧回合】时，不得吞掉新回合 ----
// 回归 oracle H1：原实现用当前 turn 推水位，会把同会话的新回合静默丢弃。
{
  const r = await runScenario('stale-ind', MOCK_OK, {
    waitMs: 6000,
    preseed: {
      sess_t1: {
        consecutive: 0, lastAttemptAt: 0, stopped: false, handled: [],
        lastHash: '', repeats: 0, resetAt: Date.now(), failedCount: 0,
        injectAt: 0, injectConsumedAt: Date.now(), hookTurnIds: [],
        // turnId 指向一个 fixture 里不存在的回合（模拟"该回合已掉出扫描窗口"）
        indeterminate: { turnId: 'turn_gone_forever', preSeq: 0, at: Date.now() },
        indeterminateAt: Date.now(),
      },
    },
  });
  assert.equal(r.resumes, 1, `旧回合的遗留记录不得导致新回合被吞掉，实际注入 ${r.resumes} 次\n` + r.out);
  assert.equal(r.state?.sess_t1?.handled?.includes('turn_sess_t1'), true, '新回合应被正常处理并登记');
  ok('遗留记录属于窗口外的旧回合时 → 新回合不被吞掉（回归 H1）');
}

// ---- 场景 6：成功路径必须清零 failedCount ----
// 回归 oracle M1：failedCount 曾只在 delivered 分支清零，会话会永久失去自动续跑能力。
{
  const r = await runScenario('reset-failedcount', MOCK_OK, {
    waitMs: 6000,
    preseed: {
      sess_t1: {
        consecutive: 0, lastAttemptAt: 0, stopped: false, handled: [],
        lastHash: '', repeats: 0, resetAt: Date.now(), failedCount: 2,
        injectAt: 0, injectConsumedAt: 0, hookTurnIds: [],
        indeterminate: null, indeterminateAt: 0,
      },
    },
  });
  assert.equal(r.resumes, 1, '应正常注入一次');
  assert.equal(r.state?.sess_t1?.failedCount, 0, `成功后 failedCount 必须清零，实际 ${r.state?.sess_t1?.failedCount}\n` + r.out);
  ok('注入成功后 failedCount 归零（回归 M1：否则会话会永久失去续跑能力）');
}

console.log(`\nAll ${n} scenarios passed.`);