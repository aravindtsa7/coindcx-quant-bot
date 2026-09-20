import { describe, expect, it } from 'vitest';
import { CoinConfigError } from '../../src/core/errors/app-error';
import { InstrumentDetailsResponseSchema } from '../../src/integration/coindcx/schemas';
import { normalizeInstrument } from '../../src/integration/coindcx/normalizers';
import {
  determineEntryEligibility,
  mapInstrumentToMetadata,
} from '../../src/coin-runtime/instrument-mapper';
import {
  DEFAULT_COIN_PROFILES,
  loadCoinProfiles,
} from '../../src/app/config/coins';
import {
  CoinRegistry,
  CoinRuntimeBootstrapService,
  CoinProfile,
  validateCoinProfile,
  validateCoinProfiles,
} from '../../src/coin-runtime';
import {
  buildFuturesCandleChannel,
  buildFuturesOrderbookChannel,
  buildFuturesRealtimeMarkChannel,
  buildFuturesTradeChannel,
} from '../../src/integration/coindcx/websocket/channel-builder';
import { createCanonicalCandle1m } from '../../src/market-data/models';
import {
  planHistoricalChunks,
  validateHistoricalPair,
} from '../../src/market-data/historical';
import { aggregateExactBucket } from '../../src/market-data/higher-timeframe/aggregate-exact-bucket';
import { adaptCanonicalCandle1m } from '../../src/indicators/candle/adapter';
import { computeEma } from '../../src/indicators/ema';
import { computeRsi } from '../../src/indicators/rsi';
import { computeAtr } from '../../src/indicators/atr';
import {
  BacktestDecimal,
  BacktestEngine,
  computeBacktestInstrumentSpecSnapshotId,
  InMemoryBacktestDatasetSource,
} from '../../src/backtest';
import {
  createBacktestInstrumentSpec,
  validateOrderIntent,
} from '../../src/backtest/instrument';
import {
  PHASE10_STRATEGY_DEFINITIONS,
  StrategyRegistry,
} from '../../src/strategies';
import { atrBreakoutV1Definition } from '../../src/strategies/implementations/atr-breakout';
import { emaTrendV1Definition } from '../../src/strategies/implementations/ema-trend';
import { rsiMomentumV1Definition } from '../../src/strategies/implementations/rsi-momentum';
import { multiTimeframeTrendV1Definition } from '../../src/strategies/implementations/multi-timeframe-trend';
import {
  buildInstrumentEconomicsSnapshot,
  validateInstrumentEconomicsSnapshot,
} from '../../src/execution/instrument-economics';
import { createRiskPolicy } from '../../src/risk';
import { verifyCurrentValuation } from '../../src/risk/valuation';
import type {
  CanonicalPositionValuation,
  PairRiskSnapshot,
  RiskPolicy,
  SettlementConversionSnapshot,
} from '../../src/risk/types';
import { buildPairRankingRun, composeRankingRunSet } from '../../src/ranking/core';
import { rankStrategyCandidates, isAuthoritativeRankingRunSet } from '../../src/ranking/engine';
import { P15_COMPONENT_IDS } from '../../src/ranking/policy';
import type {
  RankingCandidateEvidence,
  RankingComponentMetric,
  RankingComponentMetrics,
} from '../../src/ranking/types';
import { sha256CanonicalJson } from '../../src/backtest/canonical-json';
import { Decimal } from '../../src/core/decimal/decimal';
import { planWithGitSourceVerifier } from '../../src/research/strategy-coin-matrix/planner';
import { planResearchValidationWithGitSourceVerifier } from '../../src/research/research-validation/planner';
import { executeResearchValidationWithGitSourceVerifier } from '../../src/research/research-validation/executor';
import type { ResearchValidationPlanInput } from '../../src/research/research-validation/types';
import { validationInput } from '../unit/research/research-validation/helpers';
import {
  BASE,
  candles,
  ControlledGitVerifier,
  datasetManifest,
  matrixInput,
  registry as matrixRegistry,
  resources as matrixResources,
} from '../unit/research/strategy-coin-matrix/helpers';
import {
  candle as makeBacktestCandle,
  config as makeBacktestConfig,
  ScriptedParticipant,
} from '../unit/backtest/helpers';
import {
  getCapturedSolInstrumentPayload,
  getRawSolInstrumentSha256,
  RAW_SOL_FIXTURE_SHA256,
} from '../fixtures/coindcx/sol-instrument';

/**
 * Phase 16 Acceptance Hardened Integration Proof: SOL Generic Onboarding.
 *
 * This test suite distinguishes:
 * - FULL PRODUCTION-PATH PROOFS (genuine multi-phase pipeline execution through production roots)
 * - STRUCTURAL / COMPONENT COMPATIBILITY PROOFS (verifying interface, schema, precision, and policy compatibility)
 */

describe('Phase 16 — New-Coin Architecture Proof (SOL Onboarding)', () => {
  const capturedSolRaw = getCapturedSolInstrumentPayload();

  // =========================================================================
  // 1. DETERMINISTIC FIXTURE PROVENANCE & SCHEMA PARSING PROOF
  // =========================================================================
  describe('1. Deterministic Fixture Provenance & Exchange Metadata Parsing', () => {
    it('verifies deterministic raw SOL fixture provenance and exact SHA-256 hash', () => {
      const hash = getRawSolInstrumentSha256();
      expect(hash).toBe(RAW_SOL_FIXTURE_SHA256);
      expect(RAW_SOL_FIXTURE_SHA256).toBe('94580b8731fd961adb6686141ac4e2d299d7db16120b57dce321d18984003f7e');

      const payload = getCapturedSolInstrumentPayload();
      const tiers = payload.instrument.dynamic_position_leverage_details;

      // Raw exchange metadata has 11 dynamic tiers ranging from 2x up to 100x
      expect(Object.keys(tiers)).toHaveLength(11);
      expect(tiers['2']).toBe(33800000);
      expect(tiers['100']).toBe(10000);

      // Base leverage fields in exchange metadata
      expect(payload.instrument.max_leverage_long).toBe(5);
      expect(payload.instrument.max_leverage_short).toBe(5);

      // Verify that bot configuration policy cap (20x) is distinct from exchange max leverage (100x)
      const profiles = loadCoinProfiles();
      const solProfile = profiles.find((p) => p.underlying === 'SOL');
      expect(solProfile?.configuredAbsoluteMaxLeverage?.toString()).toBe('20');
    });

    it('structural compatibility: parses captured SOL instrument through InstrumentDetailsResponseSchema', () => {
      const parsed = InstrumentDetailsResponseSchema.safeParse(capturedSolRaw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      expect(parsed.data.instrument.pair).toBe('B-SOL_USDT');
      expect(parsed.data.instrument.underlying_currency_short_name).toBe('SOL');
      expect(parsed.data.instrument.margin_currency_short_name).toBe('INR');
      expect(parsed.data.instrument.kind).toBe('perpetual');
      expect(parsed.data.instrument.status).toBe('active');
    });

    it('structural compatibility: normalizes captured SOL instrument into lossless decimal models', () => {
      const parsed = InstrumentDetailsResponseSchema.parse(capturedSolRaw);
      const normalized = normalizeInstrument(parsed.instrument);

      expect(normalized.pair).toBe('B-SOL_USDT');
      expect(normalized.underlyingCurrency).toBe('SOL');
      expect(normalized.unitContractValue.toString()).toBe('1');
      expect(normalized.priceIncrement.toString()).toBe('0.01');
      expect(normalized.quantityIncrement.toString()).toBe('0.01');
      expect(normalized.minTradeSize.toString()).toBe('0.01');
      expect(normalized.minNotional.toString()).toBe('6');
      expect(normalized.marginCurrency).toBe('INR');
      expect(normalized.dynamicPositionLeverageTiers.length).toBe(11);
      expect(normalized.dynamicSafetyMarginTiers.length).toBe(11);
    });

    it('structural compatibility: maps normalized instrument to CoinRuntime CoinMetadata entity', () => {
      const parsed = InstrumentDetailsResponseSchema.parse(capturedSolRaw);
      const normalized = normalizeInstrument(parsed.instrument);
      const metadata = mapInstrumentToMetadata(normalized, 'SOL');

      expect(metadata.pair).toBe('B-SOL_USDT');
      expect(metadata.underlying).toBe('SOL');
      expect(metadata.marginCurrency).toBe('INR');
      expect(metadata.unitContractValue.toString()).toBe('1');
      expect(metadata.priceIncrement.toString()).toBe('0.01');
      expect(metadata.quantityIncrement.toString()).toBe('0.01');
    });
  });

  // =========================================================================
  // 2. COIN RUNTIME LIFECYCLE & ENTRY ELIGIBILITY PROOF
  // =========================================================================
  describe('2. Coin Runtime Lifecycle & Entry Eligibility', () => {
    const solProfile: CoinProfile = Object.freeze({
      underlying: 'SOL',
      enabled: true,
      dataEnabled: true,
      researchEnabled: true,
      paperEnabled: false,
      shadowEnabled: false,
      liveEnabled: false,
      timeframes: Object.freeze(['1m', '5m', '15m', '1h'] as const),
      strategyAssignments: Object.freeze([]),
      riskProfileId: 'DEFAULT_SAFE',
      defaultLeverage: new Decimal(1),
      configuredAbsoluteMaxLeverage: new Decimal(20),
    });

    it('production-path: determines entry eligibility for SOL as ELIGIBLE', () => {
      const parsed = InstrumentDetailsResponseSchema.parse(capturedSolRaw);
      const normalized = normalizeInstrument(parsed.instrument);
      const metadata = mapInstrumentToMetadata(normalized, 'SOL');
      const eligibility = determineEntryEligibility(solProfile, metadata);

      expect(eligibility).toBe('ELIGIBLE');
    });

    it('production-path: validates SOL coin profile using strict schema', () => {
      expect(() => validateCoinProfile(solProfile)).not.toThrow();
    });

    it('production-path: registers SOL in CoinRegistry and transitions to DISCOVERED state', () => {
      const registry = new CoinRegistry();
      const parsed = InstrumentDetailsResponseSchema.parse(capturedSolRaw);
      const normalized = normalizeInstrument(parsed.instrument);
      const metadata = mapInstrumentToMetadata(normalized, 'SOL');

      registry.register({
        status: 'DISCOVERED',
        profile: solProfile,
        instrument: metadata,
        lifecycle: 'DISCOVERED',
        entryEligibility: 'ELIGIBLE',
      });

      expect(registry.list()).toHaveLength(1);
      expect(registry.hasUnderlying('SOL')).toBe(true);
      expect(registry.hasPair('B-SOL_USDT')).toBe(true);
      const coin = registry.getByUnderlying('SOL');
      expect(coin.lifecycle).toBe('DISCOVERED');
      expect(coin.instrument?.unitContractValue.toString()).toBe('1');
    });

    it('production-path: bootstraps SOL through CoinRuntimeBootstrapService', async () => {
      const registry = new CoinRegistry();
      const mockDiscoveryClient = {
        findActiveInrPerpetualByUnderlying: async (underlying: string) => {
          if (underlying === 'SOL') {
            return normalizeInstrument(InstrumentDetailsResponseSchema.parse(capturedSolRaw).instrument);
          }
          return null;
        },
      };

      const bootstrapService = new CoinRuntimeBootstrapService(
        mockDiscoveryClient,
        registry
      );

      const result = await bootstrapService.bootstrap([solProfile]);
      expect(result.successful).toHaveLength(1);
      expect(result.failures).toHaveLength(0);
      expect(result.successful[0]?.profile.underlying).toBe('SOL');

      const bootstrapped = registry.getByUnderlying('SOL');
      expect(bootstrapped).toBeDefined();
      expect(bootstrapped.lifecycle).toBe('DISCOVERED');
    });
  });

  // =========================================================================
  // 3. WEBSOCKET SUBSCRIPTION CHANNEL PROOF
  // =========================================================================
  describe('3. Public WebSocket Channel Construction', () => {
    const pair = 'B-SOL_USDT';

    it('structural compatibility: derives canonical 1m candlestick channel for B-SOL_USDT', () => {
      const channel = buildFuturesCandleChannel(pair, '1m');
      expect(channel).toBe('B-SOL_USDT_1m-futures');
    });

    it('structural compatibility: derives public trade channel for B-SOL_USDT', () => {
      const channel = buildFuturesTradeChannel(pair);
      expect(channel).toBe('B-SOL_USDT@trades-futures');
    });

    it('structural compatibility: derives orderbook depth 50 channel for B-SOL_USDT', () => {
      const channel = buildFuturesOrderbookChannel(pair, 50);
      expect(channel).toBe('B-SOL_USDT@orderbook@50-futures');
    });

    it('structural compatibility: derives realtime mark price channel', () => {
      const channel = buildFuturesRealtimeMarkChannel();
      expect(channel).toBe('currentPrices@futures@rt');
    });
  });

  // =========================================================================
  // 4. MARKET DATA, HISTORICAL & INDICATORS PROOF
  // =========================================================================
  describe('4. Canonical Market Data, Historical Partitioning & Technical Indicators', () => {
    const pair = 'B-SOL_USDT';
    const baseOpenTimeMs = 1704067200000;

    it('structural compatibility: creates and validates CanonicalCandle1m for B-SOL_USDT', () => {
      const candle = createCanonicalCandle1m({
        pair,
        openTimeMs: baseOpenTimeMs,
        open: '148.50',
        high: '151.20',
        low: '147.80',
        close: '150.00',
        volume: '1250.55',
        quoteVolume: null,
        source: 'REST_HISTORICAL',
        finalizedAtMs: baseOpenTimeMs + 60000,
        providerEventTimeMs: null,
        generationId: null,
      });

      expect(candle.pair).toBe('B-SOL_USDT');
      expect(candle.open.toString()).toBe('148.50');
      expect(candle.high.toString()).toBe('151.20');
      expect(candle.low.toString()).toBe('147.80');
      expect(candle.close.toString()).toBe('150.00');
      expect(candle.volume.toString()).toBe('1250.55');
      expect(candle.closeTimeExclusiveMs).toBe(baseOpenTimeMs + 60000);
    });

    it('structural compatibility: plans historical dataset chunk ranges for B-SOL_USDT', () => {
      expect(() => validateHistoricalPair(pair)).not.toThrow();

      const fromMs = baseOpenTimeMs;
      const toMs = baseOpenTimeMs + 24 * 60 * 60 * 1000; // 24 hours
      const chunks = planHistoricalChunks({
        fromInclusiveMs: fromMs,
        toExclusiveMs: toMs,
      }, 360);

      expect(chunks.length).toBe(4);
      expect(chunks[0]!.fromInclusiveMs).toBe(fromMs);
      expect(chunks[3]!.toExclusiveMs).toBe(toMs);
    });

    it('structural compatibility: aggregates 1m SOL candles into exact 5m higher-timeframe bucket', () => {
      const oneMinuteCandles = [
        createCanonicalCandle1m({
          pair,
          openTimeMs: baseOpenTimeMs,
          open: '150.00',
          high: '152.00',
          low: '149.50',
          close: '151.00',
          volume: '100.00',
          quoteVolume: null,
          source: 'REST_HISTORICAL',
          finalizedAtMs: baseOpenTimeMs + 60000,
          providerEventTimeMs: null,
          generationId: null,
        }),
        createCanonicalCandle1m({
          pair,
          openTimeMs: baseOpenTimeMs + 60000,
          open: '151.00',
          high: '153.50',
          low: '150.50',
          close: '153.00',
          volume: '120.00',
          quoteVolume: null,
          source: 'REST_HISTORICAL',
          finalizedAtMs: baseOpenTimeMs + 120000,
          providerEventTimeMs: null,
          generationId: null,
        }),
        createCanonicalCandle1m({
          pair,
          openTimeMs: baseOpenTimeMs + 120000,
          open: '153.00',
          high: '154.00',
          low: '152.00',
          close: '152.50',
          volume: '80.00',
          quoteVolume: null,
          source: 'REST_HISTORICAL',
          finalizedAtMs: baseOpenTimeMs + 180000,
          providerEventTimeMs: null,
          generationId: null,
        }),
        createCanonicalCandle1m({
          pair,
          openTimeMs: baseOpenTimeMs + 180000,
          open: '152.50',
          high: '153.00',
          low: '148.00',
          close: '149.00',
          volume: '200.00',
          quoteVolume: null,
          source: 'REST_HISTORICAL',
          finalizedAtMs: baseOpenTimeMs + 240000,
          providerEventTimeMs: null,
          generationId: null,
        }),
        createCanonicalCandle1m({
          pair,
          openTimeMs: baseOpenTimeMs + 240000,
          open: '149.00',
          high: '150.50',
          low: '148.50',
          close: '150.25',
          volume: '150.00',
          quoteVolume: null,
          source: 'REST_HISTORICAL',
          finalizedAtMs: baseOpenTimeMs + 300000,
          providerEventTimeMs: null,
          generationId: null,
        }),
      ];

      const aggregated5m = aggregateExactBucket(oneMinuteCandles, 5);

      expect(aggregated5m.pair).toBe('B-SOL_USDT');
      expect(aggregated5m.openTimeMs).toBe(baseOpenTimeMs);
      expect(aggregated5m.closeTimeExclusiveMs).toBe(baseOpenTimeMs + 300000);
      expect(aggregated5m.open.toString()).toBe('150.00');
      expect(aggregated5m.high.toString()).toBe('154.00');
      expect(aggregated5m.low.toString()).toBe('148.00');
      expect(aggregated5m.close.toString()).toBe('150.25');
      expect(aggregated5m.volume.toString()).toBe('650');
    });

    it('structural compatibility: calculates EMA, RSI, and ATR indicators over synthetic SOL candle series', () => {
      const candleCount = 30;
      const solCandles = Array.from({ length: candleCount }, (_, idx) => {
        const time = baseOpenTimeMs + idx * 60000;
        const closeVal = (150 + Math.sin(idx) * 5).toFixed(2);
        const highVal = (Number(closeVal) + 1.5).toFixed(2);
        const lowVal = (Number(closeVal) - 1.5).toFixed(2);
        return createCanonicalCandle1m({
          pair,
          openTimeMs: time,
          open: closeVal,
          high: highVal,
          low: lowVal,
          close: closeVal,
          volume: '50.0',
          quoteVolume: null,
          source: 'REST_HISTORICAL',
          finalizedAtMs: time + 60000,
          providerEventTimeMs: null,
          generationId: null,
        });
      });

      const indicatorCandles = solCandles.map(adaptCanonicalCandle1m);

      const emaPoints = computeEma(indicatorCandles, {
        pair,
        timeframeMinutes: 1,
        bootstrapStartOpenTimeMs: baseOpenTimeMs,
        period: 9,
        priceSource: 'CLOSE',
      });
      expect(emaPoints.length).toBe(solCandles.length);
      const lastEma = emaPoints[emaPoints.length - 1];
      expect(lastEma?.value).not.toBeNull();
      expect(Number(lastEma!.value!.value)).toBeGreaterThan(140);
      expect(Number(lastEma!.value!.value)).toBeLessThan(160);

      const rsiPoints = computeRsi(indicatorCandles, {
        pair,
        timeframeMinutes: 1,
        bootstrapStartOpenTimeMs: baseOpenTimeMs,
        period: 14,
        priceSource: 'CLOSE',
      });
      expect(rsiPoints.length).toBe(solCandles.length);
      const lastRsi = rsiPoints[rsiPoints.length - 1];
      expect(lastRsi?.value).not.toBeNull();
      expect(Number(lastRsi!.value!.value)).toBeGreaterThanOrEqual(0);
      expect(Number(lastRsi!.value!.value)).toBeLessThanOrEqual(100);

      const atrPoints = computeAtr(indicatorCandles, {
        pair,
        timeframeMinutes: 1,
        bootstrapStartOpenTimeMs: baseOpenTimeMs,
        period: 14,
      });
      expect(atrPoints.length).toBe(solCandles.length);
      const lastAtr = atrPoints[atrPoints.length - 1];
      expect(lastAtr?.value).not.toBeNull();
      expect(Number(lastAtr!.value!.value)).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 5. BACKTEST ENGINE & STRATEGY FRAMEWORK PROOFS
  // =========================================================================
  describe('5. Backtest Engine & Strategy Framework Integration', () => {
    it('production-path: executes a minimal deterministic SOL backtest through the actual BacktestEngine root', async () => {
      const solCandles = [
        makeBacktestCandle(0, { open: '150', high: '155', low: '148', close: '152' }, 'B-SOL_USDT'),
        makeBacktestCandle(1, { open: '152', high: '160', low: '151', close: '158' }, 'B-SOL_USDT'),
        makeBacktestCandle(2, { open: '158', high: '165', low: '156', close: '162' }, 'B-SOL_USDT'),
      ];

      const participant = new ScriptedParticipant([
        { submitOrders: [{ pair: 'B-SOL_USDT', type: 'MARKET', side: 'BUY', quantity: '1', reduceOnly: false }] },
      ]);

      const instrumentSpecParams = {
        pair: 'B-SOL_USDT',
        priceIncrement: new BacktestDecimal('0.01'),
        quantityIncrement: new BacktestDecimal('0.01'),
        minQuantity: new BacktestDecimal('0.01'),
        minTradeSize: new BacktestDecimal('0.01'),
        minNotional: new BacktestDecimal('6.0'),
        contractMultiplier: new BacktestDecimal('1.0'),
      };

      const solConfig = makeBacktestConfig(solCandles, participant, {
        instrumentSpec: {
          ...instrumentSpecParams,
          instrumentSpecSnapshotId: computeBacktestInstrumentSpecSnapshotId(instrumentSpecParams),
        },
      });

      const outcome = await new BacktestEngine(solConfig).run();
      expect(outcome.terminalStatus).toBe('COMPLETED');
      if (outcome.terminalStatus !== 'COMPLETED') {
        throw new Error('Backtest failed unexpectedly');
      }
      expect(outcome.totalFills).toBe(1);
    });

    it('structural compatibility: creates backtest instrument spec with SOL contract multiplier of 1.0', () => {
      const spec = createBacktestInstrumentSpec({
        pair: 'B-SOL_USDT',
        priceIncrement: new Decimal('0.01'),
        quantityIncrement: new Decimal('0.01'),
        minQuantity: new Decimal('0.01'),
        minTradeSize: new Decimal('0.01'),
        minNotional: new Decimal('6.0'),
        unitContractValue: new Decimal('1.0'),
      });

      expect(spec.pair).toBe('B-SOL_USDT');
      expect(spec.contractMultiplier.value).toBe('1');
      expect(spec.priceIncrement.value).toBe('0.01');
      expect(spec.quantityIncrement.value).toBe('0.01');
      expect(spec.minNotional.value).toBe('6');
      expect(spec.instrumentSpecSnapshotId).toBeDefined();

      const validated = validateOrderIntent(
        {
          pair: 'B-SOL_USDT',
          type: 'POST_ONLY_LIMIT',
          side: 'BUY',
          quantity: '5.25',
          limitPrice: '150.25',
        },
        spec,
        { side: 'FLAT', quantity: spec.minQuantity }
      );
      expect(validated.quantity.value).toBe('5.25');
      expect(validated.limitPrice?.value).toBe('150.25');
    });

    it('production-path: instantiates all 4 existing strategy kernels bound to B-SOL_USDT via definitions', () => {
      const pair = 'B-SOL_USDT';
      const baseMs = 1704067200000;
      const b1 = [{ timeframeMinutes: 1, bootstrapStartOpenTimeMs: baseMs }];
      const b1And5 = [
        { timeframeMinutes: 1, bootstrapStartOpenTimeMs: baseMs },
        { timeframeMinutes: 5, bootstrapStartOpenTimeMs: baseMs },
      ];

      const atrBreakout = atrBreakoutV1Definition.createKernel({
        pair,
        parameters: { timeframeMinutes: 1, atrPeriod: 14, breakoutMultiplier: '2.0' },
        indicatorBootstrapIdentity: b1,
      });
      expect(atrBreakout.pair).toBe(pair);
      expect(atrBreakout.strategyId).toBe('ATR_BREAKOUT');

      const emaTrend = emaTrendV1Definition.createKernel({
        pair,
        parameters: { timeframeMinutes: 1, fastPeriod: 9, slowPeriod: 21, priceSource: 'CLOSE' },
        indicatorBootstrapIdentity: b1,
      });
      expect(emaTrend.pair).toBe(pair);
      expect(emaTrend.strategyId).toBe('EMA_TREND');

      const rsiMomentum = rsiMomentumV1Definition.createKernel({
        pair,
        parameters: { timeframeMinutes: 1, period: 14, longThreshold: '70.0', shortThreshold: '30.0', priceSource: 'CLOSE' },
        indicatorBootstrapIdentity: b1,
      });
      expect(rsiMomentum.pair).toBe(pair);
      expect(rsiMomentum.strategyId).toBe('RSI_MOMENTUM');

      const mtfTrend = multiTimeframeTrendV1Definition.createKernel({
        pair,
        parameters: { timeframes: [1, 5], fastPeriod: 9, slowPeriod: 21, priceSource: 'CLOSE' },
        indicatorBootstrapIdentity: b1And5,
      });
      expect(mtfTrend.pair).toBe(pair);
      expect(mtfTrend.strategyId).toBe('MULTI_TIMEFRAME_TREND');
    });

    it('production-path: registers strategies and creates kernels via StrategyRegistry with pair B-SOL_USDT', () => {
      const registry = new StrategyRegistry();
      for (const def of PHASE10_STRATEGY_DEFINITIONS) {
        registry.register(def);
      }

      const kernel = registry.create({
        strategyId: 'EMA_TREND',
        strategyVersion: '1.0.0',
        pair: 'B-SOL_USDT',
        parameters: { timeframeMinutes: 1, fastPeriod: 9, slowPeriod: 21, priceSource: 'CLOSE' },
        indicatorBootstrapIdentity: [{ timeframeMinutes: 1, bootstrapStartOpenTimeMs: 1704067200000 }],
      });

      expect(kernel.pair).toBe('B-SOL_USDT');
      expect(kernel.strategyId).toBe('EMA_TREND');
      expect(kernel.strategyInstanceId).toBeDefined();
    });

    it('production-path: includes B-SOL_USDT in Strategy × Coin matrix planning without a SOL strategy subclass', async () => {
      const solResources = matrixResources('B-SOL_USDT');
      const input = matrixInput([solResources], false);
      const dependencies = { registry: matrixRegistry(), pairResources: [solResources] };
      const planResult = await planWithGitSourceVerifier(input, dependencies, new ControlledGitVerifier());

      expect(planResult.plan.pairs).toHaveLength(1);
      expect(planResult.plan.pairs[0]!.pair).toBe('B-SOL_USDT');
      expect(planResult.cells.length).toBeGreaterThan(0);
      for (const cell of planResult.cells) {
        expect(cell.pair).toBe('B-SOL_USDT');
        expect(cell.strategyId).toBe('EMA_TREND');
      }
    });
  });

  // =========================================================================
  // 6. RISK VALUATION & PAPER ECONOMICS COMPATIBILITY PROOFS
  // =========================================================================
  describe('6. Risk Valuation & Paper Instrument Economics Compatibility', () => {
    it('structural compatibility: verifies current valuation on a SOL position with contractMultiplier = 1', () => {
      const evaluationTimeMs = 1704067200000;

      const canonicalValuation: CanonicalPositionValuation = {
        valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1',
        valuationPriceField: 'markPriceUsdt',
        valuationPriceUsdt: '150.00',
        valuationPriceSourceId: 'COINDCX_FUTURES_RT_MARK_V1',
        valuationPriceSourceTimeMs: evaluationTimeMs,
        valuationPriceObservedAtMs: evaluationTimeMs,
        contractMultiplier: '1',
        conversionMarket: 'USDT_INR',
        conversionRateInrPerUsdt: '85.00',
        conversionSourceId: 'COINDCX_SPOT_RT_USDT_INR_V1',
        unitValuationInrPerQty: '12750', // 150 * 1 * 85
        aggregateCurrentNotionalInr: '127500', // 10 * 12750
      };

      const pairSnapshot: PairRiskSnapshot = {
        pair: 'B-SOL_USDT',
        instrumentSpecSnapshotId: 'a'.repeat(64),
        status: 'active',
        exitOnly: false,
        priceIncrement: '0.01',
        quantityIncrement: '0.01',
        minPrice: '0.441',
        maxPrice: '972.8',
        minQuantity: '0.01',
        maxQuantity: '950000',
        minTradeSize: '0.01',
        minNotional: '6.0',
        maxNotional: null,
        contractMultiplier: '1',
        position: {
          state: 'OPEN',
          positionId: 'pos-1',
          positionDirection: 'LONG',
          quantityMagnitude: '10',
          valuation: canonicalValuation,
        },
        ownership: {
          status: 'RECONCILED',
          positionState: 'OPEN',
          accountId: 'acct-1',
          pair: 'B-SOL_USDT',
          positionId: 'pos-1',
          instanceOwnership: [],
        },
        provenance: {
          sourceId: 'COINDCX_FUTURES_RT_MARK_V1',
          sourceTimeMs: evaluationTimeMs,
          observedAtMs: evaluationTimeMs,
          contentSha256: 'f'.repeat(64),
        },
      };

      const settlement: SettlementConversionSnapshot = {
        conversionMarketId: 'USDT_INR',
        sourceCurrency: 'USDT',
        targetCurrency: 'INR',
        marginCurrency: 'INR',
        rateInrPerUsdt: '85.00',
        provenance: {
          sourceId: 'COINDCX_SPOT_RT_USDT_INR_V1',
          sourceTimeMs: evaluationTimeMs,
          observedAtMs: evaluationTimeMs,
          contentSha256: 'f'.repeat(64),
        },
      };

      const policy: RiskPolicy = createRiskPolicy({
        globalConfig: {
          globalMaxLeverage: '20',
          globalMaxOpenNotionalInr: '1000000',
          globalMaxConcurrentPositions: 20,
          globalMaxDailyLossInr: '50000',
          globalDailyLossLimitPercent: null,
          globalMaxDrawdownPercent: '50',
        },
        pairConfig: {
          pair: 'B-SOL_USDT',
          pairMaxLeverage: '20',
          pairMaxExposureInr: '500000',
          pairMaxConcurrentPositions: 10,
        },
        modeConfig: {
          mode: 'NORMAL',
          riskPerTradePercent: '1',
          maxNotionalPerTradeInr: '100000',
          leverageRecommendation: '5',
          maxConcurrentExposureInr: '800000',
          maxCoinExposureInr: '400000',
          maxStrategyExposureInr: '300000',
          maxConcurrentPositions: 10,
          maxDailyLossInr: '40000',
          dailyLossLimitPercent: null,
          maxDrawdownPercent: '40',
          consecutiveLossLimit: 3,
          cooldownMs: 60000,
        },
        sourceAuthorityPolicy: {
          accountRiskSourceId: 'account-source',
          pairRiskSourceId: 'COINDCX_FUTURES_RT_MARK_V1',
          exposureSourceId: 'exposure-source',
          leverageTierSourceId: 'tier-source',
          conversionSourceId: 'COINDCX_SPOT_RT_USDT_INR_V1',
        },
        freshnessPolicy: {
          maxAccountSnapshotAgeMs: 60000,
          maxPairSnapshotAgeMs: 60000,
          maxExposureSnapshotAgeMs: 60000,
          maxLeverageTierSnapshotAgeMs: 60000,
          maxSettlementRateSnapshotAgeMs: 60000,
        },
        valuationPolicy: {
          valuationMethodVersion: 'P13_MARK_PRICE_MULTIPLIER_SETTLEMENT_V1',
          valuationPriceField: 'markPriceUsdt',
          valuationUnitScale: 2,
          valuationUnitRounding: 'ROUND_HALF_UP',
        },
      });

      const check = verifyCurrentValuation(
        pairSnapshot,
        settlement,
        policy,
        evaluationTimeMs
      );
      expect(check.reasons).toEqual([]);
      expect(check.unitValuationInrPerQty).toBe('12750');
      expect(check.aggregateCurrentNotionalInr).toBe('127500');
    });

    it('structural compatibility: builds and validates PaperInstrumentEconomicsSnapshot for B-SOL_USDT', () => {
      const snapshot = buildInstrumentEconomicsSnapshot({
        sourceId: 'COINDCX_INR_FUTURES_INSTRUMENT_REST_V1',
        instrumentSpecIdentityPolicyId: 'P14_PRODUCTION_INSTRUMENT_SPEC_IDENTITY_V1',
        instrumentSpecSnapshotId: 'c'.repeat(64),
        pair: 'B-SOL_USDT',
        contractMultiplier: '1',
        priceIncrement: '0.01',
        quantityIncrement: '0.01',
      });

      expect(snapshot.pair).toBe('B-SOL_USDT');
      expect(snapshot.contractMultiplier).toBe('1');
      expect(snapshot.priceIncrement).toBe('0.01');
      expect(snapshot.quantityIncrement).toBe('0.01');
      expect(snapshot.instrumentEconomicsSnapshotId).toBeDefined();

      const validated = validateInstrumentEconomicsSnapshot(snapshot);
      expect(validated.instrumentEconomicsSnapshotId).toBe(snapshot.instrumentEconomicsSnapshotId);
    });
  });

  // =========================================================================
  // 7. PHASE 12 -> PHASE 15 AUTHORITY & RANKING PROOFS
  // =========================================================================
  describe('7. Phase 12 Research Validation -> Phase 15 Ranking Authority Integration', () => {
    it('production-path: proves genuine SOL Phase 12 PASSED evidence enters Phase 15 via public entry point without authority bypass', async () => {
      const pair = 'B-SOL_USDT';
      const days = 10;
      const rows = candles(pair, days * 24 * 60);
      const base = matrixResources(pair);
      const resource = {
        ...base,
        datasetManifest: datasetManifest(rows),
        datasetSource: new InMemoryBacktestDatasetSource('p15-ranking-sol-memory', rows),
      };
      const definitions = matrixRegistry();
      const deps = { registry: definitions, pairResources: [resource] };

      const seed: ResearchValidationPlanInput = {
        ...validationInput([resource]),
        strategies: [{
          strategyId: 'EMA_TREND',
          strategyVersion: '1.0.0',
          candidateSpace: {
            strategyId: 'EMA_TREND',
            strategyVersion: '1.0.0',
            dimensions: { timeframeMinutes: [1], fastPeriod: [1], slowPeriod: [2, 3], priceSource: ['CLOSE'] },
          },
        }],
        validationWindow: { startMs: BASE + 86_400_000, endExclusiveMs: BASE + 7 * 86_400_000 },
        walkForward: { policyId: 'P12_WALK_FORWARD_V1', trainDays: 2, testDays: 2, stepDays: 2, embargoDays: 0 },
        holdout: { holdoutStartMs: BASE + 5 * 86_400_000, holdoutEndExclusiveMs: BASE + 7 * 86_400_000, exposureDeclaration: 'UNSEEN_BY_OPERATOR' },
      };

      const probe = await planResearchValidationWithGitSourceVerifier(seed, deps, new ControlledGitVerifier());
      const hashes = [...new Set(probe.subjects.map((s) => s.parameterHash))];
      const input: ResearchValidationPlanInput = {
        ...seed,
        parameterNeighborhoods: hashes.map((targetParameterHash) => ({
          targetParameterHash,
          adjacentNeighborParameterHashes: hashes.filter((h) => h !== targetParameterHash),
        })),
      };

      const finalized = await planResearchValidationWithGitSourceVerifier(input, deps, new ControlledGitVerifier());
      const planResult = await executeResearchValidationWithGitSourceVerifier(finalized, deps, {}, new ControlledGitVerifier());

      const passedSubjects = planResult.subjectResults.filter((record) => record.verdict === 'PASSED');
      expect(passedSubjects.length).toBeGreaterThan(0);

      const candidates = passedSubjects.map((record) => ({
        pair: record.pair,
        strategyId: record.strategyId,
        strategyVersion: record.strategyVersion,
        parameterHash: record.parameterHash,
      }));

      // Call public Phase 15 ranking entry point
      const runSet = rankStrategyCandidates({ planResult, candidates });

      // Prove genuine authority is established
      expect(isAuthoritativeRankingRunSet(runSet)).toBe(true);
      expect(runSet.runs).toHaveLength(1);
      expect(runSet.runs[0]!.pair).toBe('B-SOL_USDT');
      expect(runSet.runs[0]!.candidateCount).toBeGreaterThan(0);
      expect(runSet.runs[0]!.results.length).toBeGreaterThan(0);
      expect(runSet.runs[0]!.results[0]!.pair).toBe('B-SOL_USDT');
      expect(runSet.runs[0]!.economicStatus).toBe('FUNDING_EXCLUDED');
      expect(runSet.runs[0]!.promotionEligible).toBe(false);
      expect(runSet.runs[0]!.maxLifecycle).toBe('PAPER');
    }, 120_000);

    it('structural compatibility: constructs pair-local ranking run for B-SOL_USDT and enforces pair isolation', () => {
      const planId = 'd'.repeat(64);

      function makeSolEvidence(pair: string, subjectSuffix: string, sharpe: string): RankingCandidateEvidence {
        const parameterHash = sha256CanonicalJson({ suffix: subjectSuffix });
        const validationSubjectId = sha256CanonicalJson({ pair, suffix: subjectSuffix });
        const identity = {
          pair,
          strategyId: 'EMA_TREND',
          strategyVersion: '1.0.0',
          parameterHash,
          validationSubjectId,
          validationPlanId: planId,
          validationSubjectResultSha256: sha256CanonicalJson({ subject: validationSubjectId }),
        };

        const metrics: Partial<Record<string, RankingComponentMetric>> = {};
        for (const cid of P15_COMPONENT_IDS) {
          metrics[cid] = cid === 'SHARPE'
            ? { status: 'VALUE', value: sharpe }
            : { status: 'VALUE', value: '1' };
        }

        return {
          identity,
          metrics: metrics as RankingComponentMetrics,
        };
      }

      const solEvidences = [
        makeSolEvidence('B-SOL_USDT', 'A', '2.5'),
        makeSolEvidence('B-SOL_USDT', 'B', '1.8'),
        makeSolEvidence('B-SOL_USDT', 'C', '3.1'),
      ];

      const run = buildPairRankingRun('B-SOL_USDT', planId, solEvidences);
      expect(run.pair).toBe('B-SOL_USDT');
      expect(run.results).toHaveLength(3);
      const topResult = run.results[0]!;
      expect(topResult.status).toBe('RANKED');
      if (topResult.status === 'RANKED') {
        expect(topResult.rank).toBe(1);
        expect(topResult.validationSubjectId).toBe(solEvidences[2]!.identity.validationSubjectId);
      }

      // Multi-pair composeRankingRunSet groups candidates strictly by pair into isolated runs
      const btcEvidence = makeSolEvidence('B-BTC_USDT', 'D', '2.0');
      const runSet = composeRankingRunSet([...solEvidences, btcEvidence], []);
      expect(runSet.runs).toHaveLength(2);
      expect(runSet.runs[0]!.pair).toBe('B-BTC_USDT');
      expect(runSet.runs[0]!.results).toHaveLength(1);
      expect(runSet.runs[1]!.pair).toBe('B-SOL_USDT');
      expect(runSet.runs[1]!.results).toHaveLength(3);
    });
  });

  // =========================================================================
  // 8. REGRESSION SAFETY PROOFS
  // =========================================================================
  describe('8. Regression Safety — BTC and ETH Configurations Unchanged', () => {
    it('maintains BTC and ETH in DEFAULT_COIN_PROFILES with unchanged properties', () => {
      const profiles = loadCoinProfiles();
      expect(profiles.length).toBe(3);

      const btc = profiles.find((p) => p.underlying === 'BTC');
      expect(btc).toBeDefined();
      expect(btc!.enabled).toBe(true);
      expect(btc!.dataEnabled).toBe(true);
      expect(btc!.researchEnabled).toBe(true);
      expect(btc!.paperEnabled).toBe(false);
      expect(btc!.shadowEnabled).toBe(false);
      expect(btc!.liveEnabled).toBe(false);
      expect(btc!.riskProfileId).toBe('DEFAULT_SAFE');
      expect(btc!.defaultLeverage?.toString()).toBe('1');
      expect(btc!.configuredAbsoluteMaxLeverage?.toString()).toBe('20');

      const eth = profiles.find((p) => p.underlying === 'ETH');
      expect(eth).toBeDefined();
      expect(eth!.enabled).toBe(true);
      expect(eth!.dataEnabled).toBe(true);
      expect(eth!.researchEnabled).toBe(true);
      expect(eth!.paperEnabled).toBe(false);
      expect(eth!.shadowEnabled).toBe(false);
      expect(eth!.liveEnabled).toBe(false);
      expect(eth!.riskProfileId).toBe('DEFAULT_SAFE');
      expect(eth!.defaultLeverage?.toString()).toBe('1');
      expect(eth!.configuredAbsoluteMaxLeverage?.toString()).toBe('20');

      const sol = profiles.find((p) => p.underlying === 'SOL');
      expect(sol).toBeDefined();
      expect(sol!.enabled).toBe(true);
      expect(sol!.dataEnabled).toBe(true);
      expect(sol!.researchEnabled).toBe(true);
      expect(sol!.paperEnabled).toBe(false);
      expect(sol!.shadowEnabled).toBe(false);
      expect(sol!.liveEnabled).toBe(false);
      expect(sol!.riskProfileId).toBe('DEFAULT_SAFE');
      expect(sol!.defaultLeverage?.toString()).toBe('1');
      expect(sol!.configuredAbsoluteMaxLeverage?.toString()).toBe('20');
    });

    it('rejects duplicate underlying profile registration', () => {
      const duplicateProfiles = [
        ...DEFAULT_COIN_PROFILES,
        { ...DEFAULT_COIN_PROFILES[0]!, underlying: 'SOL' },
      ];
      expect(() => validateCoinProfiles(duplicateProfiles)).toThrow(CoinConfigError);
    });

    it('verifies no pair-specific strategy classes exist in PHASE10_STRATEGY_DEFINITIONS', () => {
      for (const def of PHASE10_STRATEGY_DEFINITIONS) {
        expect(def.strategyId).not.toMatch(/SOL|BTC|ETH/i);
        expect(def.strategyVersion).toBe('1.0.0');
      }
    });
  });
});
