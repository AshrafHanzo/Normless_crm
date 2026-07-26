# Normless CRM — VPS Deployment Runbook

Single source of truth. Stack: **Node/Express + PostgreSQL + PM2 + nginx + Let's Encrypt**.

**Server:** `ssh root@163.128.112.31 -p 2244`
**Path:** `/root/normless_crm`
**CRM domain:** `ops.normless.store`  (subdomain — the Shopify store stays on `normless.store`)
**Repo:** `https://github.com/AshrafHanzo/Normless_crm.git`

> The Node app serves BOTH the API and the built React frontend on port 5000.
> nginx just reverse-proxies to it (works cleanly from /root, no file-permission issues).

---

## 1. Point a SUBDOMAIN at the VPS (GoDaddy — do first, DNS is slow)
⚠️ Do NOT change the `@` record — that's your Shopify store. Add ONE new record:
| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | ops | 163.128.112.31 | 1 Hour |

Verify later:  `ping ops.normless.store` → should show `163.128.112.31`.

---

## 2. Connect & install dependencies (nginx is already installed — skipping it)
```bash
ssh root@163.128.112.31 -p 2244

apt update && apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# PostgreSQL + git + build tools + certbot (nginx already present)
apt install -y postgresql postgresql-contrib git build-essential
apt install -y certbot python3-certbot-nginx

# PM2
npm install -g pm2

node -v && psql --version && nginx -v
```

---

## 3. Create the PostgreSQL database
```bash
sudo -u postgres psql <<'SQL'
CREATE USER normless WITH PASSWORD 'PUT_A_STRONG_DB_PASSWORD_HERE';
CREATE DATABASE normless_crm OWNER normless;
GRANT ALL PRIVILEGES ON DATABASE normless_crm TO normless;
SQL
```
Remember that DB password — it goes in `.env`.

---

## 4. Clone the code into /root
```bash
cd /root
git clone https://github.com/AshrafHanzo/Normless_crm.git normless_crm
cd normless_crm
```

---

## 5. Create the .env (with rotated secrets)
```bash
cp deploy/.env.production.template .env
nano .env
```
Fill these in:
```
DATABASE_URL=postgresql://normless:PUT_A_STRONG_DB_PASSWORD_HERE@localhost:5432/normless_crm
JWT_SECRET=            # generate: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
SHOPIFY_STORE_DOMAIN=uqcyff-my.myshopify.com
SHOPIFY_ACCESS_TOKEN=  # NEW token — see "Rotate Shopify token" below
GMAIL_USER=normlessforgot@gmail.com
GMAIL_APP_PASSWORD=    # NEW Gmail app password
FRONTEND_URL=https://ops.normless.store
CORS_ORIGIN=https://ops.normless.store
ADMIN_USERNAME=normlessfashion@gmail.com
ADMIN_PASSWORD=        # pick a NEW strong login password for the CRM
```
Leave `DB_CLIENT` unset (production uses Postgres).

---

## 6. Install, init DB, build frontend
```bash
npm install --omit=dev            # backend deps (better-sqlite3 is optional, safe to skip on Linux)
node server/db/init-postgres.js   # creates all tables + owner admin (uses ADMIN_PASSWORD)

cd client
npm install
npm run build                     # creates client/dist (Node serves this)
cd ..
```

---

## 7. Start with PM2
```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup     # run the command it prints (survives reboots)

curl http://localhost:5000/api/health     # {"status":"ok",...}
pm2 logs normless-crm                      # watch the first Shopify sync fill the DB
```

---

## 8. nginx site config (already-installed nginx)
```bash
cp deploy/nginx-normless.conf /etc/nginx/sites-available/ops.normless.store
ln -sf /etc/nginx/sites-available/ops.normless.store /etc/nginx/sites-enabled/ops.normless.store
nginx -t
systemctl reload nginx
```
(Leave the default site alone — it may be serving other things on this box.)
Visit `http://ops.normless.store` — app should load over HTTP.

---

## 9. HTTPS (free SSL)
```bash
certbot --nginx -d ops.normless.store
```
Pick "redirect HTTP → HTTPS". Auto-renews. Now `https://ops.normless.store` is live. 🎉

---

## 10. Log in
- `https://ops.normless.store`
- User: `normlessfashion@gmail.com` (or your `ADMIN_USERNAME`)
- Pass: whatever you set as `ADMIN_PASSWORD`

---

## 🔐 Rotate the Shopify access token (old one is considered leaked)
1. Shopify admin → **Settings → Apps and sales channels → Develop apps**.
2. Open your existing custom app (or **Create an app**).
3. **Configuration → Admin API integration** → grant scopes: `read_orders`, `read_customers`, `read_products`.
4. **API credentials → Install app** → reveal the **Admin API access token** (starts `shpat_...`).
5. Put it in `.env` as `SHOPIFY_ACCESS_TOKEN`, then `pm2 restart normless-crm`.
6. In the old app, **uninstall / revoke** the previously-leaked token.

## 🔐 Rotate the Gmail app password
Google Account → **Security → 2-Step Verification → App passwords** → delete the old one, create a new one → put in `.env` as `GMAIL_APP_PASSWORD`.

---

## Updating later (one command)
```bash
cd /root/normless_crm && ./deploy.sh
```

## Firewall (recommended — note the custom SSH port!)
```bash
ufw allow 2244/tcp        # your SSH port — MUST allow before enabling ufw
ufw allow 'Nginx Full'
ufw enable
```

## Handy commands
| Task | Command |
|------|---------|
| App logs | `pm2 logs normless-crm` |
| Restart | `pm2 restart normless-crm` |
| DB shell | `psql "$DATABASE_URL"` |
| nginx reload | `systemctl reload nginx` |
