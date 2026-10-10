'use strict';
// Module custody plus a request-creation ceiling/audit for this one supervised campaign.
// The separate identity request guard retains its one-request ceiling unchanged.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const root = path.resolve(__dirname, '../..'), originalResolve = Module._resolveFilename;
Module._resolveFilename = function (...args) {
  const resolved = originalResolve.apply(this, args);
  if (path.isAbsolute(resolved)) {
    const relative = path.relative(root, fs.realpathSync(resolved));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('UNPROTECTED_MODULE_RESOLUTION');
  }
  return resolved;
};
// The existing transport alone supplies headers/body/signing and acquires permits. No retries or redirects here.
const action = process.argv[2];
if (['prepare', 'initialize-campaign', 'run-provider'].includes(action)) {
  const https = require('node:https'), http = require('node:http'), originalRequest = https.request;
  const endpoints = Object.freeze({ '/exchange/v1/users/info': 'USER_INFO',
    '/exchange/v1/derivatives/futures/orders': 'FUTURES_ORDERS', '/exchange/v1/derivatives/futures/positions': 'FUTURES_POSITIONS' });
  const limits = { USER_INFO: 3, FUTURES_ORDERS: 24, FUTURES_POSITIONS: 12 };
  const counts = { USER_INFO: 0, FUTURES_ORDERS: 0, FUTURES_POSITIONS: 0 }; let total = 0;
  const refuse = () => { throw Error('CAMPAIGN_PHYSICAL_REQUEST_FORBIDDEN'); };
  http.request = http.get = https.get = globalThis.fetch = refuse;
  https.request = function (url, options, callback) {
    const endpoint = url instanceof URL && Object.hasOwn(endpoints, url.pathname) ? endpoints[url.pathname] : undefined;
    if (action !== 'run-provider' || !endpoint || url.origin !== 'https://api.coindcx.com' || url.username || url.password || url.search || url.hash
      || options?.method !== 'POST' || total >= 39 || counts[endpoint] >= limits[endpoint] || (endpoint !== 'USER_INFO' && counts.USER_INFO === 0)) return refuse();
    total++; counts[endpoint]++;
    // Counts request-creation attempts, including a native factory throw. Never log headers, body or credentials.
    process.stdout.write(JSON.stringify({ outcome: 'CAMPAIGN_PHYSICAL_REQUEST_ATTEMPT', endpoint, attempt: total,
      counts: { ...counts }, recordedAt: new Date().toISOString() }) + '\n');
    return originalRequest.call(this, url, options, callback);
  };
}
