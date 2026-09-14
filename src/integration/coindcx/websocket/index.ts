export * from './types';
export * from './backoff';
export * from './channel-builder';
export * from './schemas';
// [F14-02 §16] Deliberately NOT `export * from './socket-adapter'`: the
// in-memory `FakeCoinDcxSocket`/`FakeCoinDcxSocketFactory` test doubles must
// not be reachable from the production CoinDCX barrel, so no production
// consumer can assemble a fabricated market-data acquisition path out of
// publicly exported pieces. Both remain importable by their concrete module
// path (`./websocket/socket-adapter`) for the tests that legitimately need
// them — which is how every existing test already imports them.
export { COINDCX_DEFAULT_SOCKET_ENDPOINT, ProductionCoinDcxSocket, ProductionCoinDcxSocketFactory } from './socket-adapter';
export * from './public-stream';
export * from './private-stream';
export * from './coordinator';
