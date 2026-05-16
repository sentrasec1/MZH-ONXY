# MZH-ONYX

Production-ready AI chat workspace with:

- **Multi-provider OAuth**: Google, Microsoft, GitHub sign-in
- **Server-side model proxying**
- **Local Ollama support**
- **Hosted OpenRouter support**
- **Browser-only chat history** stored in local storage

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:8000`.

When `NODE_ENV` is not `production`, a development login button is available if OAuth is not configured.

## Production setup

### Free public URL from GitHub repo

This app needs a Node server, so GitHub Pages is not enough for production OAuth and AI model calls. Use the free Render deployment connected to the GitHub repo:

[Deploy `sentrasec1/MZH-ONXY` on Render](https://render.com/deploy?repo=https://github.com/sentrasec1/MZH-ONXY)

During deploy, set these environment variables:

```bash
APP_URL=https://YOUR-RENDER-SERVICE.onrender.com
OPENROUTER_API_KEY=your-server-side-key
GOOGLE_OAUTH_CLIENT_ID=your-google-oauth-client-id
GOOGLE_OAUTH_CLIENT_SECRET=your-google-oauth-client-secret
OAUTH_REDIRECT_URI=https://YOUR-RENDER-SERVICE.onrender.com/auth/callback
```

### Configure environment variables

Copy `.env.example` into your hosting environment and set real values:

```bash
NODE_ENV=production
PORT=8000
APP_URL=https://your-domain.example
SESSION_SECRET=generate-a-long-random-secret
OPENROUTER_API_KEY=your-server-side-key
OAUTH_REDIRECT_URI=https://your-domain.example/auth/callback

# Configure at least one OAuth provider
GOOGLE_OAUTH_CLIENT_ID=your-google-oauth-client-id
GOOGLE_OAUTH_CLIENT_SECRET=your-google-oauth-client-secret

# Optional: additional providers
MICROSOFT_OAUTH_CLIENT_ID=your-microsoft-oauth-client-id
MICROSOFT_OAUTH_CLIENT_SECRET=your-microsoft-oauth-client-secret
GITHUB_OAUTH_CLIENT_ID=your-github-oauth-client-id
GITHUB_OAUTH_CLIENT_SECRET=your-github-oauth-client-secret

DEV_AUTH_ENABLED=false
```

For local models, run Ollama and set `OLLAMA_URL` if it is not available at `http://127.0.0.1:11434`.

The production server intentionally refuses to start without `SESSION_SECRET` and at least one OAuth provider configured. This prevents a public deployment from accidentally exposing the development login.

## Create OAuth applications

### Google OAuth (Free)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google+ API
4. Go to **Credentials** and create an **OAuth 2.0 Client ID** (Web application)
5. Set **Authorized redirect URIs** to `https://your-domain.example/auth/callback`
6. Copy the Client ID and Client Secret into `.env` as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`

### Microsoft OAuth (Free)

1. Go to [Azure Portal](https://portal.azure.com/)
2. Navigate to **Azure Active Directory** → **App registrations**
3. Click **New registration**
4. Set **Redirect URI** to `https://your-domain.example/auth/callback` (Web)
5. Go to **Certificates & secrets** and create a new client secret
6. Copy the Application (client) ID and client secret value into `.env` as `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET`

### GitHub OAuth (Free, optional)

1. Open [GitHub Developer settings](https://github.com/settings/developers) and create a new OAuth App
2. Set the homepage URL to `https://your-domain.example`
3. Set the authorization callback URL to `https://your-domain.example/auth/callback`
4. Copy the Client ID and Client Secret into `.env` as `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`

For local testing, use:

```bash
APP_URL=http://localhost:8000
OAUTH_REDIRECT_URI=http://localhost:8000/auth/callback
```

## Security notes

- Keep API keys and OAuth secrets out of the browser and out of git
- `open_apikey.txt` is ignored for local compatibility, but production should use `OPENROUTER_API_KEY` from the environment
- All OAuth providers use PKCE (Proof Key for Code Exchange) for enhanced security
- Session tokens are signed with `SESSION_SECRET` to prevent tampering
