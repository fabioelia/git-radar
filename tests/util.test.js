import test from 'node:test';
import assert from 'node:assert/strict';
import {
  truncate, extractJson, extractToolCall, hoursBetween, formatHours, addDays, isoDate,
} from '../src/main/services/util.js';

test('truncate keeps short strings and trims long ones', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate(null, 10), '');
  const out = truncate('a'.repeat(50), 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith('…'));
});

test('extractJson parses plain JSON', () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
});

test('extractJson handles fenced and noisy output', () => {
  const fenced = 'Sure! Here you go:\n```json\n{"classifications": []}\n```\nHope that helps.';
  assert.deepEqual(extractJson(fenced), { classifications: [] });
  const noisy = 'prefix text {"x": {"y": 2}} trailing';
  assert.deepEqual(extractJson(noisy), { x: { y: 2 } });
});

test('extractJson throws on garbage', () => {
  assert.throws(() => extractJson('no json here'));
  assert.throws(() => extractJson(''));
});

test('extractToolCall finds tool requests and ignores prose', () => {
  const call = extractToolCall('{"tool_call": {"name": "jira.search", "arguments": {"q": "sprint"}}}');
  assert.deepEqual(call, { name: 'jira.search', arguments: { q: 'sprint' } });
  assert.equal(extractToolCall('## Sprint report\nAll good.'), null);
  assert.equal(extractToolCall('{"not_a_tool": 1}'), null);
});

test('time helpers', () => {
  assert.equal(hoursBetween('2026-06-01T00:00:00Z', '2026-06-01T12:00:00Z'), 12);
  assert.equal(formatHours(0.5), '30m');
  assert.equal(formatHours(30), '30.0h');
  assert.equal(formatHours(72), '3.0d');
  assert.equal(formatHours(null), '—');
  assert.equal(addDays('2026-06-13', 8), '2026-06-21');
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(isoDate('2026-06-13T22:10:00Z'), '2026-06-13');
});
