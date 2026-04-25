# 🚀 SIMPLE DEPLOYMENT GUIDE - STEP BY STEP

## STEP 1️⃣: CHECK PHP BACKEND WORKS LOCALLY

### 1a. Check if PHP is installed
```bash
php -v
# If you see version, PHP is installed
# If you see "not found", PHP not installed (that's OK, we'll test on ServerByt)
```

### 1b. Check PHP files are created
```bash
cd c:/Users/abcom/Desktop/Personal/normless_crm/public_html/api

# List files
ls -la

# Check source code exists
ls src/Controllers/
# Should show: AdminController.php, AuthController.php, etc.
```

### 1c. Validate PHP syntax (optional)
```bash
# If PHP installed:
php -l index.php
# Should say: "No syntax errors detected"

php -l src/Controllers/AuthController.php
# Should say: "No syntax errors detected"
```

### ✅ If all above works, PHP backend is READY!

---

## STEP 2️⃣: BUILD REACT FRONTEND

### 2a. Go to client folder
```bash
cd c:/Users/abcom/Desktop/Personal/normless_crm/client
```

### 2b. Build the project
```bash
npm run build
# This creates: client/dist/ folder with all compiled files
```

### 2c. Verify build successful
```bash
ls dist/
# Should see: index.html, assets/ folder, etc.
```

### ✅ Frontend built and ready!

---

## STEP 3️⃣: UPLOAD TO SERVERBYT (You're already logged in!)

### Files to upload:
```
From Local:                      To ServerByt:
─────────────────────────────────────────────────
client/dist/*              →      public_html/
client/dist/assets/*       →      public_html/assets/
client/dist/index.html     →      public_html/index.html

public_html/api/*          →      public_html/api/
public_html/.htaccess      →      public_html/.htaccess
```

### 3a. Upload via File Manager (What you're already in!)

**Click: Upload button** (in ServerByt File Manager you're viewing)

Then upload:
1. **First:** All files from `client/dist/` to `public_html/`
2. **Second:** `.htaccess` file to `public_html/`
3. **Third:** All files from `public_html/api/` to `public_html/api/`

### OR use FTP (Alternative):
```bash
# Open FileZilla or WinSCP
# Host: ftp.normless.store
# Username: from ServerByt
# Password: from ServerByt
# Port: 21

# Drag & drop folders
```

### ✅ Files uploaded!

---

## STEP 4️⃣: CONFIGURE ON SERVERBYT

### 4a. Check files uploaded
```
In ServerByt File Manager:
- public_html/
  ├── index.html           ✅
  ├── assets/              ✅
  ├── .htaccess            ✅
  └── api/
      ├── index.php        ✅
      ├── .env.local       ✅
      └── src/             ✅
```

### 4b. Update .env.local with YOUR credentials

**In File Manager:**
1. Navigate to: `public_html/api/`
2. Right-click: `.env.local`
3. Click: "Edit"
4. Update these values:

```
JWT_SECRET=my_random_secret_key_12345
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx (from Shopify Admin)
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx (from Google Account)
FRONTEND_URL=https://normless.store
CORS_ORIGIN=https://normless.store
```

5. **Save**

### 4c. Set File Permissions

In ServerByt **File Manager:**

1. Select: `api` folder
2. Right-click → "Permissions"
3. Set: `755` (read/write/execute for owner)
4. **Apply recursively**

5. Select: `crm.db` file
6. Right-click → "Permissions"
7. Set: `666` (read/write)

### 4d. Install PHP Composer packages

**Option A: Using ServerByt SSH (easiest)**

Go to ServerByt → Click: "Terminal" or "SSH"

```bash
cd public_html/api

# Install dependencies
composer install --no-dev

# Check it worked
ls vendor/
# Should see: autoload.php and other folders
```

**Option B: Using Web Installer**

If composer not available:
```bash
cd public_html/api

# Download composer
curl -sS https://getcomposer.org/installer | php

# Install with downloaded composer
php composer.phar install --no-dev
```

### 4e. Initialize Database

**In ServerByt SSH/Terminal:**

```bash
cd public_html/api

# Run initialization
php -r "require 'vendor/autoload.php'; use App\Config\Env; use App\Db\Init; Env::load(); Init::run();"

# Check it worked
ls -la crm.db
# Should show database file created
```

### 4f. Test API is working

**In your browser:**

Visit: `https://normless.store/api/health`

You should see:
```json
{
  "status": "ok",
  "message": "Normless CRM Backend is running!"
}
```

### 4g. Configure Cron Job (Auto-sync every 30 seconds)

**In ServerByt cPanel:**

1. Go to: **Cron Jobs**
2. Click: **Add New Cron Job**
3. Set these values:

```
Minute:     */1        (every 1 minute)
Hour:       *          (every hour)
Day:        *          (every day)
Month:      *          (every month)
Weekday:    *          (every day of week)
```

4. **Command:** (copy exact path from ServerByt)
```bash
/usr/php84/usr/bin/php /home/sites/3b/7/7b3d2b2433/public_html/api/cron-sync.php
```

5. Click: **Save**

### ✅ Configuration complete!

---

## TESTING

### Test 1: Frontend loads
```
Visit: https://normless.store
Should see: React login page
```

### Test 2: API is working
```
Visit: https://normless.store/api/health
Should see: JSON response with "ok" status
```

### Test 3: Login works
```bash
curl -X POST https://normless.store/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"[YOUR_ADMIN_EMAIL]","password":"[REDACTED_PASSWORD]"}'

Should return: JWT token
```

### Test 4: Check sync running
```
Login to app: https://normless.store
Go to Dashboard
Check "Last Sync" shows recent time
```

### ✅ Everything working!

---

## QUICK REFERENCE

| What | Where | How |
|------|-------|-----|
| **Check PHP** | Local | `php -v` |
| **Build Frontend** | Local | `npm run build` in client/ |
| **Upload Files** | ServerByt File Manager | Drag & drop |
| **Edit .env.local** | ServerByt File Manager | Right-click → Edit |
| **Set Permissions** | ServerByt File Manager | Right-click → Permissions → 755 |
| **Install Composer** | ServerByt SSH | `composer install --no-dev` |
| **Init Database** | ServerByt SSH | `php -r "...Init::run();"` |
| **Test API** | Browser | Visit `/api/health` |
| **Setup Cron** | ServerByt cPanel | Add cron job |

---

## TROUBLESHOOTING

### Problem: "404 Not Found" on API
**Solution:**
1. Check `.htaccess` uploaded to both `public_html/` and `public_html/api/`
2. Check mod_rewrite enabled: Contact ServerByt support

### Problem: "Permission Denied" on database
**Solution:**
1. Set permissions: `chmod 666 crm.db`
2. Set folder: `chmod 755 api/`

### Problem: Composer not found
**Solution:**
```bash
cd public_html/api
# Download and install
curl -sS https://getcomposer.org/installer | php
php composer.phar install --no-dev
```

### Problem: .env.local not loading
**Solution:**
1. Verify file exists: `ls -la .env.local`
2. Check permissions: `chmod 644 .env.local`
3. Restart PHP (contact ServerByt support)

### Problem: Database init fails
**Solution:**
1. Check permissions: `chmod 666 crm.db`
2. Check folder writable: `chmod 755 api/`
3. Check .env.local has all credentials

---

## FINAL CHECKLIST

Before declaring SUCCESS:

- [ ] React built: `npm run build` completed
- [ ] Files uploaded: Via ServerByt File Manager
- [ ] .env.local updated: With YOUR credentials
- [ ] Permissions set: 755 for api/, 666 for crm.db
- [ ] Composer installed: vendor/ folder exists
- [ ] Database initialized: crm.db created
- [ ] API working: `/api/health` returns 200
- [ ] Login works: Can login to app
- [ ] Sync running: Cron job configured
- [ ] Dashboard loads: No errors

🎉 **If all checked: YOU'RE LIVE!**

---

**Need help? Check documentation in `public_html/api/TROUBLESHOOTING.md`**
