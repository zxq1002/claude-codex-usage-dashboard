'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readClaudeUsage, normalizeSnapshot, isoMillis, FUTURE_TOLERANCE_MS } = require('../lib/claude-usage');
const now = Date.parse('2026-10-20T09:00:00.000Z');
const reset = '2026-10-20T12:00:00.000Z';
const hud = (time = now) => ({ updated_at: new Date(time).toISOString(), five_hour: { used_percentage: 0, resets_at: reset }, seven_day: { used_percentage: 100, resets_at: null } });
const legacy = (time = now) => ({ fetchedAt: time, rate_limits: { five_hour: { used_percentage: 42.6, resets_at: Date.parse(reset) / 1000 }, seven_day: { used_percentage: 65 } } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { cachePath: path.join(dir, 'cache.json'), hudPath: path.join(dir, 'hud.json'), now };
}
function put(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }

test('HUD ISO snapshot retains 0%, 100%, missing reset and original timestamp', () => {
  assert.deepEqual(normalizeSnapshot(hud(now - 10 * 86400000), true, now), {
    fetchedAt: now - 10 * 86400000, five: { used: 0, resetAt: Date.parse(reset) }, seven: { used: 100, resetAt: null },
  });
});
test('legacy milliseconds and reset seconds stay distinct; fractional usage is preserved', () => {
  assert.deepEqual(normalizeSnapshot(legacy(), false, now), { fetchedAt: now, five: { used: 42.6, resetAt: Date.parse(reset) }, seven: { used: 65, resetAt: null } });
});
for (const value of [null, [], {}, { updated_at: reset }, { ...hud(), updated_at: 'bad' }, { ...hud(), updated_at: 1792486800000 }, { ...hud(), updated_at: '2026-02-30T00:00:00Z' }, hud(now + FUTURE_TOLERANCE_MS + 1)]) {
  test('invalid HUD source rejected: ' + JSON.stringify(value).slice(0, 95), () => assert.equal(normalizeSnapshot(value, true, now), null));
}
for (const value of [null, '0', -1, 101, NaN, Infinity]) {
  test('invalid percentage rejected: ' + String(value), () => {
    const data = { ...hud(), five_hour: { used_percentage: value }, seven_day: null };
    assert.equal(normalizeSnapshot(data, true, now), null);
  });
}
test('partial windows are accepted; malformed reset invalidates only its window', () => {
  const data = hud(); data.five_hour.resets_at = 'not-a-date';
  assert.deepEqual(normalizeSnapshot(data, true, now), { fetchedAt: now, five: null, seven: { used: 100, resetAt: null } });
});
test('ISO requires timezone, rejects impossible dates and accepts offset and leap day', () => {
  assert.equal(isoMillis('2026-10-20T17:00:00+08:00'), now);
  assert.equal(isoMillis('2024-02-29T00:00:00Z'), Date.parse('2024-02-29T00:00:00Z'));
  for (const s of ['2025-02-29T00:00:00Z', '2026-10-20T09:00:00', '2026-10-20T24:00:00Z', '2026-10-20T09:00:00+25:00']) assert.equal(isoMillis(s), null);
});
for (const [name, cacheTime, hudTime, expected] of [
  ['new HUD', now - 1000, now, 0], ['new legacy', now, now - 1000, 42.6], ['tie prefers HUD', now, now, 0],
]) test(name, t => { const f = fixture(t); put(f.cachePath, legacy(cacheTime)); put(f.hudPath, hud(hudTime)); assert.equal(readClaudeUsage(f).five.used, expected); });
test('HUD path unset ignores a newer HUD file, preserving old source selection', t => {
  const f = fixture(t); put(f.cachePath, legacy(now - 1000)); put(f.hudPath, hud());
  assert.equal(readClaudeUsage({ ...f, hudPath: undefined }).five.used, 42.6);
});
for (const [name, content] of [['missing', null], ['bad JSON', '{broken'], ['no valid windows', JSON.stringify({updated_at: new Date(now).toISOString()})], ['no valid time', JSON.stringify({...hud(), updated_at:null})]]) {
  test(name + ' HUD falls back without changing either source', t => {
    const f = fixture(t); put(f.cachePath, legacy()); if (content !== null) fs.writeFileSync(f.hudPath, content);
    const before = fs.readFileSync(f.cachePath);
    assert.equal(readClaudeUsage(f).five.used, 42.6);
    assert.deepEqual(fs.readFileSync(f.cachePath), before);
    if (content !== null) assert.equal(fs.readFileSync(f.hudPath, 'utf8'), content);
  });
}
test('new partial snapshot does not fill missing windows from older cache', t => {
  const f = fixture(t); put(f.cachePath, legacy(now - 1000)); const data = hud(); data.seven_day = null; put(f.hudPath, data);
  assert.equal(readClaudeUsage(f).seven, null);
});
test('all sources absent or malformed show no data; relative HUD paths are ignored', t => {
  const f = fixture(t); assert.deepEqual(readClaudeUsage(f), { fetchedAt: null, five: null, seven: null });
  put(f.hudPath,hud()); assert.equal(readClaudeUsage({...f,hudPath:'relative.json'}).five,null);
});
for (const percent of [0, 84.6, 99.6, 100]) test('snapshot precision is not re-rounded by adapter: ' + percent, () => {
  const data = hud(); data.five_hour.used_percentage = percent;
  assert.equal(normalizeSnapshot(data, true, now).five.used, percent);
});
test('legacy invalid time and malformed values cannot win source selection', t => {
  const f=fixture(t); put(f.hudPath,hud(now-1000));
  for (const data of [{...legacy(),fetchedAt:null},legacy(now+FUTURE_TOLERANCE_MS+1),{fetchedAt:now,rate_limits:{}}]) {
    put(f.cachePath,data);assert.equal(readClaudeUsage(f).five.used,0);
  }
});
