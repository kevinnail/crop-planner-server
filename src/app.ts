import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './lib/auth';
import healthRouter from './routes/health';
import webhooksRouter from './routes/webhooks';

const app = express();

// Better Auth handler must be mounted BEFORE express.json() — its
// toNodeHandler reads the raw request body itself.
const authHandler = toNodeHandler(auth);
app.all('/api/auth/*', (req, res) => {
  void authHandler(req, res);
});

app.use(express.json());
app.use('/health', healthRouter);
app.use('/webhooks', webhooksRouter);

export default app;
