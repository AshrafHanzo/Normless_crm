# 🌐 WEB HOSTING DEPLOYMENT GUIDE - ServerByt

## Understanding Your Setup

You have a **shared web hosting** account on ServerByt with:
- Domain: `normless.store` 
- Subdomain: `app.normless.store`
- File Manager access (as shown)
- `public_html` folder for files

---

## ⚠️ Important: Node.js Compatibility

Your CRM is a **Node.js + React application**, which has special requirements.

### Check if ServerByt Supports Node.js

**Option 1: Check in Control Panel**
1. Go to ServerByt Control Panel (cPanel)
2. Look for:
   - "Node.js" section
   - "Application Manager"
   - "Deployment" or "Git Deploy"
   - "Terminal" or "SSH"

**Option 2: Contact ServerByt Support**
- Ask: "Does my hosting plan support Node.js applications?"
- Or: "Can I run Node.js applications?"

---

## IF ServerByt Supports Node.js ✅

### Solution 1A: Deploy via Node.js Manager

**Step 1: Prepare Project**
```bash
# On your local computer
cd client
npm run build
cd ..

# Create deployment folder
mkdir normless-crm-deploy
cp -r server client/dist package*.json normless-crm-deploy/
```

**Step 2: Upload via File Manager**
1. Go to ServerByt File Manager
2. Create folder: `app` in `public_html`
3. Upload all files from `normless-crm-deploy`

**Step 3: In ServerByt Control Panel**
1. Find "Node.js" or "Application Manager"
2. Create new Node.js app
3. Set:
   - **Domain**: `app.normless.store`
   - **Port**: 3000 (or any available port)
   - **Entry point**: `server/index.js`
   - **Node version**: 18 or higher

**Step 4: Deploy & Start**
1. Click "Deploy" or "Start"
2. Wait for startup (1-2 minutes)
3. Visit `https://app.normless.store`

---

## IF ServerByt DOESN'T Support Node.js ❌

Then you need to use a **different hosting service** that supports Node.js.

### Recommended Free/Cheap Options:

**1. Vercel (Recommended for React + Node.js)**
- ✅ Free tier
- ✅ Perfect for full-stack apps
- ✅ Easy deployment

**2. Render.com**
- ✅ Free tier
- ✅ Node.js support
- ✅ Database support

**3. Railway.app**
- ✅ $5/month or pay-as-you-go
- ✅ Great for small apps
- ✅ Easy setup

**4. Fly.io**
- ✅ Free tier available
- ✅ Global deployment
- ✅ Good performance

---

## IF Using Alternative Hosting (Vercel/Render/Railway)

### Setup Steps:

**Step 1: Create Account**
- Go to one of the services above
- Sign up with GitHub

**Step 2: Connect Repository**
1. Push your project to GitHub
2. Connect GitHub account to hosting service
3. Select repository

**Step 3: Configure Deployment**

**For Vercel:**
```
Framework: Next.js / Node.js (select)
Root Directory: ./
Build Command: cd client && npm run build && cd ..
Start Command: node server/index.js
```

**For Render/Railway:**
```
Root Directory: ./
Build Command: npm install && cd client && npm run build && cd ..
Start Command: npm start
```

**Step 4: Add Environment Variables**
In hosting dashboard, add:
```
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=your_token
JWT_SECRET=random_string
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=your_app_password
NODE_ENV=production
```

**Step 5: Deploy**
- Click "Deploy"
- Wait for build (2-5 minutes)
- Get deployed URL

**Step 6: Point Subdomain**
In GoDaddy DNS settings:
1. Add/Edit subdomain `app.normless.store`
2. Point to hosting provider's URL
3. Wait for DNS propagation (24-48 hours)

---

## HYBRID SOLUTION (Best for Your Case)

If you want to keep ServerByt for email/file hosting but run the app elsewhere:

**Frontend** → Deployed on Vercel/Netlify (Free)
**Backend** → Deployed on Render/Railway ($5-10/month)
**Database** → SQLite (travels with backend)
**Email** → Keep with ServerByt

### Setup:

**1. Frontend (Vercel)**
```bash
# Deploy only the React app
cd client
# Create vercel.json
cat > vercel.json << 'EOF'
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist"
}
EOF
```

**2. Backend (Render)**
```bash
# Deploy only the Node.js backend
# vercel.json or similar config
```

---

## QUICK DECISION FLOWCHART

```
Does ServerByt support Node.js?
│
├─ YES (has Node.js Manager)
│  └─ Use Solution 1A above
│     (Upload → Node.js Manager → Deploy)
│
└─ NO (standard web hosting only)
   └─ Options:
      ├─ Move entire app to Vercel/Render
      ├─ Use hybrid (Frontend on Vercel, Backend on Render)
      └─ Buy ServerByt's Node.js hosting upgrade (if available)
```

---

## RECOMMENDED PATH FOR YOU

Based on your setup, I recommend:

### **Option A: If ServerByt supports Node.js** (Easiest)
✅ Deploy everything to ServerByt
✅ Keep it simple
✅ One place to manage

### **Option B: If ServerByt doesn't support Node.js** (Recommended)
✅ Frontend → Vercel (Free)
✅ Backend → Render ($5/month)
✅ Better performance
✅ Professional setup

---

## WHAT TO DO NEXT

### Immediate Action:
1. **Check ServerByt Control Panel for Node.js support**
   - Look for "Node.js", "Application Manager", or similar
   - Or contact support

2. **Once you know what's supported, let me know:**
   - I'll give you exact step-by-step instructions
   - Custom setup for YOUR hosting

---

## HELP ME DECIDE

Can you:
1. **Screenshot** your ServerByt control panel main page
2. **Tell me** what options you see in the panel (PHP, Node.js, etc.)
3. **Confirm** if you want to keep using ServerByt or switch

Then I'll give you the **exact deployment steps** for your specific situation!

---

## TEMPORARY SOLUTION

While you figure out hosting, you can:

**Run locally during development:**
```bash
npm install
npm start
# Runs on http://localhost:5000
# Share via ngrok for testing: npx ngrok http 5000
```

---

**Let me know what ServerByt support options you see, and I'll guide you through the exact deployment! 🚀**
