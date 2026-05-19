const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

loadEnvFile();

const app = express();
const PORT = Number(process.env.PORT || 8000);
const IS_PROD = process.env.NODE_ENV === 'production';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || (IS_PROD ? '' : readSecretFile('open_apikey.txt'));
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = { id: 'openrouter:openrouter/auto', name: 'OpenRouter Auto (Free)', provider: 'OpenRouter' };

if (IS_PROD && !OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_API_KEY is required when NODE_ENV=production.');
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
    hostedModelsConfigured: Boolean(OPENROUTER_API_KEY)
  });
});


app.get('/api/models', async (_req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: 'No hosted model provider is configured. Set OPENROUTER_API_KEY.' });
  }
  try {
    const models = await getOpenRouterModels();
    res.json({ models });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch models: ' + error.message });
  }
});

app.post('/api/chat', async (req, res) => {
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
    } else {
      throw new Error('The selected model is not supported. Use the free OpenRouter model.');
    }
    sendEvent(res, { done: true });
  } catch (error) {
    sendEvent(res, { error: error.message || 'Model request failed.' });
  } finally {
    res.end();
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`MZH-ONYX running on http://localhost:${PORT} - OAuth removed, OpenRouter only`);
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

async function getOpenRouterModels() {
  try {
    const response = await fetch(`${OPENROUTER_URL}/models`, {
      headers: openRouterHeaders()
    });
    if (!response.ok) throw new Error(`OpenRouter models API failed with ${response.status}`);
    const data = await response.json();
    
    if (!Array.isArray(data.data)) return [DEFAULT_MODEL];
    
    return data.data
      .filter(m => m.id && m.name && !m.id.includes('experimental'))
      .map(m => ({
        id: `openrouter:${m.id}`,
        name: m.name,
        provider: providerLabel({ id: m.id })
      }))
      .slice(0, 50);
  } catch (error) {
    console.error('Error fetching OpenRouter models:', error);
    return [DEFAULT_MODEL];
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
