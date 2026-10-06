import './env.js';
import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';

import { initDatabase } from './db/database.js';
import { EventEngine } from './services/eventEngine.js';
import { Realtime } from './services/realtime.js';
import { CredentialsService } from './services/credentialsService.js';
import { ProctorService } from './services/proctorService.js';
import { JudgeService } from './services/judgeService.js';

import authRoutes from './routes/authRoutes.js';
import roundRoutes from './routes/roundRoutes.js';
import { codeRouter, submissionRouter } from './routes/codeRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import telemetryRoutes from './routes/telemetryRoutes.js';
import { db } from './db/database.js';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: true }
});

const PORT = Number(process.env.PORT) || 4000;

initDatabase();
EventEngine.start();

Realtime.init(io, {
  getState: () => EventEngine.getEventState(),
  onHeartbeat: (sessionId, data) => {
    CredentialsService.updateHeartbeat(sessionId, { fullscreen: Boolean(data?.fullscreen), focused: Boolean(data?.focused) });
  },
  onMultiTab: (sessionId) => {
    const s = db.prepare('SELECT team_id, role FROM sessions WHERE session_id = ?').get(sessionId) as any;
    if (s) ProctorService.record({ teamId: s.team_id, role: s.role, sessionId, type: 'MULTIPLE_TABS' });
  }
});

JudgeService.resumePending();

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/rounds', roundRoutes);
app.use('/api/code', codeRouter);
app.use('/api/submissions', submissionRouter);
app.use('/api/admin', adminRoutes);
app.use('/api/telemetry', telemetryRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), state: EventEngine.getEventState().state });
});

// Production: serve the built client from the same origin (no CORS, one port for the lab).
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist, { index: false }));
  app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// Body-parser errors etc. must come back as JSON, never an HTML stack trace.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: status === 413 ? 'Request body too large.' : status >= 500 ? 'Internal server error.' : err.message });
});

server.listen(PORT, () => {
  console.log(`Algorithm Auction server running on http://localhost:${PORT}`);
});

const shutdown = () => { io.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
