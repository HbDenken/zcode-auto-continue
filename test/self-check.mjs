// @ts-check
/**
 * 核心逻辑自检（assert-based，无框架）。运行：node test/self-check.mjs
 */
import assert from 'node:assert/strict';
import {
  resolveConfig,
  isTransientFailure,
  effectiveCooldown,
  fillTemplate,
  extractErrorFacts,
  todayKey,
  emptyDayStats,
  classifyText,
  classifyTruncation,
  loopGuardHash,
} from '../lib/core.mjs';
import { readState, writeState, sessionEntry, consumeSuppress, emptyState, pruneSessions, STATE_DIR } from '../lib/state.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeInput, decide } from '../hooks/stop.mjs';
import { parseDuration, parseCommand } from '../hooks/user-prompt-submit.mjs';
import { classifyTurn } from '../lib/watcher.mjs';

let n = 0;
function t(name, fn) {
  fn();
  n++;
  console.log(`ok ${n} - ${name}`);
}

/** 写一个临时 transcript JSONL，返回路径（调用方负责 unlinkSync）。 */
let trSeq = 0;
function writeTranscript(entries) {
  const p = join(tmpdir(), `ac-selfcheck-${process.pid}-${trSeq++}.jsonl`);
  writeFileSync(p, entries.map((e) => JSON.stringify({ message: e })).join('\n'));
  return p;
}

// ---- resolveConfig ----
t('resolveConfig defaults', () => {
  const c = resolveConfig({});
  assert.equal(c.locale, 'zh');
  assert.equal(c.continueText, '继续');
  assert.equal(c.cooldownMs, 20000);
  assert.equal(c.maxConsecutive, 3);
  assert.equal(c.backoffFactor, 2);
  assert.equal(c.backoffMaxMs, 300000);
  assert.equal(c.classify, true);
});
t('resolveConfig en locale', () => {
  const c = resolveConfig({ locale: 'en' });
  assert.equal(c.continueText, 'Continue');
});
t('resolveConfig overrides + invalid values fall back', () => {
  const c = resolveConfig({
    cooldownMs: 5000, maxConsecutive: 5, backoffFactor: 3,
    graceMs: -1, locale: 'fr', continueText: 'go on',
  });
  assert.equal(c.cooldownMs, 5000);
  assert.equal(c.maxConsecutive, 5);
  assert.equal(c.backoffFactor, 3);
  assert.equal(c.graceMs, 3000);       // 负数回退默认
  assert.equal(c.locale, 'zh');        // 未知 locale 回退
  assert.equal(c.continueText, 'go on');
});

// ---- isTransientFailure ----
t('transient: network/timeout/5xx/429', () => {
  for (const f of [
    { code: 'ECONNRESET', message: 'socket hang up' },
    { code: 'ETIMEDOUT', message: 'request timed out after 30s' },
    { code: 'http_error', status: 502, message: 'bad gateway' },
    { code: 'rate_limit', status: 429, message: 'too many requests' },
    { code: 'server_error', status: 500, message: 'internal server error' },
  ]) assert.equal(isTransientFailure(f), true, JSON.stringify(f));
});
t('permanent: auth/401/403', () => {
  for (const f of [
    { code: 'auth_error', message: 'unauthorized: invalid api key' },
    { code: 'permission', status: 403, message: 'forbidden' },
    { code: 'auth', status: 401, message: '' },
  ]) assert.equal(isTransientFailure(f), false, JSON.stringify(f));
});
t('permanent: balance/quota/model-not-found', () => {
  for (const f of [
    { code: 'billing', message: 'insufficient balance' },
    { code: 'quota', message: 'quota exceeded for project' },
    { code: 'model', message: "model 'gpt-99' does not exist" },
    { code: 'model', message: 'unknown model gpt-99' },
    { code: 'model', message: 'no model found matching id' },
  ]) assert.equal(isTransientFailure(f), false, JSON.stringify(f));
});
t('permanent: context length exceeded', () => {
  assert.equal(
    isTransientFailure({ code: 'model_request_failed', message: "The input (324670 tokens) is longer than the model's context length (262144 tokens)." }),
    false,
  );
});
t('user patterns override builtin classification', () => {
  // 内置判为永久，但用户声明可重试。
  assert.equal(isTransientFailure({ code: 'auth', message: 'unauthorized' }, 'unauthorized'), true);
  // 内置判为临时，但用户声明不可重试——不支持负向排除（与上游一致，仅正向覆盖）。
});
t('status 401/403 hard-fails even with odd message', () => {
  assert.equal(isTransientFailure({ code: 'x', status: 401, message: 'whatever' }), false);
  assert.equal(isTransientFailure({ code: 'x', status: 403, message: 'whatever' }), false);
});

// ---- effectiveCooldown ----
t('backoff: base -> factor^n -> cap', () => {
  assert.equal(effectiveCooldown(0, 20000, 2, 300000), 20000);
  assert.equal(effectiveCooldown(1, 20000, 2, 300000), 40000);
  assert.equal(effectiveCooldown(2, 20000, 2, 300000), 80000);
  assert.equal(effectiveCooldown(3, 20000, 2, 300000), 160000);
  assert.equal(effectiveCooldown(4, 20000, 2, 300000), 300000); // capped
  assert.equal(effectiveCooldown(10, 20000, 2, 300000), 300000);
});
t('backoff: max < base clamps to base', () => {
  assert.equal(effectiveCooldown(5, 20000, 2, 5000), 20000);
});

// ---- fillTemplate ----
t('template placeholders', () => {
  const out = fillTemplate('继续 ({code} {status}): {message} | tool={tool} turn={turn} n={errorCount} title={sessionTitle}', {
    facts: { code: 'ECONNRESET', message: 'conn reset', status: 502 },
    tool: 'Bash', turn: 'turn_1', errorCount: 2, sessionTitle: 'fix bug',
  });
  assert.equal(out, '继续 (ECONNRESET 502): conn reset | tool=Bash turn=turn_1 n=2 title=fix bug');
});
t('template unknown placeholders vanish', () => {
  assert.equal(fillTemplate('a {nope} b {code}', { facts: { code: 'X' } }), 'a  b X');
});

// ---- extractErrorFacts ----
t('extractErrorFacts: returns error from latest assistant message', () => {
  const rows = [
    JSON.stringify({ role: 'user', content: 'hi' }),
    JSON.stringify({ role: 'assistant', error: { name: 'AiSdkModelAdapterError', data: { code: 'model_request_failed', message: "The input (324670 tokens) is longer than the model's context length (262144 tokens)." } } }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], tokens: {} }),
  ];
  const f = extractErrorFacts(rows);
  assert.equal(f.code, 'model_request_failed');
  assert.equal(f.message.includes('context length'), true);
  assert.equal(f.status, undefined);
});
t('extractErrorFacts: returns null when no error on latest assistant', () => {
  const rows = [
    JSON.stringify({ role: 'user', content: 'hi' }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }),
  ];
  assert.equal(extractErrorFacts(rows), null);
});
t('extractErrorFacts: skips non-assistant rows, finds error deeper', () => {
  const rows = [
    JSON.stringify({ role: 'user', content: 'continue' }),
    JSON.stringify({ role: 'assistant', error: { name: 'TimeoutError', data: { code: 'ETIMEDOUT', message: 'request timed out after 30s' } } }),
  ];
  const f = extractErrorFacts(rows);
  assert.equal(f.code, 'ETIMEDOUT');
});
t('extractErrorFacts: extracts HTTP status from message', () => {
  const rows = [JSON.stringify({ role: 'assistant', error: { data: { code: 'http_error', message: 'HTTP 502 Bad Gateway' } } })];
  assert.equal(extractErrorFacts(rows).status, 502);
});
t('extractErrorFacts: does not misparse "4096 tokens" as HTTP 409', () => {
  const rows = [JSON.stringify({ role: 'assistant', error: { data: { code: 'model_error', message: 'The input (4096 tokens) is too long' } } })];
  assert.equal(extractErrorFacts(rows).status, undefined);
});
t('extractErrorFacts: still catches loose 401/503', () => {
  const rows1 = [JSON.stringify({ role: 'assistant', error: { data: { code: 'auth', message: 'got 401 from upstream' } } })];
  assert.equal(extractErrorFacts(rows1).status, 401);
  const rows2 = [JSON.stringify({ role: 'assistant', error: { data: { code: 'err', message: 'HTTP 503' } } })];
  assert.equal(extractErrorFacts(rows2).status, 503);
});
t('extractErrorFacts: malformed JSON rows skipped', () => {
  const rows = ['not json', JSON.stringify({ role: 'assistant', error: { data: { code: 'ECONNRESET' } } })];
  assert.equal(extractErrorFacts(rows).code, 'ECONNRESET');
});

// ---- misc ----
t('todayKey format', () => {
  assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/);
});
t('emptyDayStats shape', () => {
  const s = emptyDayStats();
  assert.equal(s.sent, 0); assert.equal(s.skipped, 0); assert.equal(s.recovered, 0);
  assert.equal(s.failed, 0); assert.equal(s.gaveUp, 0);
  assert.deepEqual(s.byCode, {});
});

// ---- classifyText ----
t('classifyText: transient 系统繁忙', () => {
  assert.equal(classifyText('当前系统繁忙，请稍后再试'), 'transient');
});
t('classifyText: transient 429/5xx', () => {
  assert.equal(classifyText('rate limit: too many requests'), 'transient');
  assert.equal(classifyText('HTTP 502 Bad Gateway'), 'transient');
});
t('classifyText: permanent 余额不足', () => {
  assert.equal(classifyText('insufficient balance'), 'permanent');
  assert.equal(classifyText('model not found: gpt-99'), 'permanent');
});
t('classifyText: long message with error tail', () => {
  const long = 'x'.repeat(600) + '\n当前系统繁忙';
  assert.equal(classifyText(long), 'transient');
});
t('classifyText: long message normal answer → null', () => {
  const long = '系统繁忙是一个常见问题，我们可以通过优化来解决。' + 'x'.repeat(500);
  assert.equal(classifyText(long), null);
});
t('classifyText: short banner shortcut', () => {
  // ≤ bannerMaxLength(80) 视为纯错误横幅，直接判 transient。
  assert.equal(classifyText('当前系统繁忙，请稍后再试。'), 'transient');
});
t('classifyText: mid-length discussion low coverage → null', () => {
  // 80~500 字符区间靠覆盖率防护：正常回答仅顺带提到错误关键词不误判。
  const msg = '关于系统繁忙的问题，我认为可以从架构层面优化，通过增加缓存、负载均衡和限流来缓解，' +
    '同时建议监控告警、排查慢查询、优化连接池配置，避免高峰期出现大量排队等待的请求积压。';
  assert.ok(msg.length > 80 && msg.length <= 500);
  assert.equal(classifyText(msg), null);
});
t('classifyText: mid-length with dense error banner → transient', () => {
  const msg = '服务端返回：HTTP 503 Service Unavailable，当前系统繁忙，请稍后再试，服务繁忙，请稍后重试，' +
    'upstream overloaded，request failed，请求失败，网络连接中断，internal server error，稍后重试，server busy。';
  assert.ok(msg.length > 80 && msg.length <= 500);
  assert.equal(classifyText(msg), 'transient');
});
t('classifyText: empty → null', () => {
  assert.equal(classifyText(''), null);
  assert.equal(classifyText('   '), null);
});

// ---- classifyTruncation ----
t('classifyTruncation: unclosed code fence', () => {
  assert.equal(classifyTruncation('x'.repeat(300) + '\n```js\nconst x = 1;'), 'truncation');
});
t('classifyTruncation: trailing ellipsis', () => {
  assert.equal(classifyTruncation('x'.repeat(300) + '...'), 'truncation');
});
t('classifyTruncation: too short → null', () => {
  assert.equal(classifyTruncation('short```'), null);
});
t('classifyTruncation: balanced fences → null', () => {
  assert.equal(classifyTruncation('x'.repeat(300) + '```code```\nmore'), null);
});
t('classifyTruncation: dangling 【 (open bracket) → truncation', () => {
  assert.equal(classifyTruncation('x'.repeat(300) + '\n详见下文【'), 'truncation');
});
t('classifyTruncation: closing 】 not flagged (regression: was误判 before fix)', () => {
  // 修复前 ]被错放在开括号字符集里，正常以】结尾的句子会被误判截断。
  assert.equal(classifyTruncation('x'.repeat(300) + '详见文档【附录A】'), null);
});

// ---- loopGuardHash ----
t('loopGuardHash: deterministic + length capped', () => {
  const h = loopGuardHash('error text');
  assert.equal(h, loopGuardHash('error text'));
  assert.ok(h.length <= 64);
  assert.notEqual(h, loopGuardHash('different text'));
});

// ---- state.mjs ----
t('state: emptyState shape', () => {
  const s = emptyState();
  assert.equal(s.watermark, 0);
  assert.deepEqual(s.sessions, {});
  assert.equal(s.suppress, null);
  assert.equal(s.suppressClearedAt, 0);
  assert.equal(s.pausedUntil, 0);
});
t('state: sessionEntry initializes all fields', () => {
  const s = emptyState();
  const e = sessionEntry(s, 'sess-1');
  assert.equal(e.consecutive, 0);
  assert.equal(e.lastAttemptAt, 0);
  assert.equal(e.stopped, false);
  assert.equal(e.handled.length, 0);
  assert.equal(e.lastHash, '');
  assert.equal(e.repeats, 0);
  assert.equal(e.hookResumeAt, 0);
  assert.strictEqual(sessionEntry(s, 'sess-1'), e); // 幂等：同一对象
});
t('state: consumeSuppress one-shot', () => {
  const s = emptyState();
  s.suppress = { sessionId: 'sess-1', setAt: Date.now() };
  assert.equal(consumeSuppress(s, 'sess-1'), true);
  assert.equal(s.suppress, null);
  assert.equal(consumeSuppress(s, 'sess-1'), false); // 已消费
});
t('state: pruneSessions removes old + caps 50', () => {
  const s = emptyState();
  s.sessions['old'] = { consecutive: 0, lastAttemptAt: 0, hookResumeAt: 0 };
  s.sessions['recent'] = { consecutive: 1, lastAttemptAt: Date.now(), hookResumeAt: 0 };
  pruneSessions(s);
  assert.ok(!s.sessions['old']);
  assert.ok(s.sessions['recent']);
});
t('state: writeState merges (no lost-update)', () => {
  const path = `${STATE_DIR}\\state-test-${process.pid}.json`; // append pid to avoid polluting real state
  const now = Date.now();
  // 磁盘上有 hook 写入的较新 hookResumeAt
  const disk = emptyState();
  disk.sessions['sess-a'] = { consecutive: 1, lastAttemptAt: now, handled: ['t1'], lastHash: '', repeats: 0, stopped: false, hookResumeAt: now + 111 };
  writeState(disk, path);
  // 内存副本较旧——模拟 watcher 的快照
  const stale = emptyState();
  stale.sessions['sess-a'] = { consecutive: 1, lastAttemptAt: now, handled: ['t1'], lastHash: '', repeats: 0, stopped: false, hookResumeAt: now };
  stale.sessions['sess-b'] = { consecutive: 0, lastAttemptAt: now, handled: ['t2'], lastHash: '', repeats: 0, stopped: false, hookResumeAt: 0 };
  writeState(stale, path); // 不应覆盖磁盘上的 hookResumeAt (now+111)
  const merged = readState(path);
  assert.equal(merged.sessions['sess-a'].hookResumeAt, now + 111); // 磁盘较新，保留
  assert.equal(merged.sessions['sess-a'].consecutive, 1);
  assert.deepEqual(merged.sessions['sess-a'].handled, ['t1']); // 并集
  assert.equal(merged.sessions['sess-b'].handled[0], 't2'); // 内存新增会话
  unlinkSync(path);
});
t('state: writeState keeps suppress if only disk has it', () => {
  const path = `${STATE_DIR}\\state-test-${process.pid}.json`;
  const disk = emptyState();
  disk.suppress = { sessionId: 'sess-x', setAt: Date.now() };
  writeState(disk, path);
  const stale = emptyState(); // 内存无 suppress
  writeState(stale, path);     // merge 应保留磁盘上的豁免（未清除）
  assert.deepEqual(readState(path).suppress, disk.suppress);
  unlinkSync(path);
});
t('state: consumeSuppress tombstone prevents resurrection', () => {
  const path = `${STATE_DIR}\\state-test-${process.pid}.json`;
  const disk = emptyState();
  disk.suppress = { sessionId: 'sess-x', setAt: Date.now() };
  writeState(disk, path);
  // 模拟 hook 消费豁免：内存副本清掉 suppress + 打墓碑
  const consumed = readState(path);
  assert.equal(consumeSuppress(consumed, 'sess-x'), true);
  writeState(consumed, path);
  // 旧快照（watcher 读于消费前）尝试写回旧 suppress，不应复活
  const stale = emptyState();
  stale.suppress = { sessionId: 'sess-x', setAt: Date.now() - 10000 };
  writeState(stale, path); // merge: 清除时刻晚于豁免 setAt → 已清除
  assert.equal(readState(path).suppress, null);
  unlinkSync(path);
});

// ---- stop.mjs: normalizeInput ----
t('normalizeInput: dual field name compatibility', () => {
  assert.equal(normalizeInput({ session_id: 'a', hook_event_name: 'Stop' }).sessionId, 'a');
  assert.equal(normalizeInput({ sessionId: 'b', hookEventName: 'Stop' }).sessionId, 'b');
  assert.equal(normalizeInput({ last_assistant_message: '系统繁忙' }).lastMessage, '系统繁忙');
  assert.equal(normalizeInput({ lastAssistantMessage: '系统繁忙' }).lastMessage, '系统繁忙');
});

// ---- stop.mjs: decide ----
t('decide: transient error → block', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const d = decide({ input: { lastMessage: '当前系统繁忙，请稍后再试' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'block');
  assert.equal(d.kind, 'transient');
  assert.ok(d.text.length > 0);
});
t('decide: permanent error → pass', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const d = decide({ input: { lastMessage: 'insufficient balance' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'pass');
  assert.equal(d.kind, 'permanent');
});
t('decide: truncation → block with truncation text', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const d = decide({ input: { lastMessage: 'x'.repeat(300) + '\n```js\nconst x' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'block');
  assert.equal(d.kind, 'truncation');
});
t('decide: empty message + readable transcript(no text, no tool) → block empty', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const tp = writeTranscript([{ role: 'assistant', content: [{ type: 'step-start' }] }]);
  const d = decide({ input: { lastMessage: '', transcriptPath: tp }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'block');
  assert.equal(d.kind, 'empty');
  unlinkSync(tp);
});
t('decide: empty message + transcript shows tool call → pass (regression: 误判空响应)', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const tp = writeTranscript([{ role: 'assistant', content: [{ type: 'tool', tool: 'Bash' }] }]);
  const d = decide({ input: { lastMessage: '', transcriptPath: tp }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'pass');
  unlinkSync(tp);
});
t('decide: empty message + transcript has text → pass', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const tp = writeTranscript([{ role: 'assistant', content: [{ type: 'text', text: '已完成。' }] }]);
  const d = decide({ input: { lastMessage: '', transcriptPath: tp }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'pass');
  unlinkSync(tp);
});
t('decide: empty message + no transcript → pass (保守放行)', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const d = decide({ input: { lastMessage: '', transcriptPath: '/nonexistent/t.jsonl' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'pass');
});
t('decide: stopHookActive forces repeat counting → give-up', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const tp = writeTranscript([{ role: 'assistant', content: [{ type: 'step-start' }] }]);
  entry.repeats = 3;
  const d = decide({ input: { lastMessage: '', transcriptPath: tp, stopHookActive: true }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'give-up');
  unlinkSync(tp);
});
t('decide: normal message → pass', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const d = decide({ input: { lastMessage: '任务已完成，代码已提交。' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'pass');
  assert.equal(d.kind, 'normal');
});
t('decide: max retries reached → give-up', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  entry.consecutive = 3;
  const d = decide({ input: { lastMessage: '系统繁忙' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'give-up');
});
t('decide: loop guard triggers on repeated error', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  entry.lastHash = loopGuardHash('系统繁忙');
  entry.repeats = 3;
  const d = decide({ input: { lastMessage: '系统繁忙' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'give-up');
});
t('decide: cooldown in-progress → cooldown (no sleep)', () => {
  const cfg = resolveConfig({ cooldownMs: 60000 });
  const entry = sessionEntry(emptyState(), 's');
  entry.lastAttemptAt = Date.now() - 10000; // 10s ago, cooldown 60s
  const d = decide({ input: { lastMessage: '系统繁忙' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'cooldown');
  assert.ok(d.waitMs > 0);
});

// ---- classifyTurn：watcher 决策（原为零覆盖）----
const cfgAll = resolveConfig({});
t('classifyTurn: user-cancelled → none', () => {
  assert.equal(classifyTurn(cfgAll, { status: 'cancelled', cancelled_by_user: 1 }, null).kind, 'none');
});
t('classifyTurn: completed → none', () => {
  assert.equal(classifyTurn(cfgAll, { status: 'completed' }, null).kind, 'none');
});
t('classifyTurn: context_exceeded → skip', () => {
  const d = classifyTurn(cfgAll, { status: 'error', context_exceeded: 1 }, null);
  assert.equal(d.kind, 'skip');
  assert.equal(d.reason, 'context_exceeded');
});
t('classifyTurn: error without facts → skip (不再盲目续跑)', () => {
  const d = classifyTurn(cfgAll, { status: 'error' }, null);
  assert.equal(d.kind, 'skip');
  assert.equal(d.reason, 'unknowable_error');
});
t('classifyTurn: transient error → continue', () => {
  const d = classifyTurn(cfgAll, { status: 'error' }, { code: 'X', message: 'upstream connection lost', status: undefined });
  assert.equal(d.kind, 'continue');
});
t('classifyTurn: permanent error → skip', () => {
  const d = classifyTurn(cfgAll, { status: 'error' }, { code: 'X', message: 'Insufficient balance. Please top up your account.', status: undefined });
  assert.equal(d.kind, 'skip');
  assert.equal(d.reason, 'permanent');
});
t('classifyTurn: classify=false → continue for any error', () => {
  const d = classifyTurn(resolveConfig({ classify: false }), { status: 'error' }, null);
  assert.equal(d.kind, 'continue');
});

// ---- resolveConfig：自定义分类正则透传（原为死配置）----
t('resolveConfig: permanentPatterns passthrough', () => {
  const cfg = resolveConfig({ permanentPatterns: ['自定义永久错误'] });
  assert.deepEqual(cfg.permanentPatterns, ['自定义永久错误']);
});
t('resolveConfig: empty permanentPatterns falls back to null', () => {
  assert.equal(resolveConfig({ permanentPatterns: [] }).permanentPatterns, null);
});
t('classifyText: custom permanentPatterns 生效', () => {
  const cfg = resolveConfig({ permanentPatterns: ['自定义永久错误'] });
  assert.equal(classifyText('自定义永久错误', cfg), 'permanent');
});
t('resolveConfig: injectTimeoutMs floor 5s', () => {
  assert.equal(resolveConfig({ injectTimeoutMs: 10 }).injectTimeoutMs, 5000);
});

// ---- UserPromptSubmit hook：命令解析 ----
t('parseDuration: 单位换算', () => {
  assert.equal(parseDuration('30s'), 30000);
  assert.equal(parseDuration('10m'), 600000);
  assert.equal(parseDuration('2h'), 7200000);
  assert.equal(parseDuration('5'), 300000); // 无单位视作分钟
  assert.equal(parseDuration(''), null);
  assert.ok(Number.isNaN(parseDuration('abc')));
});
t('parseCommand: /auto-continue 子命令', () => {
  assert.deepEqual(parseCommand('/auto-continue pause 10m'), { sub: 'pause', arg: '10m' });
  assert.equal(parseCommand('/auto-continue').sub, 'status');
  assert.equal(parseCommand('/auto-continue skip-once').sub, 'skip-once');
  assert.equal(parseCommand('普通提示词'), null);
});

console.log(`\nAll ${n} assertions passed.`);
