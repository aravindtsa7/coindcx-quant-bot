/** Explicit operator-local preparation only. Imports and tests never read operational credentials. */
import fs from 'node:fs';
import readline from 'node:readline';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const AUTHORIZED_CREDENTIAL_SOURCE = 'C:\\TSA\\coindcx-quant-bot-clean\\.env';
const names = ['COINDCX_API_KEY', 'COINDCX_API_SECRET'] as const;
/** Select only literal single-line assignments. No expansion, evaluation or other setting lookup. */
export function selectCredentialLine(line: string, selected: Map<string, string>): void {
  if (/^\s*(?:export\s+)?COINDCX_API_(KEY|SECRET)\s*=/.test(line) && /[\r\n\0]/.test(line)) throw new Error('CAMPAIGN_SOURCE_LITERAL_REQUIRED');
  const match = /^\s*(?:export\s+)?(COINDCX_API_KEY|COINDCX_API_SECRET)\s*=(.*)$/.exec(line.replace(/^\uFEFF/, ''));
  if (!match) return;
  const name = match[1]!, raw = match[2]!.trim();
  if (selected.has(name)) throw new Error('CAMPAIGN_SOURCE_DUPLICATE');
  let value: string;
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(raw);
    if (!quoted) throw new Error('CAMPAIGN_SOURCE_LITERAL_REQUIRED');
    value = quoted[2]!;
  } else value = raw.replace(/\s+#.*$/, '').trim();
  if (!value || /[\s\0$`\\"']/.test(value)) throw new Error('CAMPAIGN_SOURCE_LITERAL_REQUIRED');
  selected.set(name, value);
}
export function campaignCredentialEnvironment(selected: ReadonlyMap<string, string>) {
  if (!names.every(name => selected.has(name))) throw new Error('CAMPAIGN_SOURCE_TWO_VALUES_REQUIRED');
  return Object.freeze({ COINDCX_CAMPAIGN_API_KEY: selected.get(names[0])!, COINDCX_CAMPAIGN_API_SECRET: selected.get(names[1])! });
}
/** Streams past unrelated lines without parsing or retaining their settings. No file/environment mutation. */
export async function loadAuthorizedCredentialSource() {
  const selected = new Map<string, string>();
  const stream = fs.createReadStream(AUTHORIZED_CREDENTIAL_SOURCE, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const digest = createHash('sha256'); stream.on('data', chunk => digest.update(chunk));
  try {
    for await (const line of lines) selectCredentialLine(line, selected);
    return { environment: campaignCredentialEnvironment(selected), sourceFileSha256: digest.digest('hex') };
  } catch { throw new Error('CAMPAIGN_AUTHORIZED_SOURCE_UNAVAILABLE_OR_INVALID'); }
  finally { lines.close(); stream.destroy(); selected.clear(); }
}
/** CurrentUser DPAPI for IPC keys and explicit protected credentials; no pipe/process identity claim. */
export function protectIpcKeys(input: string, decrypt = false): string {
  if (process.platform !== 'win32') throw new Error('WINDOWS_DPAPI_REQUIRED');
  const method = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${method}($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r))`;
  try { return execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input, encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('CAMPAIGN_IPC_DPAPI_FAILED'); }
}
export function createIpcKeyFile(file: string): void {
  const read = randomBytes(32), stop = randomBytes(32);
  try {
    if (read.equals(stop)) throw new Error('CAMPAIGN_IPC_KEYS_INVALID');
    const payload = Buffer.concat([read, stop]);
    try {
      const encrypted = Buffer.from(protectIpcKeys(payload.toString('base64')), 'base64');
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } finally { payload.fill(0); }
  } finally { read.fill(0); stop.fill(0); }
}
export function loadIpcKeyFile(file: string) {
  const plain = Buffer.from(protectIpcKeys(fs.readFileSync(file).toString('base64'), true), 'base64');
  try {
    if (plain.length !== 64 || plain.subarray(0, 32).equals(plain.subarray(32))) throw new Error('CAMPAIGN_IPC_KEYS_INVALID');
    return { COINDCX_CAMPAIGN_IPC_READ_KEY: plain.subarray(0, 32).toString('hex'), COINDCX_CAMPAIGN_IPC_STOP_KEY: plain.subarray(32).toString('hex') };
  } finally { plain.fill(0); }
}
