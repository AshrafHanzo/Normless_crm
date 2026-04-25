# 🚀 NEXT STEPS - You're Almost There!

## 📍 Current Status

✅ dist/ uploaded (React frontend)
✅ api/ uploaded (PHP backend)
✅ .htaccess uploaded (routing)
✅ Permissions set correctly

---

## ⚠️ IMPORTANT: crm.db FILE

**The crm.db file DOESN'T EXIST YET!**

It will be created automatically when you run the database initialization command in SSH.

---

## STEP 3: SSH SETUP & DATABASE INIT

### 3a. Connect via SSH

In ServerByt, click: **Terminal** (or SSH)

Then run these commands **ONE BY ONE:**

### Command 1: Navigate to API folder
```bash
cd public_html/api
```

### Command 2: Install Composer packages
```bash
composer install --no-dev
```

Wait for it to complete. You'll see `✓ installed` message.

### Command 3: Initialize Database (CREATE crm.db)
```bash
php -r "require 'vendor/autoload.php'; use App\Config\Env; use App\Db\Init; Env::load(); Init::run();"
```

**This will:**
- Create the `crm.db` file automatically
- Create all database tables
- Initialize the database

---

## STEP 3b: Set crm.db Permissions to 666

**After database is created, in File Manager:**

1. Click into: `public_html/api/` folder
2. You should now see: **crm.db** file (it wasn't there before!)
3. Right-click on: **crm.db**
4. Select: **Permissions**
5. Set to: **666**
6. Click: **Apply**

✅ crm.db now has write permissions!

---

## STEP 4: Configure Cron Job (Auto-Sync)

**In ServerByt cPanel:**

1. Go to: **Cron Jobs**
2. Click: **Add New Cron Job**
3. Set values:
   - **Minute:** `*/1` (every 1 minute)
   - **Hour:** `*`
   - **Day:** `*`
   - **Month:** `*`
   - **Weekday:** `*`
4. **Command:** Copy this exactly:

```bash
/usr/php84/usr/bin/php /home/sites/3b/7/7b3d2b2433/public_html/api/cron-sync.php
```

5. Click: **Save**

✅ Auto-sync will run every minute (syncs every 30 seconds)

---

## STEP 5: TEST YOUR CRM

### Test 1: Visit Frontend
```
Open browser: https://app.normless.store
Should see: React login page with Normless branding
```

### Test 2: Check API Health
```
Open browser: https://app.normless.store/api/health
Should see: {"status": "ok", "message": "Normless CRM Backend is running!"}
```

### Test 3: Login
```
Email:    [YOUR_ADMIN_EMAIL]
Password: [REDACTED_PASSWORD]
Click: Login
Should see: Dashboard with Shopify data
```

### Test 4: Check Sync Status
Wait 1 minute, then in ServerByt File Manager:
1. Open: `public_html/api/debug.log`
2. You should see sync activity logs like:
```
[2026-04-20 19:30:01] Sync started
[2026-04-20 19:30:05] Synced 5 customers
[2026-04-20 19:30:08] Synced 3 orders
```

✅ Auto-sync working!

---

## ✅ COMPLETE CHECKLIST

- [ ] Composer installed (`vendor/` folder exists)
- [ ] Database initialized (crm.db created)
- [ ] crm.db permissions set to 666
- [ ] Cron job added in cPanel
- [ ] Frontend loads at app.normless.store
- [ ] API health check returns 200
- [ ] Can login with credentials
- [ ] Dashboard displays
- [ ] debug.log shows sync activity

---

## 🎉 WHEN ALL ABOVE DONE:

**YOUR CRM IS LIVE!** 🚀

You have:
✅ React frontend running
✅ PHP backend running
✅ SQLite database working
✅ Auto-sync every 30 seconds
✅ All credentials configured
✅ JWT authentication working
✅ Ready for real customers!

---

## 🆘 TROUBLESHOOTING

### Q: crm.db file not appearing after init?
**A:** Check debug.log for errors. Make sure .env.local has all credentials.

### Q: API returns 500 error?
**A:** Check debug.log in FileManager for error messages.

### Q: Login fails?
**A:** Verify credentials are correct:
- Email: [YOUR_ADMIN_EMAIL]
- Password: [REDACTED_PASSWORD]

### Q: Cron job not working?
**A:** 
1. Verify command path is correct
2. Wait 2-3 minutes for first run
3. Check debug.log for output

---

## 📖 REFERENCE

**File Locations:**
- Frontend: `public_html/`
- Backend: `public_html/api/`
- Database: `public_html/api/crm.db`
- Logs: `public_html/api/debug.log`
- Config: `public_html/api/.env.local`

**Test URL:** https://app.normless.store

**Admin Credentials:** [YOUR_ADMIN_EMAIL] / [REDACTED_PASSWORD]

---

**Start with STEP 3a now!** 👆
