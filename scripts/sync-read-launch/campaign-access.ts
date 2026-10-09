/** Campaign IPC capability authentication only. These keys are never provider credentials. No I/O on import. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CampaignCapability, ClientAccessPolicy, CoordinatorAccessPolicy, HandshakeMessage, WelcomeMessage } from '../../src/integration/coindcx/rate-limit/runtime/protocol';

export interface CampaignKeys { readonly read: string; readonly operatorStop: string }
export function validateCampaignKeys(keys: CampaignKeys): void {
  if (!/^[0-9a-f]{64}$/.test(keys.read) || !/^[0-9a-f]{64}$/.test(keys.operatorStop) || keys.read === keys.operatorStop) throw new Error('DISTINCT_CAMPAIGN_CAPABILITY_KEYS_REQUIRED');
}
const mac = (key: string, fields: readonly unknown[]) => createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(fields)).digest('hex');
const equal = (actual: string | undefined, expected: string) => typeof actual === 'string' && /^[0-9a-f]{64}$/.test(actual)
  && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
const helloFields = (id: string, nonce: string, role: CampaignCapability, m: HandshakeMessage) =>
  ['campaign-ipc-client/1', id, nonce, role, m.t, m.v, m.probeScopes, m.t === 'RESUME' ? m.clientInstanceId : null, m.t === 'RESUME' ? m.resumeSecret : null];
const welcomeFields = (id: string, nonce: string, role: CampaignCapability, m: WelcomeMessage) =>
  ['campaign-ipc-coordinator/1', id, nonce, role, m.epoch, m.sessionId, m.clientInstanceId, m.resumeSecret ?? null, m.state];

export function coordinatorCampaignAccess(installationId: string, keys: CampaignKeys): CoordinatorAccessPolicy {
  validateCampaignKeys(keys);
  const read = keys.read, stop = keys.operatorStop; // Capture values; caller mutation cannot replace capabilities.
  const key = (role: CampaignCapability) => role === 'READ' ? read : stop;
  return Object.freeze({ installationId,
    verify(nonce: string, m: HandshakeMessage) {
      return m.access?.installationId === installationId && equal(m.access.proof, mac(key(m.access.capability), helloFields(installationId, nonce, m.access.capability, m)));
    },
    welcomeProof(nonce: string, role: CampaignCapability, m: WelcomeMessage) { return mac(key(role), welcomeFields(installationId, nonce, role, m)); },
  });
}
export function clientCampaignAccess(installationId: string, capability: CampaignCapability, key: string): ClientAccessPolicy {
  if (!/^[a-z][0-9a-f]{32}$/.test(installationId) || !/^[0-9a-f]{64}$/.test(key) || !['READ', 'OPERATOR_STOP'].includes(capability)) throw new Error('CAMPAIGN_CLIENT_CAPABILITY_INVALID');
  return Object.freeze({ installationId, capability,
    helloProof(nonce: string, m: HandshakeMessage) { return mac(key, helloFields(installationId, nonce, capability, m)); },
    verifyWelcome(nonce: string, m: WelcomeMessage) { return m.access?.installationId === installationId && m.access.capability === capability
      && equal(m.access.proof, mac(key, welcomeFields(installationId, nonce, capability, m))); },
  });
}
