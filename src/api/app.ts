import express, { Express, Request, Response, NextFunction } from 'express';
import { healthRouter } from './routes/health';
import { errorHandler } from './middleware/error-handler';
import { NotFoundError } from '../core/errors/app-error';

export function createApp(): Express {
  const app = express();

  // Basic security and parsing
  app.disable('x-powered-by');
  app.use(express.json());

  // Mount API routes
  app.use('/', healthRouter);

  // Catch 404
  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(new NotFoundError(`Endpoint not found: ${req.method} ${req.originalUrl}`));
  });

  // Centralized Error Handling
  app.use(errorHandler);

  return app;
}

