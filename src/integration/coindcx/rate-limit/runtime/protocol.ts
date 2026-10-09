/**
 * M2 W2: IPC message schemas (strict). Every inbound frame is validated before use; anything else is a protocol error.
 * Identity is never taken from a message field alone: the coordinator binds a session to a client instance at
 * HELLO/RESUME (resume secret), and every report must name the grant's own epoch and session.
 */
import { z } from 'zod';
import { BUDGET_SCOPES, PRIORITY_CLASSES } from '../config';

export const PROTOCOL_VERSION = 1;
const hexId = z.string().regex(/^[a-z][0-9a-f]{32}$/);
const ref = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const ackId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const scope = z.enum(BUDGET_SCOPES);
const count = z.number().int().positive().max(86_400_000);
const grantBinding = { grantId: hexId, grantEpoch: hexId, grantSessionId: hexId };
export const campaignCapability = z.enum(['READ', 'OPERATOR_STOP']);
const access = z.object({ installationId: hexId, capability: campaignCapability, proof: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('HELLO'), v: z.literal(PROTOCOL_VERSION), probeScopes: z.array(scope).max(2), access: access.optional() }).strict(),
  z.object({ t: z.literal('RESUME'), v: z.literal(PROTOCOL_VERSION), clientInstanceId: hexId, resumeSecret: z.string().regex(/^[0-9a-f]{64}$/), probeScopes: z.array(scope).max(2), access: access.optional() }).strict(),
  z.object({
    t: z.literal('REQUEST'), ref, cls: z.enum(PRIORITY_CLASSES), operation: z.enum(['READ', 'PROBE', 'CREATE', 'CANCEL']), scope,
    deadlineInMs: count, lifetimeMs: count, probeGen: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({ t: z.literal('REPORT'), ackId, ...grantBinding, kind: z.enum(['RECEIVED', 'STARTED', 'NOT_STARTED', 'COMPLETED']) }).strict(),
  z.object({ t: z.literal('INVENTORY'), ackId, closedEpoch: hexId, closedSessionId: hexId, used: z.array(hexId).max(10_000), voided: z.array(hexId).max(10_000) }).strict(),
  z.object({ t: z.literal('THROTTLED'), ackId, ...grantBinding, retryAfter: z.string().max(128).optional(), serverDate: z.string().max(128).optional() }).strict(),
  z.object({ t: z.literal('PROBE_RESULT'), ackId, ...grantBinding, outcome: z.enum(['SUCCESS', 'FAILED']) }).strict(),
  z.object({ t: z.literal('CONTROL'), ackId, action: z.enum(['STOP', 'RESET_STOP']) }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface StateView { readonly admission: 'OPEN' | 'STOPPED'; readonly blockedScopes: ('API_AUTH' | 'PUBLIC')[]; readonly unknown: boolean }
const stateView = z.object({ admission: z.enum(['OPEN', 'STOPPED']), blockedScopes: z.array(scope).max(2), unknown: z.boolean() }).strict();
const grant = z.object({
  epoch: hexId, sessionId: hexId, grantId: hexId, requestId: z.string().max(128), ttlMs: count, operation: z.enum(['READ', 'PROBE', 'CREATE', 'CANCEL']),
  scope, viaHook: z.literal(false), probeGen: z.number().int().nonnegative().nullable(),
}).strict();
export const coordinatorMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('CHALLENGE'), installationId: hexId, nonce: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ t: z.literal('WELCOME'), epoch: hexId, sessionId: hexId, clientInstanceId: hexId, resumeSecret: z.string().regex(/^[0-9a-f]{64}$/).optional(), state: stateView, access: access.optional() }).strict(),
  z.object({ t: z.literal('GRANT'), ref, grant }).strict(),
  z.object({ t: z.literal('REFUSED'), ref, code: z.string().max(64) }).strict(),
  z.object({ t: z.literal('REVOKE'), grantIds: z.array(hexId).max(10_000) }).strict(),
  z.object({ t: z.literal('STATE'), state: stateView }).strict(),
  z.object({ t: z.literal('PROBE_DUE'), scope, probeGen: z.number().int().nonnegative() }).strict(),
  z.object({ t: z.literal('ACK'), ackId, result: z.enum(['APPLIED', 'IGNORED', 'REJECTED']), reason: z.string().max(64).optional() }).strict(),
  z.object({ t: z.literal('ERROR'), code: z.string().max(64) }).strict(),
]);
export type CoordinatorMessage = z.infer<typeof coordinatorMessageSchema>;
export type CampaignCapability = z.infer<typeof campaignCapability>;
export type HandshakeMessage = Extract<ClientMessage, { t: 'HELLO' | 'RESUME' }>;
export type WelcomeMessage = Extract<CoordinatorMessage, { t: 'WELCOME' }>;
/** Authentication is injected by the isolated campaign, never by ordinary connected read clients. */
export interface CoordinatorAccessPolicy {
  readonly installationId: string;
  verify(challenge: string, message: HandshakeMessage): boolean;
  welcomeProof(challenge: string, capability: CampaignCapability, welcome: WelcomeMessage): string;
}
export interface ClientAccessPolicy {
  readonly installationId: string;
  readonly capability: CampaignCapability;
  helloProof(challenge: string, message: HandshakeMessage): string;
  verifyWelcome(challenge: string, welcome: WelcomeMessage): boolean;
}
