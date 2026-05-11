import express, { type ErrorRequestHandler } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './lib/auth';
import { asyncHandler } from './lib/asyncHandler';
import healthRouter from './routes/health';
import webhooksRouter from './routes/webhooks';
import syncRouter from './routes/sync';

const app = express();

// Better Auth handler must be mounted BEFORE express.json() — its
// toNodeHandler reads the raw request body itself.
const authHandler = toNodeHandler(auth);
app.all(
  '/api/auth/*',
  asyncHandler(async (req, res) => {
    await authHandler(req, res);
  }),
);

app.use(express.json());
app.use('/health', healthRouter);
app.use('/webhooks', webhooksRouter);
app.use('/sync', syncRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
};
app.use(errorHandler);

export default app;
