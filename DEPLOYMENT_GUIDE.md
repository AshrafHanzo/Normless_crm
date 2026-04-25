# 🚀 Normless CRM - Complete Deployment Guide

## Target Server Information
- **Hosting:** ServerByt
- **Domain:** app.normless.store
- **IP Address:** 185.151.30.157
- **Home Path:** /home/sites/3b/7b3d2b2433/

---

## Prerequisites

Before starting, ensure you have:
- SSH access to your ServerByt account
- FTP access (or Git access)
- Node.js v16+ installed on the server
- npm installed on the server
- Your Shopify API credentials ready

---

## Step 1: Connect to Your ServerByt Server

### Option A: Using SSH (Recommended)

```bash
ssh -p 22 username@185.151.30.157
# Or use your domain
ssh -p 22 username@app.normless.store
```

### Option B: Using cPanel/ZPanel

1. Login to your ServerByt control panel
2. Navigate to "File Manager"
3. Choose "public_html" or your project directory

---

## Step 2: Prepare the Server

```bash
# SSH into server
ssh username@185.151.30.157

# Navigate to home directory
cd /home/sites/3b/7b3d2b2433

# Check if Node.js and npm are installed
node --version
npm --version

# If not installed, install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Step 3: Clone or Upload Your Project

### Option A: Using Git (Recommended)

```bash
cd /home/sites/3b/7b3d2b2433

# Clone your repository
git clone https://github.com/yourusername/normless-crm.git .
# or
git clone https://github.com/yourusername/normless-crm.git

# Navigate to project
cd normless-crm
```

### Option B: Using FTP

1. Use FileZilla or similar FTP client
2. Connect: ftp://185.151.30.157
3. Upload your project files to `/home/sites/3b/7b3d2b2433/`

---

## Step 4: Setup Environment Variables

```bash
# Create production .env file
nano .env

# Add the following (update with your actual values):

PORT=5000
NODE_ENV=production
SHOPIFY_STORE_DOMAIN=uqcyff-my.myshopify.com
SHOPIFY_ACCESS_TOKEN=your_actual_shopify_token_here
JWT_SECRET=generate_a_random_secret_string_here

# Press Ctrl+O to save, then Ctrl+X to exit
```

**Important:** Generate a strong JWT_SECRET
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Step 5: Install Dependencies

```bash
# Install server dependencies
npm install --production

# Install client dependencies and build
cd client
npm install
npm run build
cd ..

# Verify build was successful
ls -la client/dist
```

---

## Step 6: Setup Database

```bash
# Initialize database (creates tables and seeding admin user)
node server/db/init.js

# Verify database was created
ls -la server/db/
```

**Default Login Credentials:**
- Username: `admin`
- Password: `admin123`

> ⚠️ **IMPORTANT:** Change these credentials immediately after first login!

---

## Step 7: Install PM2 (Process Manager)

```bash
# Install PM2 globally
sudo npm install -g pm2

# Give PM2 permission to save process list
pm2 update
```

---

## Step 8: Start the Application

### Option A: Using Deployment Script (Automatic)

```bash
# Make script executable
chmod +x deploy.sh

# Run deployment script
./deploy.sh
```

### Option B: Using PM2 Directly

```bash
# Start with ecosystem config
pm2 start ecosystem.config.js --env production

# Or start directly
pm2 start server/index.js --name "normless-crm"

# View logs
pm2 logs normless-crm

# Setup to auto-restart on server reboot
pm2 startup
pm2 save
```

---

## Step 9: Configure Domain & SSL

### In ServerByt ZPanel:

1. **Point Domain to Server:**
   - Go to ZPanel → Domains
   - Add `app.normless.store`
   - Zone file should point to: `185.151.30.157`

2. **Setup SSL Certificate:**
   - ZPanel → SSL Certificates
   - Click "Let's Encrypt"
   - Select `app.normless.store`
   - Click "Generate"
   - Wait for certificate (usually 5-10 minutes)

3. **Configure Reverse Proxy:**
   - ZPanel → Apache
   - Add Virtual Host for `app.normless.store`
   - Configure proxy to `http://localhost:5000`

**Sample Apache Configuration:**
```apache
<VirtualHost *:80>
    ServerName app.normless.store
    ServerAlias www.app.normless.store

    ProxyPreserveHost On
    ProxyPass / http://localhost:5000/
    ProxyPassReverse / http://localhost:5000/

    RewriteEngine On
    RewriteCond %{SERVER_NAME} =app.normless.store
    RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]
</VirtualHost>

<VirtualHost *:443>
    ServerName app.normless.store
    ServerAlias www.app.normless.store

    SSLEngine on
    SSLCertificateFile /path/to/certificate.crt
    SSLCertificateKeyFile /path/to/private.key

    ProxyPreserveHost On
    ProxyPass / http://localhost:5000/
    ProxyPassReverse / http://localhost:5000/
</VirtualHost>
```

---

## Step 10: Restart Apache

```bash
# If using Apache
sudo systemctl restart apache2

# OR if using Nginx
sudo systemctl restart nginx

# Check PM2 is running
pm2 status
pm2 logs normless-crm
```

---

## Step 11: Verify Deployment

1. **Visit your site:**
   - https://app.normless.store

2. **Check logs for errors:**
   ```bash
   pm2 logs normless-crm
   ```

3. **Test API endpoint:**
   ```bash
   curl https://app.normless.store/api/health
   ```

4. **Expected response:**
   ```json
   {"status":"ok","message":"Normless CRM Backend is running!"}
   ```

---

## Step 12: Change Default Admin Password

1. Login to dashboard with `admin` / `admin123`
2. Go to Settings to access admin controls
3. Update password through database or create new admin user

---

## Troubleshooting

### Application Not Starting

```bash
# Check PM2 errors
pm2 logs normless-crm --err

# Restart application
pm2 restart normless-crm

# Stop and restart
pm2 stop normless-crm
pm2 delete normless-crm
npm install -g pm2
pm2 start ecosystem.config.js
```

### Database Issues

```bash
# Check database exists
ls -la server/db/crm.db

# Reinitialize database (WARNING: This will erase all data!)
node server/db/init.js
```

### Port 5000 Already in Use

```bash
# Find what's using port 5000
sudo lsof -i :5000

# Kill process
sudo kill -9 <PID>
```

### SSL Certificate Issues

```bash
# Verify certificate
sudo openssl x509 -in /path/to/certificate.crt -text -noout

# Check certificate expiry
sudo openssl x509 -enddate -noout -in /path/to/certificate.crt
```

---

## Maintenance Commands

```bash
# View all processes
pm2 status

# View real-time logs
pm2 logs normless-crm

# Monitor performance
pm2 monit

# Restart app after code changes
pm2 restart normless-crm

# Stop app (keeps process list)
pm2 stop normless-crm

# Delete app from PM2
pm2 delete normless-crm

# View PM2 startup command
pm2 startup

# Disable auto-restart on reboot
pm2 unstartup
```

---

## Auto-Update Script (Optional)

Create `/home/sites/3b/7b3d2b2433/update.sh`:

```bash
#!/bin/bash
cd /home/sites/3b/7b3d2b2433
git pull origin main
npm install --production
cd client && npm install && npm run build && cd ..
pm2 restart normless-crm
echo "✅ Update complete!"
```

Run periodically with cron:
```bash
0 2 * * * /home/sites/3b/7b3d2b2433/update.sh
```

---

## Security Checklist

- [ ] Changed JWT_SECRET to a random strong value
- [ ] Changed default admin password (admin123)
- [ ] Enabled HTTPS/SSL
- [ ] Set NODE_ENV=production
- [ ] Configured firewall to only allow necessary ports
- [ ] Setup database backups
- [ ] Configured CORS for your domain only
- [ ] Enabled auto-sync on Settings page
- [ ] Tested login and basic functionality

---

## Next Steps

1. **Enable Auto-Sync:**
   - Go to Settings & Sync page
   - Enable "Real-Time Auto-Sync"
   - Set interval (30-60 seconds recommended)

2. **First Sync:**
   - Click "Sync All Data from Shopify"
   - Wait for customers and orders to load

3. **Customize Your CRM:**
   - Add customer interactions
   - Edit customer status/priority/notes
   - Configure your Shopify scopes

---

## Support

For issues, check:
- ZPanel/cPanel documentation for domain setup
- ServerByt support tickets
- PM2 documentation: https://pm2.keymetrics.io/
- Node.js documentation: https://nodejs.org/

---

**Deployment Status: ✅ READY**

Your Normless CRM is now live at **https://app.normless.store** 🎉
