# 🚀 DEPLOYMENT GUIDE - ServerByte Hosting (app.normless.store)

## Your Hosting Details
- **Primary Domain**: normless.store
- **Subdomain**: app.normless.store
- **Home Path**: /home/sites/3b/7/7b3d2b2433/
- **Platform**: Autoscaling Linux
- **Location**: London, UK
- **FTP Server**: ftp.normless.store
- **Username**: normless
- **IP Address**: 185.151.30.157

---

## Step 1: Prepare Your Project for Deployment

### 1.1 Build React Frontend
```bash
cd client
npm run build
# Creates /client/dist/ with optimized build
```

### 1.2 Create Deployment Package
```bash
# Create a .gitignore for deployment
cat > .deployignore << 'EOF'
node_modules/
.env.local
.DS_Store
*.log
client/node_modules/
client/.venv/
.git/
EOF
```

### 1.3 Compress Project for Upload
```bash
# Create a zip of your project (without node_modules)
zip -r normless_crm_deploy.zip . \
  -x "*/node_modules/*" \
  "*/.*" \
  "client/dist/*" \
  ".git/*" \
  "*.log"

# Size will be ~50-100MB
```

---

## Step 2: Upload to ServerByte via FTP

### 2.1 Using FileZilla (Recommended for Windows/Mac)
1. **Download FileZilla**: https://filezilla-project.org/
2. **Connect with these details**:
   - Host: `ftp.normless.store`
   - Username: `normless`
   - Password: `[Your FTP Password]`
   - Port: `21`
3. **Navigate to**: `/home/sites/3b/7/7b3d2b2433/`
4. **Upload** `normless_crm_deploy.zip`

### 2.2 Using Command Line (Linux/Mac)
```bash
# Connect via FTP
ftp ftp.normless.store
# Login with: normless / [password]
# Commands:
cd /home/sites/3b/7/7b3d2b2433/
put normless_crm_deploy.zip
quit
```

### 2.3 Using SCP (If SSH Available)
```bash
scp normless_crm_deploy.zip normless@185.151.30.157:/home/sites/3b/7/7b3d2b2433/
```

---

## Step 3: Access ServerByte Control Panel

### 3.1 Go to cPanel/Control Panel
- URL: Your hosting control panel (usually cPanel)
- Login with your ServerByte credentials
- Find "File Manager" or "Terminal"

### 3.2 Using SSH (Better Option)
```bash
# SSH into your server
ssh normless@185.151.30.157

# Password: [Your SSH password]
# Navigate to home directory
cd /home/sites/3b/7/7b3d2b2433/
```

---

## Step 4: Extract and Setup Files

### 4.1 Extract the ZIP
```bash
unzip normless_crm_deploy.zip
# This extracts all files to the current directory
```

### 4.2 Check Directory Structure
```bash
ls -la
# You should see:
# - server/
# - client/
# - package.json
# - etc.
```

---

## Step 5: Install Dependencies

### 5.1 Install Node.js Packages (Backend)
```bash
npm install
# Installs all backend dependencies
```

### 5.2 Install Frontend Dependencies
```bash
cd client
npm install
# Installs all frontend dependencies
```

### 5.3 Build React
```bash
npm run build
# Creates optimized build in dist/
```

### 5.4 Return to Root
```bash
cd ..
```

---

## Step 6: Setup Environment Variables

### 6.1 Create Production .env
```bash
nano .env.production
# Or use your preferred editor
```

### 6.2 Add Configuration
```env
# Server Configuration
PORT=5000
NODE_ENV=production

# Database (SQLite - already included)
DATABASE_URL=./server/db/crm.db

# JWT Security
JWT_SECRET=your_super_secret_jwt_key_change_this

# Shopify Configuration
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=your_shopify_token

# Email Configuration
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=your_app_password

# Frontend
FRONTEND_URL=https://app.normless.store
CORS_ORIGIN=https://app.normless.store
```

### 6.3 Secure the .env File
```bash
chmod 600 .env.production
# Restricts access to owner only
```

---

## Step 7: Configure Node.js with PM2

### 7.1 Install PM2 Globally
```bash
npm install -g pm2
```

### 7.2 Create PM2 Configuration
```bash
nano ecosystem.config.js
```

### 7.3 Add Configuration
```javascript
module.exports = {
  apps: [{
    name: 'normless-crm',
    script: './server/index.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 5000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G'
  }]
};
```

### 7.4 Start with PM2
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
# Follow the startup command it provides
```

### 7.5 Check Status
```bash
pm2 status
pm2 logs
```

---

## Step 8: Configure Web Server (Nginx/Apache)

### 8.1 For Nginx (Recommended)
```bash
# Edit nginx config
sudo nano /etc/nginx/sites-available/app.normless.store
```

### 8.2 Nginx Configuration
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

    # SSL Certificates (Use Let's Encrypt via ServerByte)
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # Proxy to Node.js
    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Static files caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### 8.3 Enable Site
```bash
sudo ln -s /etc/nginx/sites-available/app.normless.store /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## Step 9: SSL Certificate Setup

### 9.1 Get Free SSL (Let's Encrypt)
```bash
# If certbot is installed
sudo certbot certonly --webroot -w /home/sites/3b/7/7b3d2b2433 -d app.normless.store

# Or use ServerByte's AutoSSL in control panel
```

### 9.2 Update Nginx Config with Certificate Paths
```bash
# Update ssl_certificate paths in nginx config
```

---

## Step 10: Verify Deployment

### 10.1 Check Application
```bash
# Check if Node.js is running
curl http://localhost:5000

# Should show your API response or login page
```

### 10.2 Test via Browser
```
https://app.normless.store
```

Should show:
- ✅ Login page loads
- ✅ HTTPS working
- ✅ No console errors

### 10.3 Verify PM2 Is Running
```bash
pm2 status
pm2 logs normless-crm
```

---

## Step 11: Database & Backups

### 11.1 Ensure Database Directory
```bash
mkdir -p server/db
chmod 755 server/db
chmod 644 server/db/crm.db
```

### 11.2 Backup Database
```bash
# Create backup script
nano backup.sh
```

### 11.3 Backup Script
```bash
#!/bin/bash
BACKUP_DIR="./backups"
mkdir -p $BACKUP_DIR
cp server/db/crm.db $BACKUP_DIR/crm.db.$(date +%Y%m%d_%H%M%S)
# Keep last 7 backups
ls -t $BACKUP_DIR/* | tail -n +8 | xargs rm -f
```

### 11.4 Schedule Backup (Cron)
```bash
crontab -e
# Add: 0 2 * * * /home/sites/3b/7/7b3d2b2433/backup.sh
# Runs daily at 2 AM
```

---

## Step 12: Monitor & Maintain

### 12.1 Monitor Application
```bash
# Check logs
pm2 logs normless-crm

# Check memory usage
pm2 monit

# Restart if needed
pm2 restart normless-crm
```

### 12.2 Update Environment
```bash
# If you need to change env vars
nano .env.production
pm2 restart normless-crm
```

### 12.3 Check Disk Space
```bash
df -h
# Ensure adequate space available
```

---

## Troubleshooting

### Issue: Port Already in Use
```bash
# Change port in .env.production
PORT=3000
# Update nginx config proxy_pass
pm2 restart normless-crm
```

### Issue: Database Lock
```bash
# SQLite can lock if multiple processes access it
# Solution: Use PM2's single instance mode
# Edit ecosystem.config.js and change instances to 1
```

### Issue: Memory Issues
```bash
# Increase swap
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### Issue: CORS Errors
```bash
# Verify CORS_ORIGIN in .env matches your domain
CORS_ORIGIN=https://app.normless.store
```

### Issue: Static Files Not Loading
```bash
# Check nginx static file configuration
# Ensure client/dist files are in public directory
```

---

## Post-Deployment Checklist

- ✅ Project uploaded and extracted
- ✅ Dependencies installed (npm install)
- ✅ React built (npm run build)
- ✅ Environment variables configured
- ✅ PM2 running and configured for startup
- ✅ Web server configured (Nginx/Apache)
- ✅ SSL certificate installed
- ✅ Domain pointing correctly
- ✅ Database accessible
- ✅ Logs accessible via PM2
- ✅ Backups configured
- ✅ Monitoring setup

---

## Quick Commands Reference

```bash
# SSH into server
ssh normless@185.151.30.157

# Check if app is running
pm2 status

# View logs
pm2 logs normless-crm

# Restart app
pm2 restart normless-crm

# Stop app
pm2 stop normless-crm

# Start app
pm2 start ecosystem.config.js

# Check server disk space
df -h

# Check memory usage
free -h

# Check which ports are listening
netstat -tuln | grep LISTEN

# Tail error logs
tail -f logs/pm2-error.log
```

---

## Security Recommendations

1. ✅ Change JWT_SECRET to a strong random value
2. ✅ Use HTTPS/SSL certificate
3. ✅ Set secure password for database access
4. ✅ Enable firewall rules
5. ✅ Regular backups
6. ✅ Monitor logs for errors
7. ✅ Update Node.js regularly
8. ✅ Keep dependencies updated

---

## Need Help?

If you encounter any issues:

1. Check PM2 logs: `pm2 logs normless-crm`
2. Check nginx logs: `tail -f /var/log/nginx/error.log`
3. SSH into server and debug
4. Verify environment variables
5. Check domain DNS settings

---

**Your CRM is ready for production deployment! 🚀**

Let me know if you need help with any specific step!
