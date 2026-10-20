import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { readClaudeUsage } = require('../lib/claude-usage.js');
const configRoot = path.resolve((process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).replace(/^~(?=$|[/\\])/, os.homedir()));
const installed = JSON.parse(fs.readFileSync(path.join(configRoot, 'plugins', 'installed_plugins.json'), 'utf8'));
const entries = installed.plugins?.['claude-hud@claude-hud'];
if (!entries?.length) throw new Error('No installed Claude HUD found.');
if (entries.length !== 1) throw new Error('Multiple HUD installs found; select the active configuration directory first.');
const pluginDir = entries[0].installPath;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-hud-smoke-'));
const snapshotPath = path.join(dir, 'hud.json');
const originalNow = Date.now;
const fixedNow = originalNow();
process.env.COLUMNS = '120';
process.env.FORCE_COLOR = '1';
Date.now = () => fixedNow;
try {
  const { main } = await import(pathToFileURL(path.join(pluginDir, 'dist', 'index.js')));
  const { mergeConfig, loadConfig } = await import(pathToFileURL(path.join(pluginDir, 'dist', 'config.js')));
  const current = await loadConfig();
  const input = {
    model: { id: 'claude-opus-test', display_name: 'Opus Test' }, cwd: dir,
    context_window: { used_percentage: 25, context_window_size: 200000, current_usage: { input_tokens: 50000 } },
    rate_limits: { five_hour: { used_percentage: 84.6, resets_at: Math.floor(fixedNow / 1000) + 7200 }, seven_day: { used_percentage: 99.6, resets_at: Math.floor(fixedNow / 1000) + 172800 } },
  };
  const transcript = {
    tools: [{ name: 'Read', status: 'completed' }], skills: [], mcpServers: [],
    agents: [{ id: 'test-agent', type: 'explore', description: 'Check integration', status: 'running', startTime: new Date(fixedNow) }],
    todos: [{ content: 'Verify integration', status: 'in_progress' }], sessionName: 'Integration fixture', sessionStart: new Date(fixedNow - 60000),
  };
  const common = {
    readStdin: async () => structuredClone(input), parseTranscript: async () => transcript,
    applyContextWindowFallback: () => {}, countConfigs: () => ({ claudeMdCount: 1, rulesCount: 0, mcpCount: 0, hooksCount: 0 }),
    getGitStatus: async () => null, parseExtraCmdArg: () => null, now: () => fixedNow,
  };
  async function capture(config, changes = {}) {
    const chunks = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = function (chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      if (typeof encoding === 'function') encoding(); else if (callback) callback(); return true;
    };
    try { await main({ ...common, loadConfig: async () => config, ...changes }); }
    finally { process.stdout.write = originalWrite; }
    return Buffer.concat(chunks);
  }
  const withoutExport = mergeConfig({ ...current, display: { ...current.display, externalUsageWritePath: '' } });
  const withExport = mergeConfig({ ...current, display: { ...current.display, externalUsageWritePath: snapshotPath } });
  const before = await capture(withoutExport);
  const after = await capture(withExport);
  assert.deepEqual(after, before, 'export must not change a single stdout byte');
  const text = after.toString();
  for (const label of ['Opus Test', 'Read', 'explore', 'Verify integration']) assert(text.includes(label), label + ' rendered');
  assert(text.includes('\x1b['), 'ANSI colors retained');
  assert(text.split('\n').length >= 4, 'multiline renderer exercised');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath));
  assert.equal(snapshot.five_hour.used_percentage, 85);
  assert.equal(snapshot.seven_day.used_percentage, 100);
  assert.equal(Date.parse(snapshot.updated_at), fixedNow);
  assert.equal(fs.statSync(snapshotPath).mode & 0o777, 0o600);
  const selected = readClaudeUsage({ cachePath: path.join(dir, 'absent.json'), hudPath: snapshotPath, now: fixedNow });
  assert.equal(selected.five.used, 85); assert.equal(selected.seven.used, 100);
  const renderer = spawnSync(process.execPath, ['-e', 'const {koboPageHtml}=require("./server"); console.log(JSON.stringify({remaining:koboPageHtml("/k"),used:koboPageHtml("/u")}))'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, CLAUDE_USAGE_CACHE: path.join(dir, 'absent.json'), CLAUDE_HUD_USAGE_PATH: snapshotPath, CODEX_SESSIONS_DIR: path.join(dir, 'no-codex') }, encoding: 'utf8',
  });
  assert.equal(renderer.status, 0, renderer.stderr);
  const pages = JSON.parse(renderer.stdout);
  assert(pages.remaining.includes('<td class="num">15%</td>')); assert(pages.remaining.includes('<td class="num">0%</td>'));
  assert(pages.used.includes('<td class="num">85%</td>')); assert(pages.used.includes('<td class="num">100%</td>'));
  fs.unlinkSync(snapshotPath);fs.chmodSync(dir, 0o500);
  assert.deepEqual(await capture(withExport), before, 'unwritable snapshot must not alter HUD');
  fs.chmodSync(dir, 0o700);assert(!fs.existsSync(snapshotPath));
  await capture(withExport, { readStdin: async () => ({ ...input, rate_limits: undefined }) });
  assert(!fs.existsSync(snapshotPath), 'no valid rate limits must not generate a snapshot');
  console.log(JSON.stringify({ passed: true, hudVersion: entries[0].version, syntheticData: true, hudStdoutByteIdentical: true, modelToolsAgentsTodosAndAnsi: true, exportFailureDoesNotAffectHud: true, snapshotMode: '0600', snapshotRounding: [85, 100], remaining: [15, 0], realAccountQuery: false }));
} finally {
  Date.now = originalNow;
  fs.chmodSync(dir, 0o700);fs.rmSync(dir, { recursive: true, force: true });
}
