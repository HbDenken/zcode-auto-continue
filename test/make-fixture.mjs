#!/usr/bin/env node
// @ts-check
/**
 * 端到端验证用临时 DB fixture 生成器（README §5.2 引用的就是本文件）。
 *
 * 生成一个最小 schema 的 sqlite，覆盖 watcher 的全部分支：
 *   sess_t1  瞬时错误（upstream connection lost）      → 应续跑
 *   sess_t2  瞬时错误（Provider rate limited）          → 应续跑
 *   sess_p1  永久错误（Insufficient balance）           → 应跳过
 *   sess_c1  用户取消（cancelled_by_user=1）            → 不处理
 *   sess_d1  已删除会话的瞬时错误                       → SQL 层过滤，不出现
 *   sess_s1  subagent_child 的瞬时错误                  → SQL 层过滤，不出现
 *   sess_w1  瞬时错误，但回合内夹着宿主注入的 role=user 行（todo_reminder）
 *            → 只带 anchor.turnId，复现"窗口被提前关掉"的回归点
 *
 * 用法：node test/make-fixture.mjs [输出路径]
 * 默认输出到 ./tmp/fixture.sqlite，并打印路径供 ZCODE_DB 使用。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SCHEMA = `
CREATE TABLE session (
  id text primary key, project_id text not null, workspace_id text, parent_id text,
  slug text not null, directory text not null, path text, title text not null,
  version text not null, task_type text, permission text, time_deleted integer
);
CREATE TABLE message (
  id text primary key, session_id text not null, time_created integer not null,
  time_updated integer not null, data text not null, sequence integer
);
CREATE TABLE turn_usage (
  session_id text not null, turn_id text not null, user_message_id text,
  status text not null, started_at integer not null, completed_at integer,
  model_retry_count integer not null default 0, retryable integer not null default 0,
  cancelled_by_user integer not null default 0, context_exceeded integer not null default 0,
  error_type text, error_code text, primary key (session_id, turn_id)
);
`;

/** 带 error 的 assistant 消息。传 turnId 则带上 anchor.turnId（真实 ZCode 行为）。 */
function assistantWithError(id, sessionId, seq, message, code, turnId) {
  return {
    id, sessionId, seq,
    data: JSON.stringify({
      role: 'assistant',
      error: { name: 'AiSdkModelAdapterError', data: { message, code } },
      ...(turnId ? { anchor: { turnId } } : {}),
    }),
  };
}
function userRow(id, sessionId, seq) {
  return { id, sessionId, seq, data: JSON.stringify({ role: 'user' }) };
}
/** 宿主自己注入的 role=user 行（会截断窗口法），kind 取实测量值。 */
function injectedUserRow(id, sessionId, seq, kind) {
  return { id, sessionId, seq, data: JSON.stringify({ role: 'user', semantics: { origin: 'agent_runtime', kind } }) };
}

export function buildFixture(outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  rmSync(outPath, { force: true });
  const db = new DatabaseSync(outPath);
  db.exec(SCHEMA);

  const now = Date.now();
  const insSession = db.prepare(
    'INSERT INTO session (id, project_id, slug, directory, title, version, task_type, permission, time_deleted) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const insMsg = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)'
  );
  const insTurn = db.prepare(
    `INSERT INTO turn_usage (session_id, turn_id, user_message_id, status, started_at, completed_at,
       cancelled_by_user, context_exceeded, error_type, error_code) VALUES (?,?,?,?,?,?,?,?,?,?)`
  );

  // 每个会话：一条 user 消息 + 一条带 error 的 assistant 消息（同一 turn 窗口内）
  const cases = [
    { sid: 'sess_t1', status: 'error', err: 'upstream connection lost', code: 'STREAM', task: 'interactive', deleted: null, cancelled: 0 },
    { sid: 'sess_t2', status: 'error', err: 'Provider rate limited the model request.', code: 'RATE_LIMIT', task: 'interactive', deleted: null, cancelled: 0 },
    { sid: 'sess_p1', status: 'error', err: 'Insufficient balance. Please top up your account.', code: 'BALANCE', task: 'interactive', deleted: null, cancelled: 0 },
    { sid: 'sess_c1', status: 'cancelled', err: 'turn cancelled', code: 'TURN_CANCELLED', task: 'interactive', deleted: null, cancelled: 1 },
    { sid: 'sess_d1', status: 'error', err: 'upstream connection lost', code: 'STREAM', task: 'interactive', deleted: now, cancelled: 0 },
    { sid: 'sess_s1', status: 'error', err: 'upstream connection lost', code: 'STREAM', task: 'subagent_child', deleted: null, cancelled: 0 },
  ];

  for (const c of cases) {
    insSession.run(c.sid, 'proj_test', c.sid, 'K:\\test', c.sid, '0.17.1', c.task, JSON.stringify({ mode: 'yolo' }), c.deleted);
    insMsg.run(`um_${c.sid}`, c.sid, now - 2000, now - 2000, userRow('', '', 0).data, 1);
    const a = assistantWithError(`am_${c.sid}`, c.sid, 2, c.err, c.code);
    insMsg.run(a.id, c.sid, now - 1000, now - 1000, a.data, 2);
    insTurn.run(c.sid, `turn_${c.sid}`, `um_${c.sid}`, c.status, now - 5000, now - 3000, c.cancelled, 0, 'unknown_error', c.code);
  }

  // sess_w1：复现"窗口法被宿主注入的 role=user 行截断"，只有 anchor.turnId 能救回。
  // 结构：user(seq1) → assistant 工具调用(seq2) → injected todo_reminder(seq3) → error(seq4)
  // 窗口法在 seq3 处闭合，取不到 seq4 的 error；anchor 法直接命中 seq4。
  {
    const sid = 'sess_w1';
    const turnId = `turn_${sid}`;
    insSession.run(sid, 'proj_test', sid, 'K:\\test', sid, '0.17.1', 'interactive', JSON.stringify({ mode: 'yolo' }), null);
    insMsg.run(`um_${sid}`, sid, now - 4000, now - 4000, userRow('', '', 0).data, 1);
    const tool = { id: `am_tool_${sid}`, sessionId: sid, seq: 2, data: JSON.stringify({ role: 'assistant', finish: 'tool-calls', anchor: { turnId } }) };
    insMsg.run(tool.id, sid, now - 3000, now - 3000, tool.data, 2);
    const injected = injectedUserRow(`inj_${sid}`, sid, 3, 'todo_reminder');
    insMsg.run(injected.id, sid, now - 2500, now - 2500, injected.data, 3);
    const a = assistantWithError(`am_${sid}`, sid, 4, 'upstream connection lost', 'STREAM', turnId);
    insMsg.run(a.id, sid, now - 1000, now - 1000, a.data, 4);
    insTurn.run(sid, turnId, `um_${sid}`, 'error', now - 5000, now - 3000, 0, 0, 'unknown_error', 'STREAM');
  }

  db.close();
  return outPath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : join(root, 'tmp', 'fixture.sqlite');
  buildFixture(out);
  console.log(`fixture written: ${out}`);
  console.log('用法：');
  console.log(`  ZCODE_DB="${out}" ZCODE_AC_STATE=<空目录> ZCODE_AC_DRY_RUN=1 node lib/watcher.mjs`);
  console.log('预期：sess_t1/sess_t2/sess_w1 注入；sess_p1 跳过(permanent)；sess_c1 不处理；sess_d1/sess_s1 不出现。');
}
