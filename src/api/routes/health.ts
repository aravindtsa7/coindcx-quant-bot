import { Router, Request, Response } from 'express';
import { checkDatabaseHealth } from '../../persistence/prisma';

export const healthRouter = Router();

const startTime = Date.now();

healthRouter.get('/health', async (req: Request, res: Response): Promise<void> => {
  const includeDb = req.query['db'] === 'true';

  if (!includeDb) {
    res.status(200).json({
      status: 'ok',
      service: 'coindcx-quant-bot',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    });
    return;
  }

  const dbHealth = await checkDatabaseHealth();
  const overallStatus = dbHealth.connected ? 'ok' : 'degraded';
  const statusCode = dbHealth.connected ? 200 : 503;

  res.status(statusCode).json({
    status: overallStatus,
    service: 'coindcx-quant-bot',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    database: {
      connected: dbHealth.connected,
      ...(dbHealth.latencyMs !== undefined && { latencyMs: dbHealth.latencyMs }),
    },
  });
});

