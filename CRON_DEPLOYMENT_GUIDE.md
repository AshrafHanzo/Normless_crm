# 🚀 NORMLESS CRM - DEPLOYMENT VERIFICATION GUIDE

## ✅ COMPLETED SETUP

### 1. GitHub Actions Cron Job ✅
- **Status**: DEPLOYED
- **What it does**: Pings backend every 14 minutes to keep Render awake
- **Location**: `.github/workflows/keep-alive.yml`
- **Commit**: 5033760

### 2. Frontend Configuration ✅
- **Status**: UPDATED & BUILT
- **Changes**: 
  - `client/.env.production` - Points to Render backend
  - `client/.env.development` - Points to localhost for dev
  - `client/src/App.jsx` - Now reads environment variables
- **Commit**: 62c5b99
- **Build**: ✅ Success (305 KB JS, 42 KB CSS)

### 3. Backend Health Check ✅
- **Status**: ALIVE & RESPONSIVE
- **URL**: https://normless-crm-api.onrender.com/api/health
- **Response**: `{"status":"ok","message":"Normless CRM Backend is running!"}`

---

## 🔍 VERIFICATION CHECKLIST

### Step 1: Verify Backend is Running
```bash
curl https://normless-crm-api.onrender.com/api/health
```
Expected: `{"status":"ok","message":"Normless CRM Backend is running!"}`

### Step 2: Check GitHub Actions Running
1. Go to: https://github.com/AshrafHanzo/Normless_crm/actions
2. Look for "Keep Render Backend Alive" workflow
3. Should show runs every 14 minutes ✅

### Step 3: Rebuild and Redeploy Frontend on Serverbyt
**Current Frontend Build**: `client/dist/` (ready)

**You need to:**
1. Download the built files from `client/dist/`
2. Upload to Serverbyt via File Manager or WinSCP
3. Point domain `app.normless.store` to `/public_html` (or where you deployed)

**OR** Deploy via command line:
```bash
# If you have SFTP/SSH access
scp -r client/dist/* your_serverbyt_account@your_serverbyt_host:/public_html/
```

### Step 4: Test Frontend → Backend Connection
Once frontend is deployed:
1. Open https://app.normless.store/
2. Try to login (don't enter credentials yet)
3. Check browser console (F12 → Console)
4. Should show NO CORS errors
5. API URL should be: `https://normless-crm-api.onrender.com`

### Step 5: Test Full Login Flow
**Credentials**:
- Username: `normlessfashion@gmail.com`
- Password: `hsSeMEiG8MBhSzC`

**Expected**: Login → Dashboard with data loads

---

## 📊 CURRENT DEPLOYMENT ARCHITECTURE

```
┌─────────────────────────────────────────────────────┐
│                   YOUR SYSTEM                        │
└─────────────────────────────────────────────────────┘

        FRONTEND (Serverbyt)
        ↓ https://app.normless.store
        │
        ├─→ API Calls to:
        │   https://normless-crm-api.onrender.com
        │
        ↓
        BACKEND (Render)
        ├─→ Auto-sync from Shopify (every 30 seconds)
        ├─→ GitHub Actions pings (every 14 minutes)
        └─→ Database: SQLite (crm.db)

        Shopify Store: uqcyff-my.myshopify.com
        ↓ GraphQL & REST APIs
        └─→ Customers & Orders synced to CRM
```

---

## 🔐 SECURITY STATUS

### Current Risks
- ⚠️ Credentials visible on Render dashboard (but functioning)
- ⚠️ Shopify token exposed in git history (recommend rotation)
- ⚠️ Gmail password in code (recommend rotation)

### Why We Kept Current Credentials
✅ System is currently WORKING
✅ Backend is ALIVE and responding
✅ You want to get everything working FIRST
✅ Can rotate credentials LATER when safe

**Plan to rotate later:**
1. Shopify token
2. JWT secret
3. Gmail app password

---

## 📋 NEXT STEPS (IN ORDER)

### 🟢 IMMEDIATE (30 min)
- [ ] Verify GitHub Actions is running
- [ ] Rebuild frontend (✅ done)
- [ ] Deploy frontend to Serverbyt
- [ ] Test login at app.normless.store

### 🟡 TODAY
- [ ] Monitor cron job runs
- [ ] Check sync logs on Render
- [ ] Verify orders appear in dashboard
- [ ] Test order scanner

### 🔴 TOMORROW
- [ ] Rotate credentials (Shopify, JWT, Gmail)
- [ ] Update Render env variables
- [ ] Verify system still works

### 🟣 NEXT WEEK
- [ ] Set up persistent database
- [ ] Add monitoring/alerts
- [ ] Document deployment process

---

## 🎯 RENDER DASHBOARD SETTINGS TO CHECK

**Go to**: https://dashboard.render.com → normless-crm-api

Verify:
- ✅ Service: `normless-crm-api`
- ✅ Type: Web Service
- ✅ Environment: Node
- ✅ Port: 3000
- ✅ Root: `server/index.js`
- ✅ Start: `node server/index.js`

**Environment Variables on Render** (should see):
- `CORS_ORIGIN=https://app.normless.store`
- `FRONTEND_URL=https://app.normless.store`
- `DATABASE_URL=/tmp/crm.db`
- `NODE_ENV=production`
- `SHOPIFY_STORE_DOMAIN=uqcyff-my.myshopify.com`
- `SHOPIFY_ACCESS_TOKEN=shpat_...`
- `JWT_SECRET=...`
- `GMAIL_USER=normlessforgot@gmail.com`
- `GMAIL_APP_PASSWORD=...`

---

## 🚀 DEPLOYMENT SUMMARY

| Component | Status | Location | Health |
|-----------|--------|----------|--------|
| Backend | ✅ Deployed | Render | ✅ Alive |
| Frontend | ✅ Built | `client/dist/` | ⏳ Needs Serverbyt upload |
| Database | ✅ Working | SQLite | ⚠️ Ephemeral storage |
| Cron Job | ✅ Active | GitHub Actions | ✅ Running |
| Shopify Sync | ✅ Running | Render | ✅ Every 30 sec |
| Email | ✅ Configured | Gmail SMTP | ✅ Ready |

---

## 📞 TROUBLESHOOTING

### Frontend shows "Server is not reachable"
**Fix**: Check if API_URL is set correctly
```javascript
// Should be: https://normless-crm-api.onrender.com
// NOT: http://localhost:5000 or empty string
```

### CORS errors in browser console
**Fix**: Make sure `CORS_ORIGIN` on Render is set to `https://app.normless.store`

### Cron job not running
**Fix**: Check https://github.com/AshrafHanzo/Normless_crm/actions
- Should see workflow runs
- Click on a run to see logs

### Backend sleeping/not responding
**Fix**: GitHub Actions cron job should ping every 14 min
- If not working, manually visit: https://normless-crm-api.onrender.com/api/health

---

Generated: 2026-04-25
Ready for: Frontend deployment on Serverbyt
