import { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../monitoring/logger';

const log = createChildLogger('persistence:prisma');

declare global {
  var __prismaClientInstance: PrismaClient | undefined;
}

export function getPrismaClient(): PrismaClient {
  if (process.env['NODE_ENV'] === 'test') {
    if (!global.__prismaClientInstance) {
      global.__prismaClientInstance = new PrismaClient({
        log: ['error'],
      });
    }
    return global.__prismaClientInstance;
  }

  if (!global.__prismaClientInstance) {
    global.__prismaClientInstance = new PrismaClient({
      log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });

    type PrismaEventClient = PrismaClient & {
      $on(event: 'error' | 'warn', cb: (e: { message: string }) => void): void;
    };
    const eventClient = global.__prismaClientInstance as unknown as PrismaEventClient;

    eventClient.$on('error', (e) => {
      log.error({ err: e.message }, 'Prisma database error event');
    });

    eventClient.$on('warn', (e) => {
      log.warn({ warning: e.message }, 'Prisma database warning event');
    });
  }

  return global.__prismaClientInstance;
}

export const prisma = getPrismaClient();

/**
 * Gracefully disconnects Prisma client.
 */
export async function disconnectPrisma(): Promise<void> {
  if (global.__prismaClientInstance) {
    log.info('Disconnecting Prisma database client');
    await global.__prismaClientInstance.$disconnect();
    global.__prismaClientInstance = undefined;
  }
}

/**
 * Checks database connectivity and returns latency.
 */
export async function checkDatabaseHealth(): Promise<{
  connected: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const client = getPrismaClient();
    await client.$queryRawUnsafe('SELECT 1');
    return {
      connected: true,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Unknown database error';
    const sanitizedMsg = rawMsg.replace(/mysql:\/\/[^@\s]+@/gi, 'mysql://[REDACTED]@');
    log.error({ err: sanitizedMsg }, 'Database healthcheck probe failed');
    return {
      connected: false,
      error: sanitizedMsg,
    };
  }
}
