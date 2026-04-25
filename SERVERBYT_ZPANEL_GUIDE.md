# 🚀 NORMLESS CRM - SERVERBYT ZPANEL DEPLOYMENT GUIDE

## 📚 Table of Contents
1. [What You Need](#what-you-need)
2. [Step 1-5: Upload Files](#step-1-5-upload-files)
3. [Step 6-10: Configure in ZPanel](#step-6-10-configure-zpanel)
4. [Database Setup (NO MySQL needed!)](#database-setup)
5. [Go Live!](#go-live)

---

## ✅ What You Need

✅ ServerByt hosting account
✅ ZPanel access (you already have!)
✅ Domain: app.normless.store
✅ IP: 185.151.30.157
✅ Home Path: `/home/sites/3b/7b3d2b2433/`
✅ That's it! NO separate MySQL needed!

---

## 🎯 Why NO MySQL?

```
❌ NOT using: Traditional PHP + MySQL setup
✅ USING: Node.js + SQLite3 (Built-in!)

SQLite3 Benefits:
✅ No separate database server needed
✅ Database is just a file (crm.db)
✅ Comes with Node.js
✅ Perfect for CRM apps
✅ No configuration needed
✅ Works on shared hosting
```

---

## STEP 1-5: UPLOAD FILES TO ZPANEL

### STEP 1: Login to ZPanel

```
Go to: https://185.151.30.157:10000
Username: Your ZPanel username
Password: Your password
```

### STEP 2: Open File Manager

In ZPanel:
1. Click "File Manager" (or "File Explorer")
2. You should see folders like:
   - public_html/
   - public_html/temp/
   - .cpanel/
   - etc.
3. Look for `/home/sites/3b/7b3d2b2433/` (your home directory)

### STEP 3: Create Project Folder

1. In File Manager, go to your home directory
2. Right-click → "New Folder"
3. Name it: `normless-crm` (or any name without spaces)
4. Enter that folder

### STEP 4: Upload Project Files

You have 2 options:

**OPTION A: FTP Upload (Easiest for beginners)**

Use FileZilla or WinSCP:
```
Host: 185.151.30.157 or app.normless.store
Port: 21 (FTP)
Username: Your FTP username
Password: Your FTP password

Upload to: /normless-crm/
```

Upload all files EXCEPT:
```
❌ DO NOT UPLOAD:
   - node_modules/
   - .git/
   - client/node_modules/
   - .env (you'll create this on server)

✅ DO UPLOAD:
   - server/ (entire folder)
   - client/dist/ (the built files!)
   - package.json
   - package-lock.json
   - .env.production.example
   - ecosystem.config.js
   - deploy.sh
```

**OPTION B: Git Clone (If Git available)**

In ZPanel terminal:
```bash
cd /home/sites/3b/7b3d2b2433/
git clone https://github.com/yourusername/normless-crm.git
cd normless-crm
```

### STEP 5: Verify Files Uploaded

In File Manager, check:
```
/home/sites/3b/7b3d2b2433/normless-crm/
├── server/
├── client/dist/          ← Built React files!
├── package.json
├── ecosystem.config.js
└── .env.production.example
```

---

## STEP 6-10: CONFIGURE IN ZPANEL

### STEP 6: Access Server Terminal

In ZPanel:
1. Go to "Terminal" or "SSH Access" section
2. There's probably a terminal icon
3. Or connect via SSH:
```bash
ssh username@185.151.30.157
# Or use your domain
ssh username@app.normless.store
```

### STEP 7: Check Node.js is Installed

```bash
# Check if Node.js is installed
node --version
npm --version

# If NOT installed, ask ServerByt support to install Node.js v16+
# OR continue - some hosting includes it
```

### STEP 8: Install Dependencies

```bash
# Go to your project folder
cd /home/sites/3b/7b3d2b2433/normless-crm

# Install production dependencies only
npm install --production

# This installs:
# - express
# - sqlite3
# - better-sqlite3
# - All other backend deps
# (does NOT install dev dependencies)
```

### STEP 9: Create Environment File

```bash
# Create .env file
nano .env

# Or use cat:
cat > .env << 'EOF'
PORT=5000
NODE_ENV=production
SHOPIFY_STORE_DOMAIN=uqcyff-my.myshopify.com
SHOPIFY_ACCESS_TOKEN=[REDACTED_SHOPIFY_TOKEN]
JWT_SECRET=your-random-secret-here-make-it-long
EOF

# Save and exit (Ctrl+O, Enter, Ctrl+X)
```

**Generate Strong JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copy the output and paste as JWT_SECRET
```

### STEP 10: Initialize Database

```bash
# Create SQLite database and tables
node server/db/init.js

# You should see:
# ✅ Initializing database schema...
# ✅ Admin user created: username: admin | password: admin123
# ✅ Database initialization complete!

# Verify database created:
ls -la server/db/
# You should see: crm.db file
```

---

## DATABASE SETUP (SQLite - NO MySQL!)

### What Actually Happened:

```bash
node server/db/init.js
↓
Creates: server/db/crm.db (SQLite file)
↓
Creates 6 tables:
  - customers
  - orders
  - interactions
  - admin_users
  - sync_logs
  - (auto-created indices)
↓
Seeds admin user (admin / admin123)
```

### Database Verification

```bash
# Check database file exists
ls -la server/db/crm.db

# Check database size
du -h server/db/crm.db

# No SQL queries needed!
# SQLite handles everything automatically
```

**That's it! Database is ready!** ✅

---

## STEP 11: Start Your App

### Using PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start your app
pm2 start ecosystem.config.js --env production

# Verify it's running
pm2 status

# View logs (if any errors)
pm2 logs normless-crm
```

### Or Direct Mode (If PM2 not available)

```bash
# Start directly with Node
node server/index.js

# You should see:
# 🚀 Normless CRM Backend running on http://localhost:5000
```

---

## STEP 12: Configure Domain in ZPanel

### Point Domain

1. Go to ZPanel → Domains
2. Add domain: `app.normless.store`
3. Point to IP: `185.151.30.157`
4. Save

### Setup Reverse Proxy

1. Go to ZPanel → Apache or Web Server
2. Add Virtual Host or Reverse Proxy rule
3. Configure:
   ```
   URL: https://app.normless.store
   Proxy to: http://localhost:5000
   ```

### Setup SSL Certificate

1. Go to ZPanel → SSL Certificates
2. Click "Let's Encrypt" or automatic SSL
3. Select domain: `app.normless.store`
4. Click "Generate"
5. Wait 5-10 minutes for certificate

### Restart Apache

```bash
sudo systemctl restart apache2
# Or in ZPanel, find "Restart Apache" button
```

---

## STEP 13: Test It's Working!

Open in browser:
```
https://app.normless.store
```

You should see:
```
Login page
↓
Login with: admin / admin123
↓
Dashboard with data
↓
Dark/Light mode works
↓
SUCCESS! ✅
```

### Test API Endpoint

```bash
# In terminal
curl https://app.normless.store/api/health

# Should return:
# {"status":"ok","message":"Normless CRM Backend is running!"}
```

---

## STEP 14: Enable Auto-Sync (Optional)

The auto-sync already runs automatically, but to verify:

```bash
# Check logs
pm2 logs normless-crm

# You should see sync happening every 30 seconds:
# ✨ Auto-sync completed at 10:30:45
# ✨ Auto-sync completed at 10:31:15
# etc.
```

---

## 🎯 COMPLETE CHECKLIST

### Pre-Deployment
- [ ] Files uploaded to /home/sites/3b/7b3d2b2433/normless-crm/
- [ ] .env file created with credentials
- [ ] npm install --production completed
- [ ] Database initialized (node server/db/init.js)
- [ ] App starts without errors (pm2 start or node server/index.js)

### Domain Setup
- [ ] Domain points to 185.151.30.157
- [ ] SSL certificate generated (Let's Encrypt)
- [ ] Reverse proxy configured to localhost:5000
- [ ] Apache restarted

### Testing
- [ ] https://app.normless.store loads
- [ ] Login works with admin/admin123
- [ ] Dashboard shows data
- [ ] Dark/Light mode toggle works
- [ ] API health check passes

### Security
- [ ] Changed default admin password
- [ ] .env file is NOT in git
- [ ] .env permissions set correctly: `chmod 600 .env`
- [ ] JWT_SECRET is random and long (32+ characters)

---

## 🆘 TROUBLESHOOTING

### App Won't Start

```bash
# Check errors
pm2 logs normless-crm --err

# Restart
pm2 restart normless-crm

# Or check if port 5000 is in use
lsof -i :5000

# Kill process using it
sudo kill -9 <PID>

# Restart
pm2 start ecosystem.config.js --env production
```

### Can't Connect to app.normless.store

```bash
# Check domain DNS
nslookup app.normless.store
# Should return: 185.151.30.157

# Check if app is running
pm2 status

# Check Apache reverse proxy is configured
systemctl status apache2
sudo systemctl restart apache2
```

### Database Errors

```bash
# Check database exists
ls -la server/db/crm.db

# If missing, recreate
node server/db/init.js

# If corrupted, backup and recreate
mv server/db/crm.db server/db/crm.db.old
node server/db/init.js
```

### 502 Bad Gateway Error

```bash
# Port 5000 issue
ps aux | grep node
# Find process ID and kill it
kill -9 <PID>

# Restart
pm2 start ecosystem.config.js --env production

# OR check if PM2 is running
pm2 list
```

---

## 📊 MONITORING YOUR CRM

### Check App Status

```bash
pm2 status
# Shows: online, stopped, errored

pm2 monit
# Real-time CPU, memory usage
```

### View Logs

```bash
# All logs
pm2 logs normless-crm

# Errors only
pm2 logs normless-crm --err

# Specific lines
pm2 logs normless-crm | tail -50
```

### Restart App

```bash
pm2 restart normless-crm
# Useful after code updates
```

---

## 🚀 YOU'RE LIVE!

Your Normless CRM is now live at:
```
https://app.normless.store
```

**What Happens Automatically:**
✅ Auto-sync every 30 seconds
✅ Shopify data updates
✅ CRM stays current
✅ No manual syncing needed!

**Database:**
✅ SQLite (server/db/crm.db)
✅ 6 tables created automatically
✅ Admin user seeded
✅ Ready to use

**Features:**
✅ Dark/Light mode
✅ Professional logo
✅ Real-time sync
✅ Beautiful UI

---

## 💡 PRO TIPS

1. **Auto-restart on server reboot:**
   ```bash
   pm2 startup
   pm2 save
   ```

2. **View real-time data:**
   ```bash
   pm2 monit
   ```

3. **Backup database:**
   ```bash
   cp server/db/crm.db server/db/crm.db.backup
   ```

4. **Change admin password:**
   Use database tools or create new admin user

5. **Update code later:**
   ```bash
   git pull
   npm install --production
   pm2 restart normless-crm
   ```

---

## 📞 IF ISSUES, CHECK:

1. Files uploaded correctly?
2. .env file created?
3. npm install completed?
4. Database initialized?
5. Domain pointing to IP?
6. SSL certificate working?
7. Apache configured?
8. Port 5000 not blocked?

---

**🎉 DEPLOYMENT COMPLETE!**
**Your Normless CRM is LIVE!**

Login: admin / admin123
URL: https://app.normless.store
Database: SQLite (no MySQL needed!)
Status: ✅ PRODUCTION READY
