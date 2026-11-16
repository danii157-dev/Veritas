import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const port = Number(process.env.PORT || 4100);

const users = [
  { username: 'admin', password: 'password123', role: 'admin' },
  { username: 'demo', password: 'demo123', role: 'user' },
];

const sessions = new Map();

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  function issueToken(username) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username });
    return token;
  }

  function getTokenFromRequest(request) {
    const authHeader = request.headers.authorization || '';
    return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  }

  app.post('/api/login', (request, response) => {
    const { username, password } = request.body || {};

    const user = users.find(
      (item) => item.username === username && item.password === password,
    );

    if (!user) {
      return response.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = issueToken(user.username);

    return response.json({
      message: 'Login successful',
      token,
      user: {
        username: user.username,
        role: user.role,
      },
    });
  });

  app.get('/api/me', (request, response) => {
    const token = getTokenFromRequest(request);

    if (!token || !sessions.has(token)) {
      return response.status(401).json({ error: 'Not authenticated.' });
    }

    const session = sessions.get(token);
    const user = users.find((item) => item.username === session.username);

    if (!user) {
      return response.status(401).json({ error: 'User not found.' });
    }

    return response.json({
      username: user.username,
      role: user.role,
    });
  });

  app.post('/api/logout', (request, response) => {
    const token = getTokenFromRequest(request);

    if (token) {
      sessions.delete(token);
    }

    return response.json({ message: 'Logged out.' });
  });

  return app;
}

export function createServer() {
  const app = createApp();
  return app.listen(port, () => {
    console.log(`Simple auth API running on http://localhost:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer();
}
