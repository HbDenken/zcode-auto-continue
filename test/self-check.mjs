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
  classifyDangling,
  loopGuardHash,
} from '../lib/core.mjs';
import { readState, writeState, sessionEntry, consumeSuppress, consumeInjectMarker, emptyState, pruneSessions, STATE_DIR } from '../lib/state.mjs';
import { readStats, writeStats } from '../lib/stats.mjs';
import { writeFileSync, unlinkSync, rmSync, mkdtempSync } from 'node:fs';
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
t('permanent: invalid_model_request（回归：近 30 天 160 次白烧 3 次注入）', () => {
  // 真实报文（实测取自带内 DB）：message 里没有 "invalid request" 字样，只有 error.type 有，
  // 所以必须按 code 判定；否则被判临时，每回合白打 3 次 --resume。
  assert.equal(
    isTransientFailure({ code: 'invalid_model_request', message: 'Provider rejected the model request.' }),
    false,
  );
  assert.equal(
    isTransientFailure({
      code: 'invalid_model_request',
      message: '[400]: {"error":{"message":"\\"thinking\\" is not supported on /v1/chat/completions and was not applied.","type":"invalid_request_error"}}',
    }),
    false,
  );
  // code 形如 invalid_model_request_* 也覆盖
  assert.equal(isTransientFailure({ code: 'invalid_request_error', message: '' }), false);
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

// ---- classifyDangling ----
t('classifyDangling: 实测样本（宣布下一步后结束）→ dangling', () => {
  assert.equal(
    classifyDangling('Found the root cause. Let me pull the remaining regions precisely.'),
    'dangling',
  );
  assert.equal(classifyDangling('Now I have the shape of the change. Let me dump the exact regions.'), 'dangling');
  assert.equal(classifyDangling('让我先把剩下的代码段取出来。'), 'dangling');
});
t('classifyDangling: 正常收尾 → null', () => {
  assert.equal(classifyDangling('任务已完成，代码已提交。'), null);
  assert.equal(classifyDangling('已修复：Stop hook 现在会识别悬空意图。'), null);
});
t('classifyDangling: 征询/收尾句式 → null（不误伤）', () => {
  assert.equal(classifyDangling('Let me know if you need anything else.'), null);
  assert.equal(classifyDangling('I will be here if you have questions.'), null);
  assert.equal(classifyDangling('如需继续，请告诉我。'), null);
});
t('classifyDangling: 长回复 → null（正文字数上限）', () => {
  assert.equal(classifyDangling('x'.repeat(200) + ' Let me continue.'), null);
});
t('classifyDangling: 意图短语不在末句 → null', () => {
  assert.equal(classifyDangling('Let me check. 检查完成，结果是三条记录都匹配。'), null);
});
t('classifyDangling: 解释/收尾类意图短语 → null（回归：实测误伤样本）', () => {
  // 这些"表面是指令、实为解释或收尾"的短回复曾被判成未完成并注入 block。
  assert.equal(classifyDangling("The build passes. I'll note the caveat in the README."), null);
  assert.equal(classifyDangling("OK, that's everything. Let's wrap up."), null);
  assert.equal(classifyDangling('Let me explain the design: we poll the DB every 5 seconds.'), null);
  assert.equal(classifyDangling('分析完成。我将总结如下。'), null);
  assert.equal(classifyDangling("I'll mention it in the summary."), null);
});
t('classifyDangling: 宣布要列却没列 → dangling（不因冒号误放行）', () => {
  assert.equal(classifyDangling('Let me verify the following:'), 'dangling');
});
t('classifyDangling: guard 关闭 → null', () => {
  assert.equal(classifyDangling('Let me pull the rest.', { danglingGuard: false }), null);
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
  assert.equal(e.resetAt, 0);
  assert.deepEqual(e.hookTurnIds, []);
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
  s.sessions['old'] = { consecutive: 0, lastAttemptAt: 0 };
  s.sessions['recent'] = { consecutive: 1, lastAttemptAt: Date.now() };
  pruneSessions(s);
  assert.ok(!s.sessions['old']);
  assert.ok(s.sessions['recent']);
});
t('state: writeState merges (no lost-update)', () => {
  // 用临时目录，别碰真实 STATE_DIR（旧版写 STATE_DIR\state-test-*.json，
  // 断言失败时 unlinkSync 走不到，实测残留了 state-test-10176.json）。
  const dir = mkdtempSync(join(tmpdir(), 'ac-merge-'));
  const path = join(dir, 'state.json');
  const now = Date.now();
  // 磁盘上是 watcher 写入的较新 lastAttemptAt
  const disk = emptyState();
  disk.sessions['sess-a'] = { consecutive: 1, lastAttemptAt: now + 111, handled: ['t1'], lastHash: '', repeats: 0, stopped: false, hookTurnIds: ['turn-x'] };
  writeState(disk, path);
  // 内存副本较旧——模拟 hook 的旧快照
  const stale = emptyState();
  stale.sessions['sess-a'] = { consecutive: 0, lastAttemptAt: now, handled: ['t1'], lastHash: '', repeats: 0, stopped: false, hookTurnIds: [] };
  stale.sessions['sess-b'] = { consecutive: 0, lastAttemptAt: now, handled: ['t2'], lastHash: '', repeats: 0, stopped: false, hookTurnIds: [] };
  writeState(stale, path); // 不应覆盖磁盘上较新的那份
  const merged = readState(path);
  assert.equal(merged.sessions['sess-a'].consecutive, 1); // 磁盘较新，保留
  assert.deepEqual(merged.sessions['sess-a'].handled, ['t1']); // 并集
  assert.deepEqual(merged.sessions['sess-a'].hookTurnIds, ['turn-x']); // 去重表并集
  assert.equal(merged.sessions['sess-b'].handled[0], 't2'); // 内存新增会话
  rmSync(dir, { recursive: true, force: true });
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
t('decide: 悬空意图（只说 Let me… 就结束）→ block 并要求给出结果', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const d = decide({
    input: { lastMessage: 'Found the root cause. Let me pull the remaining regions precisely.' },
    entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3,
  });
  assert.equal(d.action, 'block');
  assert.equal(d.kind, 'dangling');
  assert.match(d.text, /给出结果|结果/);
});
t('decide: 悬空意图不受截断长度门槛影响（短回复也能救）', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const d = decide({
    input: { lastMessage: '让我确认一下依赖版本。' },
    entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3,
  });
  assert.equal(d.action, 'block');
  assert.equal(d.kind, 'dangling');
});
t('decide: 正常结束语 → pass（悬空判定不误伤）', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  const d = decide({ input: { lastMessage: 'Let me know if you want me to continue.' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'pass');
  assert.equal(d.kind, 'normal');
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
t('decide: empty message + transcript has tool part → pass（防御性分支，ZCode 实际不产出）', () => {
  // 注：ZCode 的 transcript 只写 {type:"text"}（见 core.mjs inspectTranscript 注释），
  // 该分支在当前宿主上不可达。此断言仅保证"万一出现 tool part 也不误注入"，
  // 不代表真实格式。
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
  // hook 侧冷却用 hookCooldownMs（不再用 watcher 的 cooldownMs，见第 1 条修复）。
  const cfg = resolveConfig({ hookCooldownMs: 60000 });
  const entry = sessionEntry(emptyState(), 's');
  entry.lastAttemptAt = Date.now() - 10000; // 10s ago, cooldown 60s
  const d = decide({ input: { lastMessage: '系统繁忙' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'cooldown');
  assert.ok(d.waitMs > 0);
});

// ---- classifyTurn：watcher 决策（原为零覆盖）----
t('normalizeInput: 提取 turnId（供 watcher 按 turn 去重）', () => {
  assert.equal(normalizeInput({ turn_id: 'turn_abc' }).turnId, 'turn_abc');
  assert.equal(normalizeInput({ turnId: 'turn_def' }).turnId, 'turn_def');
  assert.equal(normalizeInput({}).turnId, '');
});
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

// ---- 第 1 条：hook 侧冷却用 hookCooldownMs，不用 watcher 的 cooldownMs ----
t('resolveConfig: hookCooldownMs 默认 3s 且可覆盖', () => {
  assert.equal(resolveConfig({}).hookCooldownMs, 3000);
  assert.equal(resolveConfig({ hookCooldownMs: 500 }).hookCooldownMs, 500);
});
t('decide: 冷却窗口按 hookCooldownMs（回归：20s 冷却会静默吞掉第二个悬空回合）', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  // 上次注入在 5 秒前：20s 冷却下会 cooldown（丢弃），3s 冷却下应放行 → block。
  entry.lastAttemptAt = Date.now() - 5000;
  const d = decide({
    input: { lastMessage: 'Found the root cause. Let me pull the remaining regions.' },
    entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3,
  });
  assert.equal(d.action, 'block');
});

// ---- 第 3 条：stats 合并写盘（防 lost-update）----
t('stats: writeStats 合并磁盘，不覆盖并发记账', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-stats-'));
  const path = join(dir, 'stats.json');
  // watcher 快照 + 期间 hook 记账（各用显式 path，不碰真实 STATE_DIR）
  const snap = readStats(path);
  snap.sent += 1;
  const hook = readStats(path);
  hook.skipped += 1;
  hook.byCode.permanent = 1;
  writeStats(hook, path);
  writeStats(snap, path); // watcher 用陈旧快照覆盖 → hook 的记账必须保住
  const after = readStats(path);
  assert.equal(after.sent, 1);
  assert.equal(after.skipped, 1);
  assert.equal(after.byCode.permanent, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ---- 第 6 条：人工重置写 resetAt，合并时不被旧快照吞掉 ----
t('state: resetAt 让重置在陈旧快照路径下生效（回归：重置被合并吞掉）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-state-'));
  const path = join(dir, 'state.json');
  const now = Date.now();
  const fresh = emptyState();
  const fe = sessionEntry(fresh, 's1');
  fe.consecutive = 3; fe.lastAttemptAt = now;
  writeState(fresh, path);
  // hook 持有更旧的快照做人工重置（不改 lastAttemptAt，只写 resetAt）
  const stale = emptyState();
  const se = sessionEntry(stale, 's1');
  se.consecutive = 0; se.lastAttemptAt = now - 5000; se.resetAt = now + 1000;
  writeState(stale, path);
  assert.equal(readState(path).sessions.s1.consecutive, 0);
  rmSync(dir, { recursive: true, force: true });
});
t('state: 水位按 watermarkSetAt 取较新的一份（支持注入失败时回退）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-wm-'));
  const path = join(dir, 'state.json');
  const now = Date.now();
  const a = emptyState(); a.watermark = 5000; a.watermarkSetAt = now;
  writeState(a, path);
  // 较旧的快照带着一个更大的水位 + 更早的时间戳 → 不应覆盖（否则回退被抹掉）
  const b = emptyState(); b.watermark = 9000; b.watermarkSetAt = now - 10000;
  writeState(b, path);
  assert.equal(readState(path).watermark, 5000);
  rmSync(dir, { recursive: true, force: true });
});
t('decide: 已放弃会话 → pass/stopped（回归：重复 give-up 稀释 gaveUp 统计）', () => {
  const cfg = resolveConfig({});
  const entry = sessionEntry(emptyState(), 's');
  entry.stopped = true;
  entry.consecutive = 3;
  const d = decide({ input: { lastMessage: '当前系统繁忙' }, entry, cfg, maxHookRetries: 3, loopGuardRepeats: 3 });
  assert.equal(d.action, 'pass');
  // 必须是 'stopped' 而非 'normal'：调用方只在 kind==='normal' 时重置 stopped。
  assert.equal(d.kind, 'stopped');
});
t('state: consumeInjectMarker 一次性 + 窗口过期 + 墓碑防复活', () => {
  const s = emptyState();
  const e = sessionEntry(s, 's1');
  const now = Date.now();
  // 窗口内 → 消费成功
  e.injectAt = now;
  assert.equal(consumeInjectMarker(s, 's1', 60000), true);
  assert.equal(e.injectAt, 0);
  assert.ok(e.injectConsumedAt > 0);
  // 已消费 → 再消费失败（真人输入不会被误判成注入）
  assert.equal(consumeInjectMarker(s, 's1', 60000), false);
  // 超出窗口 → 不消费（陈旧标记不能误伤真人输入）
  const s2 = emptyState();
  const e2 = sessionEntry(s2, 's2');
  e2.injectAt = now - 999999;
  assert.equal(consumeInjectMarker(s2, 's2', 60000), false);
  // 无标记 → 不消费
  assert.equal(consumeInjectMarker(s2, 's3', 60000), false);
});
t('state: 合并时已消费的注入标记不被旧快照复活', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-inj-'));
  const path = join(dir, 'state.json');
  const now = Date.now();
  // 磁盘上留着 watcher spawn 前写的未消费标记
  const disk = emptyState();
  const de = sessionEntry(disk, 's1');
  de.injectAt = now; de.consecutive = 1;
  writeState(disk, path);
  // 注入失败后 watcher 就地清标记（写墓碑）
  const cur = readState(path);
  const ce = sessionEntry(cur, 's1');
  ce.injectAt = 0; ce.injectConsumedAt = now + 1000;
  writeState(cur, path);
  const after = readState(path).sessions.s1;
  assert.equal(after.injectAt, 0, '旧快照的 injectAt 不得复活');
  rmSync(dir, { recursive: true, force: true });
});
t('state: pruneTo 保留只被 watcher 触达（resetAt/injectAt 有值）的会话', () => {
  const s = emptyState();
  const e = sessionEntry(s, 'sess_watcher_only');
  e.resetAt = Date.now(); // 旧判据下 activeAt=0 会被裁掉
  const s2 = emptyState();
  const e2 = sessionEntry(s2, 'sess_pending_inject');
  e2.injectAt = Date.now(); // 待消费的注入标记被裁掉 → UPS 钩子读不到 → 误判真人输入
  pruneSessions(s);
  pruneSessions(s2);
  assert.ok(s.sessions['sess_watcher_only']);
  assert.ok(s2.sessions['sess_pending_inject']);
});

console.log(`\nAll ${n} assertions passed.`);
