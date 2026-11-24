import type { CoinProfile } from '../coin-runtime';
import { Decimal } from '../core/decimal/decimal';
import type { InrFuturesInstrument } from '../integration/coindcx/models';
import type { PracticalBotReadClient } from '../integration/coindcx/live/practical-bot-orchestrator';
import { WorkspaceStore } from './workspace-store';

export function catalogMetadata(instrument: InrFuturesInstrument) {
  if (instrument.marginCurrency !== 'INR' || instrument.kind.toLowerCase() !== 'perpetual' || instrument.status.toLowerCase() !== 'active'
    || instrument.pair !== `B-${instrument.underlyingCurrency}_USDT`) throw new Error('CATALOG_COIN_UNAVAILABLE');
  return { underlying: instrument.underlyingCurrency, pair: instrument.pair, lotSize: instrument.quantityIncrement.toFixed(), tickSize: instrument.priceIncrement.toFixed(),
    maxLeverage: instrument.dynamicPositionLeverageTiers.length ? Decimal.max(...instrument.dynamicPositionLeverageTiers.map(t => t.leverage)).toFixed() : null };
}
/** Discovery is paged to avoid hundreds of metadata reads when opening the catalog. Every read uses the existing client budget. */
export class CoinCatalog {
  #pairs: { observedAtMs: number; pairs: string[] } | undefined;
  #metadata = new Map<string, { observedAtMs: number; value: ReturnType<typeof catalogMetadata> }>();
  constructor(readonly client: PracticalBotReadClient, readonly workspace: WorkspaceStore, readonly nowMs: () => number) {}
  private async pairs(): Promise<string[]> {
    if (!this.#pairs || this.nowMs() - this.#pairs.observedAtMs > 60_000) {
      const pairs = await this.client.listActiveInrFuturesInstruments();
      this.#pairs = { observedAtMs: this.nowMs(), pairs: [...new Set(pairs.filter(p => /^B-[A-Z0-9]{1,24}_USDT$/.test(p)))].sort() };
    }
    return this.#pairs.pairs;
  }
  public async list(q = '', offset = 0, limit = 6) {
    const pairs = (await this.pairs()).filter(p => p.includes(q.trim().toUpperCase()));
    const coins = [];
    for (const pair of pairs.slice(offset, offset + limit)) {
      let metadata = this.#metadata.get(pair);
      if (!metadata || this.nowMs() - metadata.observedAtMs > 300_000) {
        const instrument = await this.client.getInrFuturesInstrument(pair);
        if (instrument.status.toLowerCase() !== 'active' || instrument.kind.toLowerCase() !== 'perpetual' || instrument.marginCurrency !== 'INR') continue;
        metadata = { observedAtMs: this.nowMs(), value: catalogMetadata(instrument) }; this.#metadata.set(pair, metadata);
      }
      coins.push({ ...metadata.value, alreadyTracked: this.workspace.trackedCoins().includes(metadata.value.underlying) });
    }
    return { coins, total: pairs.length, offset, limit, hasMore: offset + limit < pairs.length, source: 'COINDCX_ACTIVE_INR_PERPETUALS' };
  }
  public async resolve(input: { underlying?: string | undefined; pair?: string | undefined }) {
    const pair = input.pair ?? `B-${input.underlying}_USDT`;
    if (!(await this.pairs()).includes(pair)) throw new Error('CATALOG_COIN_UNAVAILABLE');
    const metadata = catalogMetadata(await this.client.getInrFuturesInstrument(pair));
    if (input.underlying && metadata.underlying !== input.underlying || metadata.pair !== pair) throw new Error('CATALOG_COIN_UNAVAILABLE');
    this.#metadata.set(pair, { observedAtMs: this.nowMs(), value: metadata }); return metadata;
  }
}

/** New research assets inherit only non-live application policy; no frozen execution code is composed. */
export function trackedCoinProfiles(store: WorkspaceStore, configured: readonly CoinProfile[]): readonly CoinProfile[] {
  return store.trackedCoins().map(underlying => {
    const existing = configured.find(p => p.underlying === underlying);
    if (existing) return { ...existing, liveEnabled: false };
    return { underlying, enabled: true, dataEnabled: true, researchEnabled: true, paperEnabled: true, shadowEnabled: true, liveEnabled: false,
      timeframes: ['1m', '5m', '15m', '1h'], strategyAssignments: [], riskProfileId: 'DEFAULT_SAFE',
      defaultLeverage: new Decimal(1), configuredAbsoluteMaxLeverage: new Decimal(20) };
  });
}
