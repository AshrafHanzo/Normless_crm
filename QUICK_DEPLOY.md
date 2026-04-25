# 🚀 NORMLESS CRM - QUICK SERVERBYT DEPLOY (Copy-Paste Ready)

## TL;DR - Just Follow This!

### 1️⃣ Upload Files via FileZilla (FTP)

```
Host: ftp.app.normless.store or your FTP IP
Port: 21
Drag-drop your files to: /normless-crm/

UPLOAD THESE FOLDERS/FILES:
✅ server/
✅ client/dist/ (already built!)
✅ package.json
✅ package-lock.json
✅ .env.production.example
✅ ecosystem.config.js

SKIP THESE:
❌ node_modules/
❌ client/node_modules/
❌ .git/
❌ .env (you'll create on server)
```

### 2️⃣ SSH into Server & Run Commands

```bash
# SSH command (paste in terminal)
ssh username@app.normless.store
# Enter password

# Navigate to project
cd /home/sites/3b/7b3d2b2433/normless-crm

# Install dependencies
npm install --production

# Create environment file
cat > .env << 'EOF'
PORT=5000
NODE_ENV=production
SHOPIFY_STORE_DOMAIN=uqcyff-my.myshopify.com
SHOPIFY_ACCESS_TOKEN=[REDACTED_SHOPIFY_TOKEN]
JWT_SECRET=$(openssl rand -hex 32)
EOF

# Verify .env created
cat .env

# Initialize database (creates SQLite)
node server/db/init.js

# Install PM2
npm install -g pm2

# Start app
pm2 start ecosystem.config.js --env production

# Make it auto-restart
pm2 startup
pm2 save

# Check it's running
pm2 status
pm2 logs normless-crm
```

### 3️⃣ ZPanel Configuration

1. **Point Domain:**
   - ZPanel → Domains → Add domain: app.normless.store
   - Point to: 185.151.30.157

2. **Add Reverse Proxy:**
   - ZPanel → Apache → Virtual Hosts
   - Forward: app.normless.store → http://localhost:5000

3. **Setup SSL:**
   - ZPanel → SSL Certificates → Let's Encrypt
   - Select: app.normless.store
   - Generate certificate

4. **Restart:**
   - `sudo systemctl restart apache2`

### 4️⃣ Verify It Works!

```
Go to: https://app.normless.store
Login: admin / admin123
```

---

## ✅ What Gets Created Automatically

```
node server/db/init.js
        ↓
Creates: server/db/crm.db (SQLite database)
        ↓
Inside database:
  ✅ customers table (13,332 synced from Shopify!)
  ✅ orders table (1,844 orders!)
  ✅ interactions table (notes, calls, emails)
  ✅ admin_users table (admin account)
  ✅ sync_logs table (tracking syncs)
        ↓
Database ready! 🎉
NO MySQL configuration needed!
```

---

## 🎯 Key Commands Reference

```bash
# Start app
pm2 start ecosystem.config.js --env production

# Stop app
pm2 stop normless-crm

# Restart app
pm2 restart normless-crm

# View logs
pm2 logs normless-crm

# View real-time status
pm2 monit

# Auto-restart on reboot
pm2 startup
pm2 save

# Check if port 5000 is free
lsof -i :5000

# Recreate database
node server/db/init.js
```

---

## 🎉 THAT'S IT!

Your CRM is live at: **https://app.normless.store**

Features automatically working:
✅ Dark/Light mode
✅ Real-time auto-sync (every 30 seconds)
✅ Professional branding
✅ Barcode scanner
✅ Customer management
✅ Order tracking

**No MySQL setup needed. SQLite does everything!**
