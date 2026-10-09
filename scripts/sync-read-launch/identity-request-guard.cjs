'use strict';
// Instrument the existing request-creation function. No HTTP implementation, signing, response inspection or retries.
const fs = require('node:fs'), http = require('node:http'), https = require('node:https'), Module = require('node:module'), path = require('node:path');
const root = path.resolve(__dirname, '../..');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (...args) {
  const resolved = originalResolve.apply(this, args);
  if (path.isAbsolute(resolved)) {
    const real = fs.realpathSync(resolved), rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('UNPROTECTED_MODULE_RESOLUTION');
  }
  return resolved;
};
let policy = null, attempts = 0;
const originals = { http: http.request, https: https.request };
function wrap(protocol) {
  return function (url, options, callback) {
    if (!policy) throw Error('IDENTITY_NETWORK_NOT_ARMED');
    const u = url instanceof URL ? url : new URL(url);
    if (u.origin !== policy.origin || u.pathname !== '/exchange/v1/users/info' || u.search || u.hash || u.username || u.password
      || options?.method !== 'POST' || protocol !== u.protocol.slice(0, -1)) throw Error('IDENTITY_ENDPOINT_NOT_ALLOWED');
    if (attempts !== 0) throw Error('ONE_PHYSICAL_REQUEST_CEILING');
    const fd = fs.openSync(policy.journal, 'wx');
    attempts = 1; // Conservatively consumed before the original factory, including a throwing/ambiguous factory.
    try { fs.writeFileSync(fd, JSON.stringify({ kind: 'IDENTITY_HTTP_CREATION_ATTEMPT', attempts, at: new Date().toISOString(), origin: u.origin,
      endpoint: 'USER_INFO', method: 'POST', path: u.pathname })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return originals[protocol].call(this, url, options, callback);
  };
}
Object.defineProperty(http, 'request', { value: wrap('http'), writable: false, configurable: false });
Object.defineProperty(https, 'request', { value: wrap('https'), writable: false, configurable: false });
http.get = https.get = () => { throw Error('IDENTITY_GET_NOT_ALLOWED'); };
globalThis.fetch = () => { throw Error('IDENTITY_FETCH_NOT_ALLOWED'); };
module.exports = Object.freeze({ arm(origin, journal) {
  if (policy || !path.isAbsolute(journal) || fs.existsSync(journal)) throw Error('IDENTITY_GUARD_ALREADY_USED_OR_JOURNALED');
  const u = new URL(origin);
  if (origin !== 'https://api.coindcx.com' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port && u.origin === origin)) throw Error('IDENTITY_ORIGIN_NOT_ALLOWED');
  policy = Object.freeze({ origin, journal });
}, inspect: () => ({ physicalRequestCreationAttempts: attempts, armed: policy !== null }) });
