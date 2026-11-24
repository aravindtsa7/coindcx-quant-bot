import { describe, expect, it } from 'vitest';
import { evidenceDigest, redactEvidence } from '../../../src/dashboard/evidence';

describe('Local evidence export redaction', () => {
  it('redacts nested credential keys and embedded configured secrets while preserving public status', () => {
    const raw = { credentialsConfigured: true, nested: [{ clientSecret: 'a', coindcxApiKey: 'b', access_token: 'c', databaseURL: 'd' }],
      reason: 'Operator text contains known-secret', url: 'mysql://user:pass@local/database', authorization: 'Bearer abc',
      message: 'Bearer abc.123; COINDCX_API_SECRET=something', mode: 'SHADOW', trades: [{ netPnlInr: '-2' }] };
    const result = redactEvidence(raw, ['known-secret']);
    expect(result).toMatchObject({ credentialsConfigured: true, mode: 'SHADOW', trades: [{ netPnlInr: '-2' }],
      nested: [{ clientSecret: '[REDACTED]', coindcxApiKey: '[REDACTED]', access_token: '[REDACTED]', databaseURL: '[REDACTED]' }] });
    const text = JSON.stringify(result);
    for (const secret of ['known-secret', 'user:pass', 'abc.123', 'something']) expect(text).not.toContain(secret);
    expect(raw.nested[0]!.clientSecret).toBe('a');
    expect(evidenceDigest(result)).toMatch(/^[a-f0-9]{64}$/);
    expect(evidenceDigest(result)).toBe(evidenceDigest(redactEvidence(raw, ['known-secret'])));
  });
});
