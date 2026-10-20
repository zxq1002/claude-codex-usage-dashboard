'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteJson } = require('./lib/private-json');
const { isWrapperCommand } = require('./lib/fanout');

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (object, key) => Object.hasOwn(object, key);
function readObject(file) {
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration: ' + file);
  return value;
}
function configRoot(env = process.env) {
  const raw = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.resolve(raw.replace(/^~(?=$|[/\\])/, os.homedir()));
}
function quote(value) {
  if (process.platform === 'win32') return '"' + value.replace(/"/g, '\\"') + '"';
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
function createPlan({ projectDir = __dirname, root = configRoot(), fanout = false, env = process.env } = {}) {
  const settingsPath = path.join(root, 'settings.json');
  const configPath = path.join(projectDir, 'config.json');
  const settings = readObject(settingsPath);
  const config = readObject(configPath);
  const current = settings.statusLine;
  if (current != null && (typeof current !== 'object' || Array.isArray(current)
      || (current.command !== undefined && typeof current.command !== 'string'))) {
    throw new Error('Invalid existing statusLine configuration; no files written.');
  }
  const previous = current && current.command;
  const ownPaths = ['statusline-both.js', 'statusline-usage.js'].map(name => path.join(projectDir, name));
  const isOurs = typeof previous === 'string' && ownPaths.some(p => previous.includes(quote(p)) || previous.includes('"' + p + '"'));
  if (fanout && previous && isWrapperCommand(previous) && !isOurs) {
    throw new Error('Existing wrapper detected. Use the saved original HUD command before installing fanout.');
  }
  const extra = fanout ? (env.EXTRA_STATUSLINE_COMMAND || (!isOurs && previous) || config.extraStatuslineCommand) : undefined;
  if (fanout && (typeof extra !== 'string' || !extra.trim() || isWrapperCommand(extra))) {
    throw new Error('Fanout needs an original display command; recursive or empty commands are refused.');
  }
  const command = quote(process.execPath) + ' ' + quote(path.join(projectDir, fanout ? 'statusline-both.js' : 'statusline-usage.js'));
  const nextStatusLine = { ...(current || {}), type: 'command', command };
  const nextConfig = { ...config, ...(fanout ? { extraStatuslineCommand: extra } : {}) };
  return { settingsPath, configPath, settings, config, nextStatusLine, nextConfig, fanout,
    changed: !equal(current, nextStatusLine) || !equal(config, nextConfig) };
}
function applyPlan(plan) {
  if (!plan.changed) return null;
  if (!equal(readObject(plan.settingsPath), plan.settings) || !equal(readObject(plan.configPath), plan.config)) {
    throw new Error('Configuration changed since planning; no files written.');
  }
  const backupDir = path.join(path.dirname(plan.settingsPath), 'dashboard-backups',
    'statusline-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
  // 任一备份失败均直接退出，不覆盖原配置。
  for (const [name, file] of [['settings.json', plan.settingsPath], ['config.json', plan.configPath]]) {
    if (fs.existsSync(file)) {
      const target = path.join(backupDir, name);
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
    }
  }
  const manifest = {
    settingsPath: plan.settingsPath, configPath: plan.configPath,
    beforeStatusLine: plan.settings.statusLine ?? null, afterStatusLine: plan.nextStatusLine,
    configExisted: fs.existsSync(plan.configPath),
    beforeExtra: { present: has(plan.config, 'extraStatuslineCommand'), value: plan.config.extraStatuslineCommand ?? null },
    afterExtra: { present: has(plan.nextConfig, 'extraStatuslineCommand'), value: plan.nextConfig.extraStatuslineCommand ?? null },
  };
  atomicWriteJson(path.join(backupDir, 'manifest.json'), manifest);
  if (!equal(readObject(plan.settingsPath), plan.settings) || !equal(readObject(plan.configPath), plan.config)) {
    throw new Error('Configuration changed during backup; no configuration written.');
  }
  let configWritten = false;
  try {
    if (!equal(plan.config, plan.nextConfig)) {
      atomicWriteJson(plan.configPath, plan.nextConfig);
      configWritten = true;
    }
    atomicWriteJson(plan.settingsPath, { ...plan.settings, statusLine: plan.nextStatusLine });
  } catch (error) {
    if (configWritten && equal(readObject(plan.configPath), plan.nextConfig)) {
      if (manifest.configExisted) atomicWriteJson(plan.configPath, plan.config);
      else fs.rmSync(plan.configPath);
    }
    throw error;
  }
  return backupDir;
}
function restore(backupDir) {
  const manifest = readObject(path.join(backupDir, 'manifest.json'));
  if (!manifest.settingsPath || !manifest.configPath) throw new Error('Not a statusline installer backup.');
  const settings = readObject(manifest.settingsPath);
  const config = readObject(manifest.configPath);
  const currentExtra = { present: has(config, 'extraStatuslineCommand'), value: config.extraStatuslineCommand ?? null };
  if (!equal(settings.statusLine, manifest.afterStatusLine) || !equal(currentExtra, manifest.afterExtra)) {
    throw new Error('Managed fields changed after installation; automatic rollback refused.');
  }
  if (manifest.beforeStatusLine === null) delete settings.statusLine;
  else settings.statusLine = manifest.beforeStatusLine;
  if (manifest.beforeExtra.present) config.extraStatuslineCommand = manifest.beforeExtra.value;
  else delete config.extraStatuslineCommand;
  const originalConfig = readObject(manifest.configPath);
  const existed = fs.existsSync(manifest.configPath);
  let configWritten = false;
  try {
    if (!equal(manifest.beforeExtra, manifest.afterExtra)) {
      if (!manifest.configExisted && Object.keys(config).length === 0) fs.rmSync(manifest.configPath);
      else atomicWriteJson(manifest.configPath, config);
      configWritten = true;
    }
    atomicWriteJson(manifest.settingsPath, settings);
  } catch (error) {
    if (configWritten && equal(readObject(manifest.configPath), config)) {
      if (existed) atomicWriteJson(manifest.configPath, originalConfig);
      else fs.rmSync(manifest.configPath, { force: true });
    }
    throw error;
  }
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node setup-statusline.js [--fanout] [--plan-only]\n       node setup-statusline.js --restore BACKUP_DIR');
    return;
  }
  if (args[0] === '--restore' && args.length === 2) {
    restore(args[1]); console.log('Restored managed statusLine/config fields; unrelated settings preserved.'); return;
  }
  if (args.some(arg => !['--fanout', '--plan-only'].includes(arg))) throw new Error('Unknown argument. Use --help.');
  const plan = createPlan({ fanout: args.includes('--fanout') });
  console.log('StatusLine command: ' + plan.nextStatusLine.command);
  if (plan.fanout) console.log('Display command: ' + plan.nextConfig.extraStatuslineCommand);
  if (args.includes('--plan-only')) { console.log('Plan only; no files written.'); return; }
  const backupDir = applyPlan(plan);
  console.log(backupDir ? 'Installed. Backup: ' + backupDir : 'Already configured; no files changed.');
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createPlan, applyPlan, restore, configRoot };
