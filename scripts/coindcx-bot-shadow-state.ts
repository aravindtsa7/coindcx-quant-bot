import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Decimal } from '../src/core/decimal/decimal';
import { sha256CanonicalJson } from '../src/risk/canonical';
import type { BotShadowCapital } from '../src/integration/coindcx/live/practical-bot-shadow-risk';

const amount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/).refine(value => new Decimal(value).isFinite() && new Decimal(value).gte(0));
const time = z.number().int().nonnegative().refine(Number.isSafeInteger);
const identity = z.string().min(1).max(128);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const capitalSchema = z.object({ accountFingerprint: sha, initialEquityInr: amount, equityInr: amount, peakEquityInr: amount, lockedMarginInr: amount,
  createdAtMs: time, dailyPnl: z.object({ realizedTradingPnlInr: z.literal('0'), fundingPnlInr: z.literal('0'), feesInr: z.literal('0'),
    otherAccountAdjustmentsInr: z.literal('0'), netDailyPnlInr: z.literal('0') }).strict(),
  consecutiveLossCount: z.literal(0), cooldownActiveUntilMs: z.null(), reservations: z.array(z.object({ reservationId: identity, pair: identity,
    strategyInstanceId: identity, strategyId: identity, strategyVersion: identity, parameterHash: sha, direction: z.enum(['LONG', 'SHORT']),
    notionalInr: amount, marginInr: amount, status: z.enum(['ADMITTED', 'RELEASED']) }).strict()) }).strict();
const envelopeSchema = z.object({ format: z.literal('BOT_OPERATOR_SHADOW_CAPITAL_V1'), capital: capitalSchema, contentSha256: sha }).strict();

/** Persistent, account-scoped shadow capital. No database/venue absence is inferred from this separate book. */
export function readBotShadowCapital(rootDirectory: string, accountFingerprint: string, equityInr: string, nowMs: number): BotShadowCapital {
  if (!sha.safeParse(accountFingerprint).success || !amount.safeParse(equityInr).success || !new Decimal(equityInr).gt(0)
    || !time.safeParse(nowMs).success) throw new Error('SHADOW_CAPITAL_INVALID');
  const directory = path.resolve(rootDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `bot-shadow-capital-${accountFingerprint}.json`);
  if (!fs.existsSync(file)) {
    const capital: BotShadowCapital = { accountFingerprint, initialEquityInr: equityInr, equityInr, peakEquityInr: equityInr, lockedMarginInr: '0',
      createdAtMs: nowMs, dailyPnl: { realizedTradingPnlInr: '0', fundingPnlInr: '0', feesInr: '0', otherAccountAdjustmentsInr: '0', netDailyPnlInr: '0' },
      consecutiveLossCount: 0, cooldownActiveUntilMs: null, reservations: [] };
    const content = { format: 'BOT_OPERATOR_SHADOW_CAPITAL_V1' as const, capital };
    let descriptor: number | undefined;
    try { descriptor = fs.openSync(file, 'wx'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('SHADOW_CAPITAL_WRITE_FAILED'); }
    if (descriptor !== undefined) {
      try { fs.writeFileSync(descriptor, JSON.stringify({ ...content, contentSha256: sha256CanonicalJson(content) }, null, 2)); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) throw new Error('SHADOW_CAPITAL_INVALID');
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('SHADOW_CAPITAL_INVALID'); }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) throw new Error('SHADOW_CAPITAL_INVALID');
  const { capital, format, contentSha256 } = parsed.data;
  if (sha256CanonicalJson({ format, capital }) !== contentSha256 || capital.accountFingerprint !== accountFingerprint
    || capital.createdAtMs > nowMs || new Decimal(capital.peakEquityInr).lt(capital.equityInr)
    || !new Decimal(capital.equityInr).gt(0) || capital.lockedMarginInr !== '0'
    || new Set(capital.reservations.map(row => row.reservationId)).size !== capital.reservations.length) throw new Error('SHADOW_CAPITAL_INVALID');
  if (capital.initialEquityInr !== equityInr) throw new Error('SHADOW_EQUITY_BASELINE_MISMATCH');
  return capital;
}
