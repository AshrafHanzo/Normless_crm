# Render.com Deployment Guide for Normless CRM

## ✅ DONE LOCALLY:
- ✅ Deleted `public_html/` PHP backend folder
- ✅ Created `render.yaml` with deployment config
- ✅ Updated `package.json` with `npm start` script
- ✅ Created `.env.production` file

## 🚀 STEP 1: Deploy to Render.com

### Option A: Use render.yaml (Recommended - Automatic)
1. **Go to Render.com Dashboard**
   - URL: https://dashboard.render.com

2. **Click "New +"** → Select **"Blueprint"**
   
3. **Connect your GitHub repo**
   - Select your normless_crm repository
   - Branch: main

4. **Render will automatically read render.yaml and deploy**
   - Service name: normless-crm-api
   - Plan: Free
   - Region: Pick closest to you

5. **Click "Apply"** and wait for deployment (2-3 minutes)

---

### Option B: Manual Setup (if Option A doesn't work)

1. **Create Web Service**
   - Click "New +" → "Web Service"
   - Select GitHub repository: normless_crm
   - Name: `normless-crm-api`
   - Environment: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: Free

2. **Set Environment Variables**
   - Click on your service → Environment tab
   - Add these variables:
     ```
     NODE_ENV=production
     PORT=3000
     DATABASE_URL=/tmp/crm.db
     JWT_SECRET=[CREATE A RANDOM SECURE STRING]
     SHOPIFY_ACCESS_TOKEN=[your_token]
     SHOPIFY_STORE_DOMAIN=[your_store.myshopify.com]
     GMAIL_USER=[YOUR_GMAIL_ACCOUNT]
     GMAIL_APP_PASSWORD=[app_password]
     CORS_ORIGIN=https://normless.store
     FRONTEND_URL=https://normless.store
     ```

3. **Click "Deploy"**

---

## 🔄 STEP 2: Set Up Keep-Alive Cron Job

**Why?** Free services sleep after 15 min inactivity. Cron job pings every 14 min to keep it awake.

1. **Go to Render Dashboard** → Click "Cron Jobs"

2. **Click "Create Cron Job"**
   - Name: `normless-keep-alive`
   - Frequency: `*/14 * * * *` (every 14 minutes)
   - HTTP Method: GET
   - HTTP Path: `/api/health`

3. **Click "Create"** ✅

---

## 📝 STEP 3: Update Your Frontend

Once you have the Render.com URL (like `https://normless-crm-api-xxxx.onrender.com`):

1. **Update `client/src/App.jsx` or API config**
   - Change API base URL to: `https://normless-crm-api-xxxx.onrender.com`

2. **Build and deploy frontend to ServerbytIO**
   ```bash
   npm run build
   # Upload dist/ contents to ServerbytIO public_html/
   ```

---

## 🗑️ STEP 4: Clean Up ServerbytIO

**Delete from ServerbytIO public_html:**
- ❌ Delete entire `api/` folder (the PHP backend)
- ❌ Delete `.htaccess` file
- ✅ Keep `dist/` or `app/` folder (your React frontend)
- ✅ Keep `index.html`, images, etc.

---

## ✨ After Deployment

Your setup will be:
```
Frontend: https://normless.store (ServerbytIO)
    ↓ (API calls)
Backend: https://normless-crm-api-xxxx.onrender.com (Render.com)
    ↓
Database: SQLite in /tmp/crm.db (auto-persisted)
```

**Cron job keeps backend ALWAYS AWAKE (never sleeps)**

---

## 🆘 Troubleshooting

**Backend not responding?**
- Check Render.com dashboard for error logs
- Verify all env vars are set correctly

**Database errors?**
- SQLite stores in `/tmp/` which persists on Render
- For persistence between deploys, migrate to Render Postgres

**CORS errors?**
- Update `CORS_ORIGIN` in .env.production
- Update `FRONTEND_URL` to match

---

## 💰 Cost
✅ **Completely FREE**
- Web Service: Free tier included
- Cron Job: Free tier included
- No hidden charges
