'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

function atomicWriteJson(filePath, value) {
  const temporary = path.join(path.dirname(filePath), '.' + path.basename(filePath)
    + '.' + process.pid + '.' + randomBytes(8).toString('hex') + '.tmp');
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { atomicWriteJson };
