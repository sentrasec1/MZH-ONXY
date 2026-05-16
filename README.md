# MZH-ONYX

Production-ready AI chat workspace with:

- Free GitHub OAuth sign-in
- Server-side model proxying
- Local Ollama support
- Hosted OpenRouter support
- Browser-only chat history stored in local storage

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:8000`.

When `NODE_ENV` is not `production`, a development login button is available if OAuth is not configured.

## Production setup

## Free public URL from GitHub repo

This app needs a Node server, so GitHub Pages is not enough for production OAuth and AI model calls. Use the free Render deployment connected to the GitHub repo:

[Deploy `sentrasec1/MZH-ONXY` on Render](https://render.com/deploy?repo=https://github.com/sentrasec1/MZH-ONXY)

During deploy, set these environment variables:

```bash
APP_URL=https://YOUR-RENDER-SERVICE.onrender.com
OPENROUTER_API_KEY=your-server-side-key
OAUTH_CLIENT_ID=your-github-oauth-app-client-id
OAUTH_CLIENT_SECRET=your-github-oauth-app-client-secret
OAUTH_REDIRECT_URI=https://YOUR-RENDER-SERVICE.onrender.com/auth/callback
```

After Render gives the final URL, update the GitHub OAuth App:

- Homepage URL: `https://YOUR-RENDER-SERVICE.onrender.com`
- Authorization callback URL: `https://YOUR-RENDER-SERVICE.onrender.com/auth/callback`

Copy `.env.example` into your hosting environment and set real values:

```bash
NODE_ENV=production
PORT=8000
APP_URL=https://your-domain.example
SESSION_SECRET=generate-a-long-random-secret
OPENROUTER_API_KEY=your-server-side-key
OAUTH_PROVIDER=github
OAUTH_CLIENT_ID=your-github-oauth-app-client-id
OAUTH_CLIENT_SECRET=your-github-oauth-app-client-secret
OAUTH_REDIRECT_URI=https://your-domain.example/auth/callback
OAUTH_SCOPE=read:user user:email
DEV_AUTH_ENABLED=false
```

For local models, run Ollama and set `OLLAMA_URL` if it is not available at `http://127.0.0.1:11434`.

The production server intentionally refuses to start without `SESSION_SECRET` and OAuth settings. This prevents a public deployment from accidentally exposing the development login.

## Create the free GitHub OAuth app

1. Open [GitHub Developer settings](https://github.com/settings/developers) and create a new OAuth App.
2. Set the homepage URL to your production `APP_URL`.
3. Set the authorization callback URL to `https://your-domain.example/auth/callback`.
4. Copy the Client ID into `OAUTH_CLIENT_ID`.
5. Generate a client secret and copy it into `OAUTH_CLIENT_SECRET`.

For local testing, use:

```bash
APP_URL=http://localhost:8000
OAUTH_REDIRECT_URI=http://localhost:8000/auth/callback
```

## Security notes

Keep API keys and OAuth secrets out of the browser and out of git. `open_apikey.txt` is ignored for local compatibility, but production should use `OPENROUTER_API_KEY` from the environment.
