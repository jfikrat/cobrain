# Deployment

This guide covers deploying Cobrain to a production server.

## Requirements

- Linux server (Ubuntu 22.04 or similar)
- Bun v1.3.5 or higher
- Systemd (for service management)
- Optional: nginx (for reverse proxy)

## Quick Deploy

### 1. Server Setup

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Clone repository
git clone https://github.com/yourusername/cobrain.git
cd cobrain

# Install dependencies
bun install
```

### 2. Environment Configuration

```bash
cp .env.example .env
nano .env
```

Configure production values:

```env
# Required
TELEGRAM_BOT_TOKEN=your_token
ALLOWED_USER_IDS=123456789
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Production settings
COBRAIN_BASE_PATH=/home/user/.cobrain
WEB_PORT=3000
WEB_URL=https://cobrain.yourdomain.com
ENABLE_WEB_UI=true
PERMISSION_MODE=smart
```

### 3. Build CSS

```bash
bun run build:css
```

### 4. Test Run

```bash
bun run start
```

Verify everything works before setting up the service.

## Systemd Service

### Create Service File

```bash
sudo nano /etc/systemd/system/cobrain.service
```

```ini
[Unit]
Description=Cobrain AI Assistant
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/home/your_user/projects/cobrain
ExecStart=/home/your_user/.bun/bin/bun run src/index.ts
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Enable and Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable cobrain
sudo systemctl start cobrain
```

### Service Commands

```bash
# Check status
sudo systemctl status cobrain

# View logs
sudo journalctl -u cobrain -f

# Restart
sudo systemctl restart cobrain

# Stop
sudo systemctl stop cobrain
```

## Git-Based Auto-Deploy

Set up automatic deployment on git push.

### 1. Create Bare Repository

```bash
mkdir -p ~/repos/cobrain.git
cd ~/repos/cobrain.git
git init --bare
```

### 2. Create Post-Receive Hook

```bash
nano hooks/post-receive
```

```bash
#!/bin/bash

echo "🚀 Deploying Cobrain..."

export GIT_WORK_TREE=~/projects/cobrain
export GIT_DIR=~/repos/cobrain.git

# Checkout code
git checkout -f main

# Install dependencies
cd ~/projects/cobrain
~/.bun/bin/bun install

# Build CSS
~/.bun/bin/bun run build:css

# Restart service (requires sudo without password for this command)
echo 'YOUR_PASSWORD' | sudo -S systemctl restart cobrain

echo "✅ Deploy complete!"
```

```bash
chmod +x hooks/post-receive
```

### 3. Add Remote Locally

On your development machine:

```bash
git remote add production user@server:~/repos/cobrain.git
```

### 4. Deploy

```bash
git push production main
```

## Reverse Proxy (nginx)

### Install nginx

```bash
sudo apt install nginx
```

### Configure Site

```bash
sudo nano /etc/nginx/sites-available/cobrain
```

```nginx
server {
    listen 80;
    server_name cobrain.yourdomain.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name cobrain.yourdomain.com;

    # SSL certificates (use Let's Encrypt)
    ssl_certificate /etc/letsencrypt/live/cobrain.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cobrain.yourdomain.com/privkey.pem;

    # SSL settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;

    # Proxy settings
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeout
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

### Enable Site

```bash
sudo ln -s /etc/nginx/sites-available/cobrain /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### SSL with Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d cobrain.yourdomain.com
```

## Environment Variables

For production, consider:

```env
# Security
PERMISSION_MODE=smart

# Performance
MAX_HISTORY=10
MAX_MEMORY_AGE_DAYS=90

# Monitoring
ENABLE_AUTONOMOUS=true

# Web UI
ENABLE_WEB_UI=true
WEB_PORT=3000
WEB_URL=https://cobrain.yourdomain.com
```

## Backup

### Database Backup

```bash
# Backup script
#!/bin/bash
BACKUP_DIR=/home/user/backups/cobrain
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Backup global database
cp ~/.cobrain/cobrain.db $BACKUP_DIR/cobrain_$DATE.db

# Backup user databases
for dir in ~/.cobrain/user_*; do
    user_id=$(basename $dir)
    cp $dir/cobrain.db $BACKUP_DIR/${user_id}_$DATE.db
done

# Keep last 7 days
find $BACKUP_DIR -mtime +7 -delete
```

### Cron Job

```bash
crontab -e
```

```
0 3 * * * /home/user/scripts/backup_cobrain.sh
```

## Monitoring

### Health Check

```bash
curl http://localhost:3000/health
```

### Log Monitoring

```bash
# Live logs
journalctl -u cobrain -f

# Last 100 lines
journalctl -u cobrain -n 100

# Errors only
journalctl -u cobrain -p err
```

### Process Monitoring

```bash
# Check if running
systemctl is-active cobrain

# Memory usage
ps aux | grep cobrain
```

## Troubleshooting

### Service Won't Start

1. Check logs: `journalctl -u cobrain -n 50`
2. Verify environment: `cat /home/user/projects/cobrain/.env`
3. Test manually: `cd /home/user/projects/cobrain && bun run start`

### Port Already in Use

```bash
# Find process using port
ss -tlnp | grep 3000

# Kill if needed
kill -9 $(lsof -t -i:3000)
```

### Database Errors

```bash
# Check file permissions
ls -la ~/.cobrain/

# Repair permissions
chmod 644 ~/.cobrain/*.db
chmod 755 ~/.cobrain/
```

### WebSocket Not Connecting

1. Check nginx WebSocket config
2. Verify SSL certificates
3. Check firewall rules
4. Test without proxy first

## Security Checklist

- [ ] Strong `TELEGRAM_BOT_TOKEN`
- [ ] Limited `ALLOWED_USER_IDS`
- [ ] HTTPS enabled
- [ ] Firewall configured (only 80/443 open)
- [ ] Regular backups
- [ ] Log rotation enabled
- [ ] Service runs as non-root user
- [ ] `.env` file has restricted permissions (600)
