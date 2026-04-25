# 🚀 FINAL DEPLOYMENT GUIDE - WITH YOUR ACTUAL CREDENTIALS

**Status: ✅ ALL CREDENTIALS CONFIGURED & READY!**

---

## 📋 YOUR CONFIGURATION (Already Set)

### ✅ Environment Variables - ALL CONFIGURED:

```
JWT_SECRET=[REDACTED_JWT_SECRET]

GMAIL_USER=[YOUR_GMAIL_ACCOUNT]
GMAIL_APP_PASSWORD=[REDACTED_GMAIL_PASSWORD]

SHOPIFY_STORE_DOMAIN=uqcyff-my.myshopify.com
SHOPIFY_ACCESS_TOKEN=[REDACTED_SHOPIFY_TOKEN]

FRONTEND_URL=https://app.normless.store
CORS_ORIGIN=https://app.normless.store
```

**File Location:** `public_html/api/.env.local` ✅ **READY TO UPLOAD**

---

## 🌐 YOUR DOMAIN SETUP

```
Shopify Store Domain:    normless.store         (Main store)
CRM App Subdomain:       app.normless.store     (Points to ServerByt)
GoDaddy DNS:             Points to ServerByt IP
```

---

## 📦 COMPLETE DEPLOYMENT CHECKLIST

### STEP 1: BUILD FRONTEND (5 mins)

```bash
cd c:/Users/abcom/Desktop/Personal/normless_crm/client
npm run build
```

✅ Creates `client/dist/` folder

---

### STEP 2: VERIFY FILES READY

```bash
cd c:/Users/abcom/Desktop/Personal/normless_crm/public_html/api

# Check .env.local is updated
cat .env.local | grep -E "FRONTEND_URL|SHOPIFY_STORE_DOMAIN|GMAIL_USER"

# Check PHP files exist
ls src/Controllers/ | wc -l
# Should show: 7
```

✅ All files verified

---

### STEP 3: UPLOAD TO SERVERBYT (You're already logged in!)

**In ServerByt File Manager:**

1. **Upload Frontend Files**
   - From local: `client/dist/*`
   - To ServerByt: `public_html/`
   - Drag & drop all files

2. **Upload Backend Files**
   - From local: `public_html/api/*`
   - To ServerByt: `public_html/api/`
   - Drag & drop entire folder

3. **Upload Web Server Config**
   - From local: `public_html/.htaccess`
   - To ServerByt: `public_html/.htaccess`

✅ All files uploaded

---

### STEP 4: SET PERMISSIONS (3 mins)

**In ServerByt File Manager:**

1. Right-click: `api` folder
   - Select: **Permissions**
   - Set: `755`
   - Apply: **Recursively**

2. Right-click: `crm.db` file
   - Select: **Permissions**
   - Set: `666`

✅ Permissions set

---

### STEP 5: INSTALL PHP & INIT DATABASE (5 mins)

**In ServerByt Terminal/SSH:**

```bash
cd public_html/api

# Install Composer packages
composer install --no-dev

# Initialize database
php -r "require 'vendor/autoload.php'; use App\Config\Env; use App\Db\Init; Env::load(); Init::run();"
```

✅ Database initialized

---

### STEP 6: CONFIGURE AUTO-SYNC CRON JOB (5 mins)

**In ServerByt cPanel:**

1. Go to: **Cron Jobs**
2. Click: **Add New Cron Job**
3. Set Frequency: **Every minute**
4. **Command:** (Copy exact path from your account)

```bash
/usr/php84/usr/bin/php /home/sites/3b/7/7b3d2b2433/public_html/api/cron-sync.php
```

5. Click: **Save**

✅ Auto-sync configured (runs every 30 seconds)

---

## ✅ TESTING - STEP BY STEP

### TEST 1: Frontend Loads

```
Open Browser:
https://app.normless.store

You should see:
✅ React login page
✅ Normless CRM branding
✅ Login form
```

---

### TEST 2: API Health Check

```
Open Browser:
https://app.normless.store/api/health

You should see:
✅ JSON response:
{
  "status": "ok",
  "message": "Normless CRM Backend is running!"
}
```

---

### TEST 3: Login Works

```
Email:    [YOUR_ADMIN_EMAIL]
Password: [REDACTED_PASSWORD]

Click: Login

You should see:
✅ Logged in successfully
✅ Dashboard loads
✅ No errors
```

---

### TEST 4: Check Dashboard

After login:
- ✅ Dashboard shows (even if empty initially)
- ✅ Sync status visible
- ✅ Navigation works
- ✅ No console errors (F12 to check)

---

### TEST 5: Check Auto-Sync

Wait 1-2 minutes after login, then:

1. Go to ServerByt File Manager
2. Open: `public_html/api/debug.log`
3. You should see: Sync activity logs

Example:
```
[2026-04-20 19:30:01] Sync started
[2026-04-20 19:30:05] Synced 5 customers
[2026-04-20 19:30:08] Synced 3 orders
[2026-04-20 19:30:10] Sync completed
```

✅ Auto-sync working!

---

## 🎯 EXPECTED RESULTS

### When Everything Works:

✅ **Frontend**
- React app loads at: `https://app.normless.store`
- Login page displays beautifully
- Dark/Light mode toggle works
- All pages load without errors

✅ **Backend API**
- `/api/health` returns 200 OK
- `/api/auth/login` returns JWT token
- `/api/customers` returns customer list
- `/api/orders` returns order list
- `/api/sync/status` returns sync info

✅ **Auto-Sync**
- Cron job runs every minute
- Shopify data syncs every 30 seconds
- Customer & order counts increase
- debug.log shows activity

✅ **Database**
- crm.db created and populated
- Tables created automatically
- Data persisting correctly

---

## 📊 CREDENTIALS REFERENCE

Save these for later:

```
Admin Login:
  Email:     [YOUR_ADMIN_EMAIL]
  Password:  [REDACTED_PASSWORD]

Shopify Store:
  Domain:    uqcyff-my.myshopify.com
  Token:     [REDACTED_SHOPIFY_TOKEN]

Gmail (Password Reset):
  User:      [YOUR_GMAIL_ACCOUNT]
  App Pass:  [REDACTED_GMAIL_PASSWORD]

JWT Secret:
  [REDACTED_JWT_SECRET]

Frontend URL:
  https://app.normless.store
```

---

## 🆘 TROUBLESHOOTING

| Problem | Solution |
|---------|----------|
| 404 on app.normless.store | Check .htaccess uploaded to both public_html/ and api/ |
| 404 on /api/health | Check mod_rewrite enabled (contact ServerByt) |
| "Permission Denied" | chmod 755 api/ && chmod 666 crm.db |
| Login fails | Verify .env.local has credentials |
| Sync not working | Check cron job in cPanel |
| API returns 500 | Check debug.log for errors |
| DNS not resolving | Wait 24-48 hours for GoDaddy DNS |

---

## ⏱️ TOTAL TIME

| Step | Time |
|------|------|
| Build React | 5 min |
| Upload files | 5 min |
| Set permissions | 3 min |
| Install & init | 5 min |
| Configure cron | 5 min |
| Testing | 5 min |
| **TOTAL** | **~28 mins** |

---

## 🎉 FINAL CHECKLIST

Before declaring LIVE:

- [ ] Frontend builds successfully (`npm run build`)
- [ ] Files uploaded to ServerByt
- [ ] Permissions set (755 & 666)
- [ ] Composer installed (vendor/ exists)
- [ ] Database initialized (crm.db created)
- [ ] Cron job configured in cPanel
- [ ] https://app.normless.store loads React
- [ ] https://app.normless.store/api/health returns 200
- [ ] Login works with credentials
- [ ] Dashboard displays
- [ ] debug.log shows sync activity

✅ **ALL DONE? YOU'RE LIVE!**

---

## 🚀 NEXT ACTIONS

1. **Build React**
   ```bash
   cd client && npm run build
   ```

2. **Upload to ServerByt** (via File Manager)

3. **SSH to ServerByt**
   ```bash
   cd public_html/api
   composer install --no-dev
   php -r "require 'vendor/autoload.php'; use App\Config\Env; use App\Db\Init; Env::load(); Init::run();"
   ```

4. **Add Cron Job** (in cPanel)

5. **Test in Browser**
   ```
   https://app.normless.store
   ```

---

**You're ready! Let's go live! 🚀**

