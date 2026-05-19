# MZH-ONYX

Production-ready AI chat workspace with:

- **No OAuth required**
- **Single free OpenRouter model**
- **Server-side model proxying**
- **Browser-only chat history** stored in local storage

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:8000`.

This app no longer requires authentication. Just set the OpenRouter API key and deploy.

## Production setup

### Render deployment

Use the free Render deployment connected to the GitHub repo:

[Deploy `sentrasec1/MZH-ONXY` on Render](https://render.com/deploy?repo=https://github.com/sentrasec1/MZH-ONXY)

During deploy, set these environment variables:

```bash
NODE_ENV=production
APP_URL=https://YOUR-RENDER-SERVICE.onrender.com
OPENROUTER_API_KEY=your-server-side-key
```

### Configure environment variables

Set the following variables for production:

```bash
NODE_ENV=production
PORT=8000
APP_URL=https://your-domain.example
OPENROUTER_API_KEY=your-server-side-key
```

For local development, you can leave `APP_URL` unset and use `http://localhost:8000`.

## Notes

- The app now runs without authentication and uses a single free OpenRouter model.
- Keep `OPENROUTER_API_KEY` secure and do not expose it to the browser.
- `open_apikey.txt` is supported for local development when `OPENROUTER_API_KEY` is not set.

## Security notes

- Keep `OPENROUTER_API_KEY` secure and out of client-side code.
- `open_apikey.txt` is only for local development and should not be committed.
- The app serves a public chat interface and relies on the server-side OpenRouter key for model access.
