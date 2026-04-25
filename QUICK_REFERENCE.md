# 🎯 QUICK REFERENCE CARD - COPY & PASTE READY

Keep this handy during deployment!

---

## 🔧 QUICK COMMANDS

### STEP 1: Build React
```bash
cd c:/Users/abcom/Desktop/Personal/normless_crm/client
npm run build
```

### STEP 3: SSH Commands (Copy-paste)
```bash
cd public_html/api
composer install --no-dev
php -r "require 'vendor/autoload.php'; use App\Config\Env; use App\Db\Init; Env::load(); Init::run();"
```

### STEP 4: Cron Command (Copy exact)
```
/usr/php84/usr/bin/php /home/sites/3b/7/7b3d2b2433/public_html/api/cron-sync.php
```

---

## 🌐 TEST URLS

| Test | URL |
|------|-----|
| Frontend | https://app.normless.store |
| API Health | https://app.normless.store/api/health |
| Customers | https://app.normless.store/api/customers |
| Orders | https://app.normless.store/api/orders |
| Dashboard | https://app.normless.store (after login) |

---

## 🔐 LOGIN CREDENTIALS

```
Email:    [YOUR_ADMIN_EMAIL]
Password: [REDACTED_PASSWORD]
```

---

## 📦 FILES TO UPLOAD

**From Local → To ServerByt:**

1. `client/dist/*` → `public_html/`
2. `public_html/api/*` → `public_html/api/`
3. `public_html/.htaccess` → `public_html/`

---

## 🔍 TROUBLESHOOTING QUICK FIXES

| Problem | Fix |
|---------|-----|
| 404 on API | Check both .htaccess files uploaded |
| Permission denied | `chmod 755 api/` + `chmod 666 crm.db` |
| Composer not found | Run in SSH: `composer install --no-dev` |
| DB init fails | Check .env.local credentials |
| Login fails | Verify credentials match |
| Sync not running | Check cron job in cPanel |

---

## 📋 FILE CHECKLIST

**Before Upload - Local:**
- [ ] `npm run build` completed
- [ ] `client/dist/` folder exists
- [ ] `public_html/api/.env.local` has credentials
- [ ] `public_html/api/src/Controllers/` has 7 files

**After Upload - ServerByt:**
- [ ] `public_html/index.html` exists
- [ ] `public_html/api/index.php` exists
- [ ] Files visible in File Manager

**After SSH Setup:**
- [ ] `public_html/api/vendor/` folder exists
- [ ] `public_html/api/crm.db` created

**After Cron Setup:**
- [ ] Cron job in cPanel
- [ ] `debug.log` showing activity

---

## ✅ FINAL CHECKS

1. Frontend loads?
   ```
   https://app.normless.store
   ```

2. API working?
   ```
   https://app.normless.store/api/health
   ```

3. Login works?
   ```
   Email: [YOUR_ADMIN_EMAIL]
   Pass: [REDACTED_PASSWORD]
   ```

4. Sync running?
   ```
   Check debug.log in 2 minutes
   ```

---

## 🎯 CREDENTIALS SAVED

```
JWT_SECRET:
[REDACTED_JWT_SECRET]

SHOPIFY_STORE_DOMAIN:
uqcyff-my.myshopify.com

SHOPIFY_ACCESS_TOKEN:
[USE_YOUR_SHOPIFY_TOKEN]

GMAIL_USER:
[USE_YOUR_GMAIL]

GMAIL_APP_PASSWORD:
[USE_YOUR_GMAIL_APP_PASSWORD]

FRONTEND_URL:
https://app.normless.store

CORS_ORIGIN:
https://app.normless.store
```

---

## 📞 SUPPORT

**Documentation Files:**
- `DEPLOYMENT_READY.md` - Full guide
- `SIMPLE_DEPLOYMENT.md` - Simple version
- `API_REFERENCE.md` - All endpoints
- `TROUBLESHOOTING.md` - Problem solver

---

**You got this! 🚀**
