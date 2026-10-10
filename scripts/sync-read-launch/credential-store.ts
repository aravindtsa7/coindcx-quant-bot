/** Explicit source selection. No import-time reads, fallback, or credential persistence. */
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { AUTHORIZED_CREDENTIAL_SOURCE, loadAuthorizedCredentialSource, protectIpcKeys } from './operator-local-secrets';

export type CredentialSource = 'authorized-env-file' | 'protected-dpapi';
const runtimeRoot = path.resolve(__dirname, '../..');
export function credentialStorePath(root = runtimeRoot): string {
  return path.join(root, 'operator-credentials', 'coindcx-api.dpapi');
}
export function parseCredentialSource(value: string | undefined): CredentialSource {
  if (value !== 'authorized-env-file' && value !== 'protected-dpapi') throw new Error('EXPLICIT_CREDENTIAL_SOURCE_REQUIRED');
  return value;
}
export function credentialPayload(key: string, secret: string): Buffer {
  if (![key, secret].every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\0]/.test(value))) {
    throw new Error('CREDENTIAL_STORE_TWO_LITERAL_VALUES_REQUIRED');
  }
  return Buffer.from(JSON.stringify({ apiKey: key, apiSecret: secret }), 'utf8');
}
export function credentialEnvironment(plain: Buffer) {
  try {
    const value = JSON.parse(plain.toString('utf8'));
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'apiKey,apiSecret') throw new Error();
    const checked = credentialPayload(value.apiKey, value.apiSecret);
    checked.fill(0);
    return Object.freeze({ COINDCX_CAMPAIGN_API_KEY: value.apiKey as string, COINDCX_CAMPAIGN_API_SECRET: value.apiSecret as string });
  } catch { throw new Error('CREDENTIAL_STORE_PAYLOAD_INVALID'); }
}
/** Reuses the unchanged reviewed validator, including complete runtime and ancestor custody. */
export function assertCredentialCustody(file: string): void {
  const inventory = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'runtime-inventory.json'), 'utf8'));
  const validator = fs.readFileSync(path.join(__dirname, 'identity-custody.ps1'), 'utf8');
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = `. { ${validator} } -RuntimeRoot ${quote(runtimeRoot)}; Assert-DiagnosticCustody ${quote(file)}`;
  try {
    childProcess.execFileSync(inventory.powershell.path, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 120000 });
  } catch { throw new Error('CREDENTIAL_SOURCE_CUSTODY_FAILED'); }
}
/** Invoked only by the authorized lazy callback. No alternative source is tried on any error. */
export async function loadSelectedCredentialSource(source: CredentialSource, expectedCiphertextSha256?: string) {
  parseCredentialSource(source);
  const file = source === 'protected-dpapi' ? credentialStorePath() : AUTHORIZED_CREDENTIAL_SOURCE;
  assertCredentialCustody(file);
  if (source === 'authorized-env-file') return loadAuthorizedCredentialSource();
  try {
    const size = fs.statSync(file).size;
    if (size < 32 || size > 65536) throw new Error();
    const encrypted = fs.readFileSync(file);
    const sourceFileSha256 = createHash('sha256').update(encrypted).digest('hex');
    if (expectedCiphertextSha256 !== undefined && sourceFileSha256 !== expectedCiphertextSha256) throw new Error();
    const plain = Buffer.from(protectIpcKeys(encrypted.toString('base64'), true), 'base64');
    try { return { environment: credentialEnvironment(plain), sourceFileSha256 }; }
    finally { plain.fill(0); }
  } catch { throw new Error('CREDENTIAL_STORE_UNAVAILABLE_OR_DECRYPTION_FAILED'); }
}
