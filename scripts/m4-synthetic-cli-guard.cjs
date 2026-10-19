'use strict';
/* eslint @typescript-eslint/no-require-imports: "off" -- Node --require needs a synchronous CommonJS preload. */
/* global require, Buffer, URL */
// Explicit child preload only. Never loaded on harness import. Blocks credential-file reads and provider HTTP.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const denyEnv = file => {
  const name = file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString() : file;
  if (typeof name === 'string' && /^\.env(?:\.|$)/i.test(path.basename(name))) throw Error('SYNTHETIC_ENV_FILE_READ_REFUSED');
};
for (const name of ['readFileSync', 'readFile', 'createReadStream', 'openSync', 'open']) {
  const original = fs[name];
  fs[name] = function (file, ...args) { denyEnv(file); return original.call(this, file, ...args); };
}
const originalRead = fs.promises.readFile;
fs.promises.readFile = function (file, ...args) { denyEnv(file); return originalRead.call(this, file, ...args); };
const originalOpen = fs.promises.open;
fs.promises.open = function (file, ...args) { denyEnv(file); return originalOpen.call(this, file, ...args); };
for (const moduleName of ['node:http', 'node:https']) {
  const transport = require(moduleName);
  transport.request = transport.get = () => { throw Error('SYNTHETIC_PROVIDER_HTTP_REFUSED'); };
}
globalThis.fetch = () => { throw Error('SYNTHETIC_PROVIDER_HTTP_REFUSED'); };
