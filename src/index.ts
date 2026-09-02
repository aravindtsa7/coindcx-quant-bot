import { startServer } from './app/bootstrap/server';
import { logger } from './monitoring/logger';

startServer().catch((err: unknown) => {
  logger.fatal(
    { err: err instanceof Error ? err.message : err, stack: err instanceof Error ? err.stack : undefined },
    'Fatal unhandled error during application bootstrap'
  );
  process.exit(1);
});

