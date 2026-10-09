/** Explicit named environment lookup only. Never searches dotenv, operational configuration or live aliases. */
export const CAMPAIGN_ENVIRONMENT_NAMES = Object.freeze([
  'COINDCX_CAMPAIGN_API_KEY', 'COINDCX_CAMPAIGN_API_SECRET', 'COINDCX_CAMPAIGN_IPC_READ_KEY', 'COINDCX_CAMPAIGN_IPC_STOP_KEY',
] as const);
export function loadCampaignSecrets(environment: Readonly<Record<string, string | undefined>>) {
  const values = CAMPAIGN_ENVIRONMENT_NAMES.map(name => environment[name]);
  if (values.some(value => typeof value !== 'string' || value.trim().length === 0 || /[\r\n\0]/.test(value))) throw new Error('CAMPAIGN_ENVIRONMENT_INPUTS_REQUIRED');
  const [apiKey, apiSecret, read, operatorStop] = values as [string, string, string, string];
  if (!/^[0-9a-f]{64}$/.test(read) || !/^[0-9a-f]{64}$/.test(operatorStop) || read === operatorStop) throw new Error('CAMPAIGN_IPC_KEYS_INVALID');
  return Object.freeze({ credentials: Object.freeze({ apiKey, apiSecret }), keys: Object.freeze({ read, operatorStop }) });
}
/** Sanitize detached JSON outputs, including unexpected credential echoes in provider record identifiers. */
export function redactCampaignOutput<T>(value: T, secrets: readonly string[]): T {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string'
    ? secrets.reduce((result, secret) => secret.length ? result.replaceAll(secret, '[REDACTED]') : result, item) : item)) as T;
}
