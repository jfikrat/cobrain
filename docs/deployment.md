# Deployment

This guide covers deploying the Telegram bot and minimal HTTP API in production.

## Requirements

- Linux server with systemd
- Bun v1.3.5 or newer
- Telegram bot token and Anthropic API key
- Optional reverse proxy such as nginx

## Quick Deploy

### 1. Install And Clone

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/jfikrat/cobrain.git
cd cobrain
bun install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Production example:

```env
TELEGRAM_BOT_TOKEN=your_token
MY_TELEGRAM_ID=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx

COBRAIN_BASE_PATH=/home/your_user/.cobrain
API_PORT=3000
COBRAIN_API_KEY=replace-me
PERMISSION_MODE=smart
ENABLE_AUTONOMOUS=true
```

### 3. Test Locally On The Server

```bash
bun run start
```

Verify before moving on:

```bash
curl http://localhost:3000/health
```

## Systemd Service

Create `/etc/systemd/system/cobrain.service`:

```ini
[Unit]
Description=Cobrain AI Assistant
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/home/your_user/projects/cobrain
ExecStart=/home/your_user/.bun/bin/bun run start
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable cobrain
sudo systemctl start cobrain
```

Useful commands:

```bash
sudo systemctl status cobrain
sudo journalctl -u cobrain -f
sudo systemctl restart cobrain
```

## Git-Based Auto-Deploy

Example `post-receive` hook:

```bash
#!/bin/bash
echo "Deploying Cobrain..."

export GIT_WORK_TREE=~/projects/cobrain
export GIT_DIR=~/repos/cobrain.git

git checkout -f main
cd ~/projects/cobrain
~/.bun/bin/bun install
echo "$SUDO_PASS" | sudo -S systemctl restart cobrain

echo "Deploy complete."
```

## Optional Reverse Proxy

If you need TLS or public exposure for the HTTP API, proxy `/health` and `/api/` to `API_PORT`.

Example nginx config:

```nginx
server {
    listen 80;
    server_name cobrain.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name cobrain.example.com;

    ssl_certificate /etc/letsencrypt/live/cobrain.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cobrain.example.com/privkey.pem;

    location /health {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Backups

Back up the global and per-user databases under `COBRAIN_BASE_PATH`.

Example:

```bash
BACKUP_DIR=/home/your_user/backups/cobrain
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"
cp ~/.cobrain/cobrain.db "$BACKUP_DIR/cobrain_$DATE.db"
find ~/.cobrain/users -name cobrain.db -exec cp {} "$BACKUP_DIR" \;
```

## Monitoring

Health check:

```bash
curl http://localhost:3000/health
```

Logs:

```bash
journalctl -u cobrain -f
journalctl -u cobrain -n 100
```

## Troubleshooting

### Service Will Not Start

1. Inspect `journalctl -u cobrain -n 100`.
2. Verify `/home/your_user/projects/cobrain/.env`.
3. Run `bun run start` manually in the project directory.

### Port Already In Use

```bash
ss -tlnp | grep 3000
```

### API Returns 401

1. Set `COBRAIN_API_KEY`.
2. Send `Authorization: Bearer <COBRAIN_API_KEY>`.
3. Confirm your reverse proxy is forwarding the header unchanged.

## Security Checklist

- [ ] Keep `.env` readable only by the service user
- [ ] Set a strong `COBRAIN_API_KEY` before exposing `/api/*`
- [ ] Enable TLS at the reverse proxy
- [ ] Restrict public access if the API is only for local agents
- [ ] Run the service as a non-root user
