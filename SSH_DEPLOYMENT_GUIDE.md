# 🚀 SSH DEPLOYMENT GUIDE - ServerByt (normless.store)

## Your SSH Details
- **SSH Host**: ssh.gb.stackcp.com
- **Username**: normless.store
- **Authentication**: Password or SSH Key
- **Domain**: app.normless.store

---

## Step 1: Connect via SSH

### Option A: Using Terminal (Mac/Linux)
```bash
ssh normless.store@ssh.gb.stackcp.com
# Enter your password when prompted
```

### Option B: Using PuTTY (Windows)
1. Download PuTTY: https://www.putty.org/
2. **Host Name**: ssh.gb.stackcp.com
3. **User**: normless.store
4. **Connection Type**: SSH
5. Click Open

### Option C: Using VS Code (Visual Studio Code)
1. Install "Remote - SSH" extension
2. Click Remote icon (bottom left)
3. Click "Connect to Host..."
4. Enter: `normless.store@ssh.gb.stackcp.com`
5. Click "Connect"

---

## Step 2: Prepare Project Locally

### 2.1 Build React Frontend
```bash
cd client
npm run build
cd ..
# Creates optimized build in client/dist/
```

### 2.2 Create Deployment Structure
```bash
# Create app directory structure
mkdir -p deploy-normless
cp -r server deploy-normless/
cp -r client/dist deploy-normless/client_dist
cp package.json deploy-normless/
cp package-lock.json deploy-normless/
```

---

## Step 3: Upload Project to ServerByt

### Option A: Using SCP (Recommended for Mac/Linux)
```bash
# From your local computer
scp -r deploy-normless normless.store@ssh.gb.stackcp.com:~/app
```

### Option B: Using FileZilla
1. Protocol: SFTP (SSH)
2. Host: ssh.gb.stackcp.com
3. Username: normless.store
4. Password: [your password]
5. Drag & drop `deploy-normless` folder

### Option C: Using Git (If you have GitHub repo)
```bash
# On server (via SSH)
cd ~/
git clone https://github.com/your-username/normless-crm.git app
cd app
```

---

## Step 4: Setup on ServerByt via SSH

### 4.1 Connect to Server
```bash
ssh normless.store@ssh.gb.stackcp.com
```

### 4.2 Navigate to App Directory
```bash
cd ~/app
# Or wherever you uploaded the files
```

### 4.3 Check Node.js Version
```bash
node --version
npm --version
```

If Node.js is NOT installed, contact ServerByt to install it.

### 4.4 Install Dependencies
```bash
npm install --production
# Production mode (skips dev dependencies)
```

### 4.5 Create Environment File
```bash
nano .env.production
# Or use: vi .env.production
```

### 4.6 Add Environment Variables
```env
PORT=3000
NODE_ENV=production

# JWT Secret - Change this to something random and long!
JWT_SECRET=your_super_secret_random_string_here_minimum_32_characters

# Shopify Configuration
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=your_shopify_token_here

# Email Configuration
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=your_app_password_here

# Frontend URLs
FRONTEND_URL=https://app.normless.store
CORS_ORIGIN=https://app.normless.store
```

**Save the file:**
- In nano: `CTRL + X`, then `Y`, then `ENTER`
- In vi: `ESC`, then `:wq`, then `ENTER`

### 4.7 Make Environment File Secure
```bash
chmod 600 .env.production
```

---

## Step 5: Setup Process Manager (PM2)

### 5.1 Install PM2 Globally
```bash
npm install -g pm2
```

### 5.2 Create PM2 Configuration
```bash
nano ecosystem.config.js
```

### 5.3 Paste This Configuration
```javascript
module.exports = {
  apps: [{
    name: 'normless-crm',
    script: './server/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production'
    },
    error_file: '/home/normless.store/app/logs/error.log',
    out_file: '/home/normless.store/app/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M'
  }]
};
```

**Save**: `CTRL + X`, then `Y`, then `ENTER`

### 5.4 Create Logs Directory
```bash
mkdir -p logs
```

### 5.5 Start Application with PM2
```bash
pm2 start ecosystem.config.js
```

### 5.6 Save PM2 Configuration
```bash
pm2 save
pm2 startup
```

### 5.7 Check Status
```bash
pm2 status
pm2 logs normless-crm
```

---

## Step 6: Configure Web Server (Nginx)

### 6.1 Check Nginx Configuration
```bash
cat /etc/nginx/sites-available/app.normless.store
# Or look for your domain config
```

### 6.2 Create/Edit Nginx Config
```bash
sudo nano /etc/nginx/sites-available/app.normless.store
```

### 6.3 Add This Configuration
```nginx
server {
    listen 80;
    listen [::]:80;
    server_name app.normless.store;
    
    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name app.normless.store;

    # SSL Certificate (auto-managed by ServerByt)
    ssl_certificate /etc/ssl/certs/app.normless.store.crt;
    ssl_certificate_key /etc/ssl/private/app.normless.store.key;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Proxy to Node.js
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Static files caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        proxy_pass http://localhost:3000;
    }
}
```

### 6.4 Test Nginx Configuration
```bash
sudo nginx -t
```

### 6.5 Reload Nginx
```bash
sudo systemctl reload nginx
```

---

## Step 7: Verify Deployment

### 7.1 Check If App Is Running
```bash
pm2 status
# Should show "online" status
```

### 7.2 Check Port 3000
```bash
netstat -tuln | grep 3000
# Should show port 3000 listening
```

### 7.3 Test Locally on Server
```bash
curl http://localhost:3000
# Should return something (HTML or JSON)
```

### 7.4 Visit in Browser
```
https://app.normless.store
```

Should show your login page! ✅

---

## Step 8: Setup Auto-Start on Server Reboot

### 8.1 Enable PM2 Auto-Start
```bash
pm2 startup
# Follow the command it outputs
```

### 8.2 Example Output
```bash
# You'll see something like:
# sudo env PATH=$PATH:/usr/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup systemd -u normless.store --hp /home/normless.store

# Copy and run that command:
sudo env PATH=$PATH:/usr/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup systemd -u normless.store --hp /home/normless.store
```

### 8.3 Save PM2
```bash
pm2 save
```

---

## Important: Setup SSL Certificate

### Option A: ServerByt AutoSSL (Easiest)
1. Go to ServerByt Control Panel
2. Find "SSL/TLS Certificates" or "AutoSSL"
3. Enable AutoSSL for app.normless.store
4. Wait 5-10 minutes for certificate generation

### Option B: Manual Let's Encrypt
```bash
# Install Certbot
sudo apt-get update
sudo apt-get install certbot python3-certbot-nginx

# Get certificate
sudo certbot certonly --nginx -d app.normless.store

# Follow prompts and provide email
```

---

## Essential Commands Reference

### Manage Application
```bash
# View status
pm2 status

# View logs
pm2 logs normless-crm

# Restart app
pm2 restart normless-crm

# Stop app
pm2 stop normless-crm

# Start app
pm2 start ecosystem.config.js

# Delete app
pm2 delete normless-crm
```

### Monitor Server
```bash
# Check disk space
df -h

# Check memory usage
free -h

# Check CPU usage
top

# Check processes
ps aux | grep node
```

### Database
```bash
# Backup database
cp server/db/crm.db server/db/crm.db.backup.$(date +%Y%m%d_%H%M%S)

# Check database location
ls -la server/db/
```

### Troubleshooting
```bash
# View error logs
pm2 logs normless-crm --err

# Check Nginx errors
sudo tail -f /var/log/nginx/error.log

# Check which ports are in use
netstat -tuln

# Test Nginx config
sudo nginx -t
```

---

## Common Issues & Fixes

### Issue: Port 3000 Already in Use
```bash
# Find process using port 3000
lsof -i :3000

# Kill process
kill -9 [PID]

# Or change port in .env.production
PORT=3001
pm2 restart normless-crm
```

### Issue: Database Permission Denied
```bash
chmod 755 server/db
chmod 644 server/db/crm.db
```

### Issue: Node Modules Not Found
```bash
npm install --production
```

### Issue: App Crashes on Startup
```bash
# Check logs
pm2 logs normless-crm

# Check if .env exists
ls -la .env.production

# Verify Node version
node --version
```

### Issue: Can't Connect to App
```bash
# Check if Nginx is running
sudo systemctl status nginx

# Check if PM2 app is running
pm2 status

# Check firewall
sudo ufw status
```

---

## Deployment Checklist

- [ ] SSH access working
- [ ] Node.js installed on server
- [ ] Project uploaded to server
- [ ] npm install completed
- [ ] .env.production created with all variables
- [ ] PM2 installed globally
- [ ] Application started with PM2
- [ ] PM2 startup enabled
- [ ] Nginx configured
- [ ] SSL certificate installed
- [ ] Domain pointing correctly
- [ ] App accessible at https://app.normless.store
- [ ] PM2 logs show no errors
- [ ] Database file has correct permissions
- [ ] Backups configured

---

## Post-Deployment

### 1. Setup Automatic Backups
```bash
nano backup.sh
```

Add:
```bash
#!/bin/bash
BACKUP_DIR="/home/normless.store/app/backups"
mkdir -p $BACKUP_DIR
cp /home/normless.store/app/server/db/crm.db $BACKUP_DIR/crm.db.$(date +%Y%m%d_%H%M%S)
# Keep last 7 backups
ls -t $BACKUP_DIR/* 2>/dev/null | tail -n +8 | xargs rm -f 2>/dev/null
```

Make executable:
```bash
chmod +x backup.sh
```

### 2. Schedule Daily Backups
```bash
crontab -e

# Add this line (runs daily at 2 AM):
0 2 * * * /home/normless.store/app/backup.sh
```

### 3. Setup Monitoring
```bash
# Monitor app status
watch -n 5 'pm2 status'
```

---

## Support & Debugging

### Get Detailed Error Info
```bash
pm2 logs normless-crm --lines 100
```

### SSH Directly for Debugging
```bash
ssh normless.store@ssh.gb.stackcp.com
cd app
pm2 logs
```

### Test Connectivity
```bash
curl -I https://app.normless.store
# Should show 200 OK or redirect
```

---

## Success Indicators

✅ You can visit `https://app.normless.store`
✅ Login page loads
✅ No SSL certificate warnings
✅ Dashboard loads data
✅ Can scan orders
✅ Images carousel works
✅ No console errors
✅ `pm2 status` shows "online"

---

**Your CRM is now deployed on ServerByt with SSH! 🚀**

Let me know if you need help with any specific step!
