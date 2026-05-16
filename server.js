const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

loadEnvFile();

const app = express();
const PORT = Number(process.env.PORT || 8000);
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_NAME = 'mzh_session';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const sessions = new Map();
const oauthStates = new Map();
const OAUTH_PROVIDER = (process.env.OAUTH_PROVIDER || 'github').toLowerCase();

// User database file
const USERS_DB_FILE = path.join(__dirname, 'users.json');

function loadUsersDB() {
  try {
    if (fs.existsSync(USERS_DB_FILE)) {
      const data = fs.readFileSync(USERS_DB_FILE, 'utf8');
      return new Map(JSON.parse(data));
    }
  } catch (error) {
    console.error('Error loading users DB:', error);
  }
  return new Map();
}

function saveUsersDB(usersMap) {
  try {
    const data = JSON.stringify(Array.from(usersMap.entries()));
    fs.writeFileSync(USERS_DB_FILE, data, 'utf8');
  } catch (error) {
    console.error('Error saving users DB:', error);
  }
}

const users = loadUsersDB();

// Multi-provider OAuth configuration (only GitHub enabled by default)
const OAUTH_PROVIDERS = {
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    emailsUrl: 'https://api.github.com/user/emails',
    clientId: process.env.OAUTH_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET || process.env.GITHUB_OAUTH_CLIENT_SECRET,
    scope: 'read:user user:email',
    usesPKCE: false
  }
};

// Determine active OAuth providers
const OAUTH = {};
const AVAILABLE_PROVIDERS = [];

if (OAUTH_PROVIDERS.github.clientId) {
  OAUTH.github = OAUTH_PROVIDERS.github;
  OAUTH.github.redirectUri = process.env.OAUTH_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
  AVAILABLE_PROVIDERS.push('github');
}

// For backward compatibility, default to github if OAUTH_PROVIDER env var is set
if (OAUTH_PROVIDER && OAUTH_PROVIDER !== 'github' && !AVAILABLE_PROVIDERS.length) {
  const custom = { ...OAUTH_PROVIDERS[OAUTH_PROVIDER] };
  custom.redirectUri = process.env.OAUTH_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
  OAUTH[OAUTH_PROVIDER] = custom;
  AVAILABLE_PROVIDERS.push(OAUTH_PROVIDER);
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || (IS_PROD ? '' : readSecretFile('open_apikey.txt'));
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const DEV_AUTH_ENABLED = process.env.DEV_AUTH_ENABLED !== 'false' && !IS_PROD;
const LOCAL_MODELS_ENABLED = !IS_PROD || process.env.ENABLE_OLLAMA === 'true';
const PREFERRED_HOSTED_MODELS = [
  { id: 'openrouter:anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', provider: 'Anthropic via OpenRouter' },
  { id: 'openrouter:anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', provider: 'Anthropic via OpenRouter' },
  { id: 'openrouter:openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI via OpenRouter' },
  { id: 'openrouter:openrouter/auto', name: 'Auto Router', provider: 'OpenRouter' }
];

if (IS_PROD && !SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required when NODE_ENV=production.');
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  next();
});
app.use(express.static(__dirname, {
  extensions: ['html'],
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
}));

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    production: IS_PROD,
    oauthConfigured: AVAILABLE_PROVIDERS.length > 0,
    providers: AVAILABLE_PROVIDERS,
    hostedModelsConfigured: Boolean(OPENROUTER_API_KEY)
  });
});

app.get('/login', (req, res) => {
  const user = getUser(req);
  if (user) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/api/auth/config', (_req, res) => {
  res.json({
    oauthEnabled: AVAILABLE_PROVIDERS.length > 0,
    providers: AVAILABLE_PROVIDERS,
    devAuthEnabled: DEV_AUTH_ENABLED,
    emailEnabled: true
  });
});

app.get('/api/auth/me', (req, res) => {
  const user = getUser(req);
  res.json({ authenticated: Boolean(user), user });
});

app.post('/api/auth/dev-login', (req, res) => {
  if (!DEV_AUTH_ENABLED) return res.status(403).json({ error: 'Development login is disabled.' });
  const name = cleanString(req.body?.name, 'MZH User');
  createSession(res, { id: 'dev-user', name, email: 'local@mzh-onyx.dev', provider: 'development' });
  res.json({ ok: true });
});

// Password hashing helpers
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, derived] = stored.split(':');
  try {
    const test = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(derived, 'hex'));
  } catch {
    return false;
  }
}

// Register with email
app.post('/api/auth/register', (req, res) => {
  const name = cleanString(req.body?.name, '');
  const email = (req.body?.email || '').toLowerCase().trim();
  const password = req.body?.password || '';
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (users.has(email)) {
    return res.status(409).json({ error: 'User already exists.' });
  }
  
  const passwordHash = hashPassword(password);
  const user = {
    id: `user:${email}`,
    name: name || email.split('@')[0],
    email,
    passwordHash,
    provider: 'email',
    createdAt: new Date().toISOString()
  };
  
  users.set(email, user);
  saveUsersDB(users);
  
  createSession(res, { id: user.id, name: user.name, email: user.email, provider: 'email' });
  res.json({ ok: true });
});

// Login with email
app.post('/api/auth/login', (req, res) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  const password = req.body?.password || '';
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  
  const user = users.get(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  
  createSession(res, { id: user.id, name: user.name, email: user.email, provider: 'email' });
  res.json({ ok: true });
});

app.get('/auth/login/:provider', (req, res) => {
  const provider = req.params.provider?.toLowerCase();
  
  if (!provider || !OAUTH[provider]) {
    return res.status(400).send(`OAuth provider "${provider}" is not configured.`);
  }

  const config = OAUTH[provider];
  const state = randomToken();
  const verifier = config.usesPKCE ? base64Url(crypto.randomBytes(32)) : '';
  oauthStates.set(state, { provider, verifier, createdAt: Date.now() });

  const url = new URL(config.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  
  if (config.usesPKCE && verifier) {
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }

  if (provider === 'microsoft') {
    url.searchParams.set('response_mode', 'query');
  }

  res.redirect(url.toString());
});

app.get('/auth/login', (req, res) => {
  if (AVAILABLE_PROVIDERS.length === 0) {
    return res.status(503).send('OAuth is not configured on this server.');
  }
  // Default to first available provider
  res.redirect(`/auth/login/${AVAILABLE_PROVIDERS[0]}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const saved = oauthStates.get(state);
    oauthStates.delete(state);
    
    if (!code || !saved || Date.now() - saved.createdAt > 10 * 60 * 1000) {
      return res.status(400).send('OAuth state is invalid or expired.');
    }

    const provider = saved.provider;
    if (!provider || !OAUTH[provider]) {
      return res.status(400).send('OAuth provider is invalid or not configured.');
    }

    const config = OAUTH[provider];
    const tokenBody = new URLSearchParams({
      code: String(code),
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      grant_type: 'authorization_code'
    });

    if (config.usesPKCE && saved.verifier) {
      tokenBody.set('code_verifier', saved.verifier);
    }
    if (config.clientSecret) {
      tokenBody.set('client_secret', config.clientSecret);
    }

    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: tokenBody
    });
    
    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      throw new Error(`Token exchange failed with ${tokenRes.status}: ${errorText}`);
    }
    
    const token = await tokenRes.json();
    const profile = await loadUserProfile(provider, token);
    
    createSession(res, {
      id: profile.sub || profile.id || profile.oid || profile.email || randomToken(),
      name: profile.name || profile.preferred_username || profile.email || `${provider} User`,
      email: profile.email || '',
      provider: provider
    });
    
    res.redirect('/');
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send(`OAuth login failed: ${error.message}`);
  }
});

app.post('/auth/logout', (req, res) => {
  const sid = readCookie(req, COOKIE_NAME);
  if (sid) sessions.delete(sid);
  clearCookie(res);
  res.json({ ok: true });
});

app.get('/api/models', requireAuth, async (_req, res) => {
  const models = [];

  if (LOCAL_MODELS_ENABLED) {
    try {
      const ollamaRes = await fetch(`${OLLAMA_URL}/api/tags`);
      if (ollamaRes.ok) {
        const data = await ollamaRes.json();
        for (const model of data.models || []) {
          models.push({ id: `ollama:${model.name}`, name: model.name, provider: 'Ollama' });
        }
      }
    } catch {
      // Local Ollama is optional.
    }
  }

  if (OPENROUTER_API_KEY) {
    const byId = new Map(PREFERRED_HOSTED_MODELS.map(model => [model.id, model]));
    try {
      const routerRes = await fetch(`${OPENROUTER_URL}/models`, {
        headers: openRouterHeaders()
      });
      if (routerRes.ok) {
        const data = await routerRes.json();
        for (const model of data.data || []) {
          byId.set(`openrouter:${model.id}`, {
            id: `openrouter:${model.id}`,
            name: model.name || model.id,
            provider: providerLabel(model)
          });
        }
      }
    } catch {
      // Keep curated hosted models available even if the catalog endpoint is temporarily unavailable.
    }

    for (const preferred of PREFERRED_HOSTED_MODELS) {
      const model = byId.get(preferred.id) || preferred;
      models.push(model);
      byId.delete(preferred.id);
    }

    for (const model of byId.values()) {
      if (models.length >= 80) break;
      const isChatModel = !/(audio|image|embed|tts|transcribe|whisper|rerank)/i.test(model.id + model.name);
      if (isChatModel) models.push(model);
    }
  }

  if (!models.length && LOCAL_MODELS_ENABLED) {
    models.push(
      { id: 'ollama:qwen2.5:7b', name: 'Qwen 2.5 - 7B', provider: 'Ollama' },
      { id: 'ollama:deepseek-coder-v2:16b', name: 'DeepSeek Coder V2 - 16B', provider: 'Ollama' },
      { id: 'ollama:llama3.1:8b', name: 'Llama 3.1 - 8B', provider: 'Ollama' },
      { id: 'ollama:gemma2:9b', name: 'Gemma 2 - 9B', provider: 'Ollama' }
    );
  }

  if (!models.length) {
    return res.status(503).json({ error: 'No hosted model provider is configured. Set OPENROUTER_API_KEY.' });
  }

  res.json({ models });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const model = cleanString(req.body?.model, '');
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!model || !messages.length) return res.status(400).json({ error: 'Model and messages are required.' });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });

  try {
    if (model.startsWith('openrouter:')) {
      await streamOpenRouter(res, model.replace('openrouter:', ''), messages);
    } else if (!LOCAL_MODELS_ENABLED) {
      throw new Error('Local Ollama models are disabled in production. Choose a hosted model.');
    } else {
      await streamOllama(res, model.replace('ollama:', ''), messages);
    }
    sendEvent(res, { done: true });
  } catch (error) {
    sendEvent(res, { error: error.message || 'Model request failed.' });
  } finally {
    res.end();
  }
});

app.use((req, res) => {
  const user = getUser(req);
  if (!user) {
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`MZH-ONYX running on http://localhost:${PORT}`);
});

async function streamOllama(res, model, messages) {
  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true })
  });
  if (!upstream.ok || !upstream.body) throw new Error(`Ollama request failed with ${upstream.status}`);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines.filter(Boolean)) {
      const json = JSON.parse(line);
      const content = json.message?.content || '';
      if (content) sendEvent(res, { content });
    }
  }
}

async function streamOpenRouter(res, model, messages) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured.');
  const upstream = await fetch(`${OPENROUTER_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      ...openRouterHeaders(),
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model, messages, stream: true })
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`OpenRouter request failed with ${upstream.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        const json = JSON.parse(payload);
        const content = json.choices?.[0]?.delta?.content || '';
        if (content) sendEvent(res, { content });
      }
    }
  }
}

async function loadUserProfile(provider, token) {
  const config = OAUTH[provider];
  
  if (!config || !config.userInfoUrl || !token.access_token) {
    return {};
  }

  try {
    const profileRes = await fetch(config.userInfoUrl, {
      headers: {
        authorization: `Bearer ${token.access_token}`,
        accept: 'application/json',
        'user-agent': 'MZH-ONYX'
      }
    });

    if (!profileRes.ok) {
      throw new Error(`Failed to fetch user profile: ${profileRes.status}`);
    }

    const profile = await profileRes.json();
    return normalizeProfile(provider, profile);
  } catch (error) {
    console.error(`Error loading ${provider} profile:`, error);
    // Try to use ID token if available
    if (token.id_token) {
      const [, payload] = token.id_token.split('.');
      if (payload) {
        try {
          return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        } catch (e) {
          console.error('Error parsing ID token:', e);
        }
      }
    }
    return {};
  }
}

function normalizeProfile(provider, profile) {
  switch (provider.toLowerCase()) {
    case 'google':
      return {
        id: profile.id,
        sub: profile.id,
        name: profile.name,
        email: profile.email,
        picture: profile.picture
      };
    
    case 'microsoft':
      return {
        id: profile.id,
        oid: profile.id,
        name: profile.displayName,
        email: profile.mail || profile.userPrincipalName,
        picture: null
      };
    
    case 'github':
      return {
        id: String(profile.id || profile.node_id || profile.login || ''),
        name: profile.name || profile.login || profile.email || 'GitHub User',
        email: profile.email || '',
        preferred_username: profile.login || '',
        avatar_url: profile.avatar_url || ''
      };
    
    default:
      return profile;
  }
}

function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  req.user = user;
  next();
}

function getUser(req) {
  const sid = verifySessionCookie(readCookie(req, COOKIE_NAME));
  const session = sid && sessions.get(sid);
  if (!session || session.expiresAt < Date.now()) {
    if (sid) sessions.delete(sid);
    return null;
  }
  return session.user;
}

function createSession(res, user) {
  const sid = randomToken();
  sessions.set(sid, { user, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, signSessionId(sid), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: IS_PROD,
    path: '/',
    maxAge: 7 * 24 * 60 * 60
  }));
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: IS_PROD,
    path: '/',
    maxAge: 0
  }));
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (Number.isFinite(options.maxAge)) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}

function readCookie(req, name) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.split('=').slice(1).join('=');
}

function signSessionId(sid) {
  if (!SESSION_SECRET) return sid;
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(sid).digest('base64url');
  return `${sid}.${signature}`;
}

function verifySessionCookie(value) {
  if (!value) return '';
  const decoded = decodeURIComponent(value);
  if (!SESSION_SECRET) return decoded;
  const lastDot = decoded.lastIndexOf('.');
  if (lastDot < 1) return '';
  const sid = decoded.slice(0, lastDot);
  const actual = decoded.slice(lastDot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(sid).digest('base64url');
  if (actual.length !== expected.length) return '';
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)) ? sid : '';
}

function openRouterHeaders() {
  return {
    authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'HTTP-Referer': process.env.APP_URL || `http://localhost:${PORT}`,
    'X-Title': 'MZH-ONYX'
  };
}

function providerLabel(model) {
  const id = String(model.id || '');
  if (id.startsWith('anthropic/')) return 'Anthropic via OpenRouter';
  if (id.startsWith('openai/')) return 'OpenAI via OpenRouter';
  if (id.startsWith('google/')) return 'Google via OpenRouter';
  if (id.startsWith('meta-llama/')) return 'Meta via OpenRouter';
  if (id.startsWith('deepseek/')) return 'DeepSeek via OpenRouter';
  return 'OpenRouter';
}

function cleanString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function randomToken() {
  return base64Url(crypto.randomBytes(32));
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function readSecretFile(fileName) {
  try {
    const value = fs.readFileSync(path.join(__dirname, fileName), 'utf8').trim();
    return value || '';
  } catch {
    return '';
  }
}

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}
