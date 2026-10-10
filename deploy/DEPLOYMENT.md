# VPS Deployment Guide for Hat Yai Transit MCP

How the Hat Yai Transit MCP server runs on the VPS at `https://mcp.techmavie.digital/hatyaitransit/mcp`.

## Architecture

```
Client (Claude, Cursor, ChatGPT, etc.)
    ↓ HTTPS
https://mcp.techmavie.digital/hatyaitransit/mcp
    ↓
Nginx (SSL termination + reverse proxy, location /hatyaitransit/)
    ↓ HTTP, 127.0.0.1:8101
Docker container mcp-hatyaitransit (port 8080 inside)
    ↓ HTTPS, X-API-Key: <service key>
Hat Yai Transit API (https://hatyaitransit.techmavie.digital)
```

The server is **stateless**: every `POST /mcp` request gets a fresh MCP server and transport, so
no sessions or data are kept between requests.

## Prerequisites

- Docker and Docker Compose on the VPS
- Nginx already serving `mcp.techmavie.digital` with a Let's Encrypt certificate (as for the other MCP servers)
- Host port **8101** free (`ss -tlnp | grep 8101` should print nothing)

## 1. Create the service key (once)

The MCP server needs a *service key* so it can use the journey planner and place search, and
so all of its users don't share the keyless limit of 60 requests/minute.

1. Generate a long random key:

   ```bash
   openssl rand -hex 32
   ```

2. On the Hat Yai Transit API (EasyPanel → app → Environment), add it to `API_SERVICE_KEYS`:

   ```
   API_SERVICE_KEYS=mcp:<the key>
   ```

   (Several services are separated by commas: `mcp:<key1>,other:<key2>`.) Redeploy the API.

3. In the **mcp-hatyaitransit** GitHub repo → Settings → Secrets and variables → Actions, add
   `HYT_API_KEY` with the same key.

## 2. GitHub secrets for auto-deploy

Same as the other MCP servers, plus the key:

| Secret | Value |
|--------|-------|
| `VPS_HOST` | VPS IP address |
| `VPS_USERNAME` | SSH user (e.g. `root`) |
| `VPS_SSH_KEY` | Private SSH key |
| `VPS_PORT` | SSH port (e.g. `22`) |
| `HYT_API_KEY` | The service key from step 1 |

Every push to `main` then runs the tests and, if they pass, deploys: it clones/updates
`/opt/mcp-servers/hatyaitransit`, writes `.env` from `HYT_API_KEY`, rebuilds the image,
restarts the container and waits for `/health`.

## 3. Nginx (once)

Add the block from [`nginx-location.conf`](./nginx-location.conf) inside the existing
`server { ... }` block for `mcp.techmavie.digital`:

```bash
sudo nano /etc/nginx/sites-available/mcp.techmavie.digital
sudo nginx -t
sudo systemctl reload nginx
```

Optionally add Hat Yai Transit to the hub JSON returned by `location = /` in the same file.

No DNS change is needed: `mcp.techmavie.digital` already points to the VPS.

## 4. Manual deployment (without GitHub Actions)

```bash
mkdir -p /opt/mcp-servers
git clone https://github.com/hithereiamaliff/mcp-hatyaitransit.git /opt/mcp-servers/hatyaitransit
cd /opt/mcp-servers/hatyaitransit

cp .env.example .env
nano .env                       # set HYT_API_KEY
chmod 600 .env

docker network inspect mcp-network >/dev/null 2>&1 || docker network create mcp-network
docker compose up -d --build
```

## 5. Check it works

```bash
# On the VPS
curl http://127.0.0.1:8101/health

# From anywhere
curl https://mcp.techmavie.digital/hatyaitransit/health

curl -X POST https://mcp.techmavie.digital/hatyaitransit/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`/health` shows `"apiKeyConfigured": true` once the key is in place (the key itself is never shown).

## Management

```bash
cd /opt/mcp-servers/hatyaitransit
docker compose logs -f              # logs
docker compose restart              # restart
docker compose down                 # stop
git pull && docker compose up -d --build   # update by hand
```

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Nginx 502 Bad Gateway | `docker compose ps`; `docker compose logs`; is port 8101 bound (`ss -tlnp \| grep 8101`)? |
| `plan_journey` says HYT_API_KEY is not configured | `.env` exists and has `HYT_API_KEY=...`; recreate the container (`docker compose up -d`) |
| Tools return `invalid-api-key` | The key in `.env` doesn't match `API_SERVICE_KEYS` on the API server |
| Tools return `rate-limited` | Without a key all users share 60 requests/minute; set the service key |
| Browser clients see CORS errors | Make sure nginx does **not** add its own `Access-Control-*` headers for this location |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Port inside the container |
| `HOST` | `0.0.0.0` | Bind address inside the container |
| `HYT_API_URL` | `https://hatyaitransit.techmavie.digital` | Hat Yai Transit API |
| `HYT_API_KEY` | (empty) | Service key; enables `plan_journey` and `search_places` |
| `HYT_API_TIMEOUT_MS` | `15000` | API request timeout |
