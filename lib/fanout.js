'use strict';

const { spawn } = require('child_process');

const OUTPUT_LIMIT = 256 * 1024;
const TIMEOUT_MS = 2000;

function isWrapperCommand(command) {
  return /statusline-(?:both\.js|usage\.js|bridge\.(?:sh|js|ps1|cmd|bat))/i.test(command);
}

function runCommand(command, args, input, options = {}) {
  const { timeout = TIMEOUT_MS, maxBytes = OUTPUT_LIMIT, shell = false, env = process.env } = options;
  return new Promise((resolve) => {
    let child;
    let timer;
    let done = false;
    let bytes = 0;
    const output = [];
    const terminate = () => {
      if (!child || !child.pid) return;
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => {});
          killer.unref();
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {}
      try { child.kill('SIGKILL'); } catch {}
    };
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!ok) terminate();
      if (child) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      resolve({ ok, stdout: ok ? Buffer.concat(output).toString('utf8') : '' });
    };
    try {
      child = spawn(command, args, {
        shell, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      timer = setTimeout(() => finish(false), timeout);
      child.on('error', () => finish(false));
      child.on('close', (code, signal) => finish(code === 0 && !signal));
      child.stdin.on('error', () => {});
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) return finish(false);
          if (stream === child.stdout) output.push(chunk);
        });
      }
      child.stdin.end(input);
    } catch {
      finish(false);
    }
  });
}

async function fanout({ input, ownPath, extraCommand, env = process.env, ...options }) {
  // 深度标记会穿过未知包装脚本，阻止间接再次调用本程序。
  if (env.DASHBOARD_FANOUT_DEPTH) return 'Claude';
  const childEnv = { ...env, DASHBOARD_FANOUT_DEPTH: '1' };
  const extra = typeof extraCommand === 'string' && extraCommand.trim() && !isWrapperCommand(extraCommand)
    ? extraCommand : null;
  const [own, hud] = await Promise.all([
    runCommand(process.execPath, [ownPath], input, { ...options, env: childEnv }),
    extra ? runCommand(extra, [], input, { ...options, env: childEnv, shell: true }) : null,
  ]);
  // trim 仅判空；原样返回颜色、Unicode、缩进和所有换行。
  return (hud && hud.ok && hud.stdout.trim() ? hud.stdout : '')
    || (own.ok && own.stdout.trim() ? own.stdout : '') || 'Claude';
}

module.exports = { fanout, runCommand, isWrapperCommand, TIMEOUT_MS, OUTPUT_LIMIT };
