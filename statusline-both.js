'use strict';

const path = require('path');
const { readJson } = require('./lib/claude-usage');
const { fanout, OUTPUT_LIMIT } = require('./lib/fanout');

let input = '';
let oversized = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (oversized) return;
  input += chunk;
  if (Buffer.byteLength(input, 'utf8') > OUTPUT_LIMIT) {
    oversized = true;
    input = '';
  }
});
process.stdin.on('error', () => { oversized = true; });
process.stdin.on('end', async () => {
  if (oversized) return process.stdout.write('Claude');
  const config = readJson(path.join(__dirname, 'config.json')) || {};
  const extraCommand = process.env.EXTRA_STATUSLINE_COMMAND || config.extraStatuslineCommand || '';
  try {
    process.stdout.write(await fanout({ input, ownPath: path.join(__dirname, 'statusline-usage.js'), extraCommand }));
  } catch {
    process.stdout.write('Claude');
  }
});
