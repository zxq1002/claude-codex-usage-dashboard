'use strict';

const fs = require('fs');
const path = require('path');

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const emptyUsage = () => ({ fetchedAt: null, five: null, seven: null });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function unixMillis(value, multiplier) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const millis = value * multiplier;
  return Number.isFinite(new Date(millis).getTime()) ? millis : null;
}

function isoMillis(value) {
  if (typeof value !== 'string') return null;
  // 要求显式时区，并拒绝 Date.parse 会自动纠正的无效日期（如 2 月 30 日）。
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts.map((part, i) => i > 0 && i < 7 ? Number(part) : part);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
      || hour > 23 || minute > 59 || second > 59) return null;
  if (parts[8] !== 'Z' && (Number(parts[8].slice(1, 3)) > 23 || Number(parts[8].slice(4)) > 59)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis > 0 ? millis : null;
}

function normalizeWindow(windowData, parseReset) {
  if (!isObject(windowData)) return null;
  const used = windowData.used_percentage;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const rawReset = windowData.resets_at;
  const resetAt = rawReset == null ? null : parseReset(rawReset);
  // 缺失重置时间可以展示额度；格式损坏的窗口不参与数据源选择。
  if (rawReset != null && resetAt === null) return null;
  return { used, resetAt };
}

function normalizeSnapshot(data, hud, now = Date.now()) {
  if (!isObject(data)) return null;
  const windows = hud ? data : data.rate_limits;
  if (!isObject(windows)) return null;
  const fetchedAt = hud ? isoMillis(data.updated_at) : unixMillis(data.fetchedAt, 1);
  if (fetchedAt === null || fetchedAt > now + FUTURE_TOLERANCE_MS) return null;
  const parseReset = hud ? isoMillis : (value) => unixMillis(value, 1000);
  const five = normalizeWindow(windows.five_hour, parseReset);
  const seven = normalizeWindow(windows.seven_day, parseReset);
  if (!five && !seven) return null;
  return { fetchedAt, five, seven };
}

function readClaudeHudUsage(filePath, now = Date.now()) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  return normalizeSnapshot(readJson(filePath), true, now);
}

function readClaudeUsage({ cachePath, hudPath, now = Date.now() }) {
  const legacy = normalizeSnapshot(readJson(cachePath), false, now);
  const hud = readClaudeHudUsage(hudPath, now);
  // 按整份快照选择；同一时间优先 HUD，不用旧窗口填补新快照。
  return hud && (!legacy || hud.fetchedAt >= legacy.fetchedAt) ? hud : legacy || emptyUsage();
}

module.exports = { FUTURE_TOLERANCE_MS, emptyUsage, readJson, isoMillis, normalizeSnapshot, readClaudeHudUsage, readClaudeUsage };
