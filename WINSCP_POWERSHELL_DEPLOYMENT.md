# 🪟 WINSCP + WINDOWS POWERSHELL DEPLOYMENT GUIDE

## Perfect for Windows Users!

---

## Part 1: WinSCP Setup (File Upload)

### 1.1 Download & Install WinSCP
1. Go to: https://winscp.net/eng/download.php
2. Download **WinSCP (Portable executable)** or **Installation package**
3. Install it
4. Open WinSCP

### 1.2 Create New SSH Session in WinSCP

**Click: "New Session" or "New Site"**

Fill in:
```
Protocol:        SFTP (SSH)
Host name:       ssh.gb.stackcp.com
Port:            22
User name:       normless.store
Password:        [your password]
```

**Click "Save" → Name it: "ServerByt Normless"**

### 1.3 Connect to Server
```
Double-click the saved session
OR
Click "Login"
```

Should connect successfully! ✅

### 1.4 Upload Files

**In WinSCP:**

Left side (Local Computer):
- Navigate to your project folder

Right side (Server):
- Navigate to: `/home/normless.store/`

**Create new folder on server:**
- Right-click → "Create folder" → Name: `app`

**Upload your project:**
```
Drag & drop your project files to the 'app' folder
OR
Select files → Right-click → "Upload"
```

**Files to upload:**
```
server/
client/dist/
package.json
package-lock.json
.env (with your variables)
```

Wait for upload to complete ✅

---

## Part 2: Windows PowerShell Setup

### 2.1 Install OpenSSH on Windows

**Open PowerShell as Administrator:**

```powershell
# Check if OpenSSH is installed
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH*'

# If not installed, install it:
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# Verify installation
ssh -V
```

### 2.2 Test SSH Connection from PowerShell

```powershell
# Try connecting
ssh normless.store@ssh.gb.stackcp.com

# Type: yes (to accept server key)
# Type: [your password]
# You should be connected! ✅
```

---

## Part 3: Deploy via PowerShell

### 3.1 Prepare Project Locally

**Open PowerShell in your project folder:**

```powershell
# Navigate to your project
cd C:\Users\YourUsername\Desktop\normless_crm

# Build React
cd client
npm run build
cd ..

# Check if files exist
Get-Item server\index.js
Get-Item client\dist
Get-Item package.json
```

### 3.2 SSH Into Server via PowerShell

```powershell
# Connect to server
ssh normless.store@ssh.gb.stackcp.com

# You're now on the server! Everything you type runs on ServerByt
```

### 3.3 Run Commands on Server

**Once connected via SSH, run these commands:**

```bash
# Navigate to app folder (if you haven't already)
cd ~/app
ls -la

# Install dependencies
npm install --production

# Create environment file
cat > .env.production << 'EOF'
PORT=3000
NODE_ENV=production
JWT_SECRET=your_super_secret_random_string_here_minimum_32_characters
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=your_token
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=your_app_password
FRONTEND_URL=https://app.normless.store
CORS_ORIGIN=https://app.normless.store
EOF

# Make .env secure
chmod 600 .env.production

# Verify .env was created
cat .env.production
```

### 3.4 Install PM2 & Start App

```bash
# Install PM2 globally
npm install -g pm2

# Start the app
pm2 start server/index.js --name "normless-crm"

# Save PM2
pm2 save

# Enable auto-start on server reboot
pm2 startup

# Check status
pm2 status

# View logs
pm2 logs normless-crm
```

### 3.5 Exit SSH (Back to Windows)

```bash
exit
# Or press: Ctrl + D
# Now you're back in Windows PowerShell
```

---

## Part 4: PowerShell SSH Shortcuts

### Create PowerShell Profile for Quick Commands

**Open PowerShell as Administrator:**

```powershell
# Create profile if it doesn't exist
if (!(Test-Path -Path $PROFILE)) {
    New-Item -ItemType File -Path $PROFILE -Force
}

# Open in Notepad
notepad $PROFILE
```

**Add these shortcuts to the file:**

```powershell
# SSH to ServerByt
function Connect-ServerByt {
    ssh normless.store@ssh.gb.stackcp.com
}

# SSH and go to app folder
function Connect-App {
    ssh normless.store@ssh.gb.stackcp.com -t "cd ~/app && bash"
}

# Quick copy files to server
function Upload-Project {
    scp -r C:\Users\$env:USERNAME\Desktop\normless_crm\server normless.store@ssh.gb.stackcp.com:~/app/
    scp -r C:\Users\$env:USERNAME\Desktop\normless_crm\client\dist normless.store@ssh.gb.stackcp.com:~/app/
    scp C:\Users\$env:USERNAME\Desktop\normless_crm\package.json normless.store@ssh.gb.stackcp.com:~/app/
    Write-Host "Upload complete!"
}

# SSH commands without interactive shell
function ServerByt-Command {
    param([string]$cmd)
    ssh normless.store@ssh.gb.stackcp.com $cmd
}

# Examples:
# ServerByt-Command "pm2 status"
# ServerByt-Command "pm2 logs normless-crm"
# ServerByt-Command "pm2 restart normless-crm"
```

**Save and close Notepad**

**Reload PowerShell profile:**

```powershell
# Reload profile
. $PROFILE
```

---

## Part 5: Quick Commands with PowerShell

### Now you can use shortcuts!

```powershell
# Connect to server
Connect-ServerByt
# or
Connect-App

# Upload project
Upload-Project

# Run server commands without logging in
ServerByt-Command "pm2 status"
ServerByt-Command "pm2 logs normless-crm"
ServerByt-Command "pm2 restart normless-crm"
ServerByt-Command "pm2 stop normless-crm"
ServerByt-Command "pm2 start ecosystem.config.js"
```

---

## Part 6: Advanced PowerShell Scripts

### Create Deploy Script

**Create file: `C:\deploy.ps1`**

```powershell
param(
    [string]$action = "deploy"
)

$server = "normless.store@ssh.gb.stackcp.com"
$projectPath = "C:\Users\$env:USERNAME\Desktop\normless_crm"
$appFolder = "~/app"

function Deploy {
    Write-Host "Building React..." -ForegroundColor Green
    Set-Location "$projectPath\client"
    npm run build
    Set-Location $projectPath
    
    Write-Host "Uploading files..." -ForegroundColor Green
    scp -r server $server`:$appFolder/
    scp -r client\dist $server`:$appFolder/
    scp package.json $server`:$appFolder/
    scp package-lock.json $server`:$appFolder/
    
    Write-Host "Installing dependencies..." -ForegroundColor Green
    ssh $server "cd $appFolder && npm install --production"
    
    Write-Host "Deployment complete!" -ForegroundColor Green
}

function Restart {
    Write-Host "Restarting app..." -ForegroundColor Green
    ssh $server "pm2 restart normless-crm"
    Write-Host "Restarted!" -ForegroundColor Green
}

function Status {
    Write-Host "Checking status..." -ForegroundColor Green
    ssh $server "pm2 status"
}

function Logs {
    Write-Host "Showing logs..." -ForegroundColor Green
    ssh $server "pm2 logs normless-crm --lines 50"
}

function Backup {
    Write-Host "Creating backup..." -ForegroundColor Green
    $date = Get-Date -Format "yyyyMMdd_HHmmss"
    ssh $server "cp ~/app/server/db/crm.db ~/app/backups/crm.db.$date"
    Write-Host "Backup created!" -ForegroundColor Green
}

# Execute based on parameter
switch ($action) {
    "deploy" { Deploy }
    "restart" { Restart }
    "status" { Status }
    "logs" { Logs }
    "backup" { Backup }
    default { Write-Host "Usage: deploy.ps1 [deploy|restart|status|logs|backup]" }
}
```

### Use the Deploy Script

```powershell
# Full deployment
./deploy.ps1 deploy

# Restart app
./deploy.ps1 restart

# Check status
./deploy.ps1 status

# View logs
./deploy.ps1 logs

# Backup database
./deploy.ps1 backup
```

---

## Part 7: Complete Windows PowerShell Workflow

### 1. Setup (One-time)
```powershell
# Install OpenSSH
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0

# Create profile with shortcuts
# (Follow Part 4 above)

# Test connection
ssh normless.store@ssh.gb.stackcp.com "echo Connected!"
```

### 2. Development
```powershell
# Build your app locally
cd C:\Users\YourUsername\Desktop\normless_crm
npm run dev  # for local testing
```

### 3. Deploy
```powershell
# Option A: Use WinSCP for GUI upload
# Open WinSCP → Upload files

# Option B: Use PowerShell script
./deploy.ps1 deploy

# Option C: Manual SSH
ssh normless.store@ssh.gb.stackcp.com
# cd ~/app
# npm install --production
# pm2 restart normless-crm
```

### 4. Monitor
```powershell
# Check status
./deploy.ps1 status

# View logs
./deploy.ps1 logs

# Restart if needed
./deploy.ps1 restart
```

### 5. Backup
```powershell
# Backup database
./deploy.ps1 backup
```

---

## Part 8: Using SCP in PowerShell

### Copy Files to Server
```powershell
# Upload single file
scp C:\path\to\file.txt normless.store@ssh.gb.stackcp.com:~/app/

# Upload entire folder
scp -r C:\path\to\folder normless.store@ssh.gb.stackcp.com:~/app/

# Upload with progress
scp -r C:\Users\YourUsername\Desktop\normless_crm normless.store@ssh.gb.stackcp.com:~/app
```

### Copy Files from Server
```powershell
# Download single file
scp normless.store@ssh.gb.stackcp.com:~/app/server/db/crm.db C:\backups\

# Download entire folder
scp -r normless.store@ssh.gb.stackcp.com:~/app/backups C:\local\backups\
```

---

## Part 9: Troubleshooting in PowerShell

### Check SSH Connection
```powershell
# Test connection
Test-NetConnection ssh.gb.stackcp.com -Port 22

# Should show: TcpTestSucceeded = True
```

### Get SSH Key Fingerprint
```powershell
# First time connecting
ssh normless.store@ssh.gb.stackcp.com

# Type: yes (to add host key to known_hosts)
```

### Fix Permission Issues
```powershell
# If you get permission denied
ssh normless.store@ssh.gb.stackcp.com
# Then on server:
chmod 600 ~/.ssh/authorized_keys
chmod 700 ~/.ssh
```

### View Known Hosts
```powershell
# Location of known hosts
Get-Content $env:USERPROFILE\.ssh\known_hosts

# Edit if needed
notepad $env:USERPROFILE\.ssh\known_hosts
```

---

## Part 10: SSH Key Authentication (Secure)

### Generate SSH Key Locally

```powershell
# Generate key pair
ssh-keygen -t rsa -b 4096 -f "$env:USERPROFILE\.ssh\normless" -N ""

# Check if created
Get-Item "$env:USERPROFILE\.ssh\normless*"
```

### Copy Public Key to Server

```powershell
# Get your public key content
Get-Content "$env:USERPROFILE\.ssh\normless.pub"

# Copy entire output

# Then SSH and add it:
ssh normless.store@ssh.gb.stackcp.com

# On server:
cat >> ~/.ssh/authorized_keys << 'EOF'
[PASTE YOUR PUBLIC KEY HERE]
EOF

exit
```

### Use Key for SSH (No Password)

```powershell
# SSH with key
ssh -i "$env:USERPROFILE\.ssh\normless" normless.store@ssh.gb.stackcp.com

# Should connect without password!
```

---

## Part 11: Complete PowerShell Example

### One-Command Deployment

```powershell
# Create: C:\deploy-complete.ps1

function Deploy-Complete {
    $server = "normless.store@ssh.gb.stackcp.com"
    $projectPath = "C:\Users\$env:USERNAME\Desktop\normless_crm"
    
    Write-Host "=== NORMLESS CRM DEPLOYMENT ===" -ForegroundColor Cyan
    
    Write-Host "1. Building React..." -ForegroundColor Yellow
    Set-Location "$projectPath\client"
    npm run build | Out-Null
    Set-Location $projectPath
    
    Write-Host "2. Building backend..." -ForegroundColor Yellow
    npm run build 2>$null
    
    Write-Host "3. Uploading files..." -ForegroundColor Yellow
    scp -r server $server`:~/app/ 2>$null
    scp -r client\dist $server`:~/app/ 2>$null
    scp package*.json $server`:~/app/ 2>$null
    
    Write-Host "4. Installing dependencies..." -ForegroundColor Yellow
    ssh $server "cd ~/app && npm install --production" 2>$null
    
    Write-Host "5. Starting application..." -ForegroundColor Yellow
    ssh $server "cd ~/app && pm2 restart normless-crm || pm2 start server/index.js --name normless-crm" 2>$null
    
    Write-Host "`n✅ DEPLOYMENT COMPLETE!" -ForegroundColor Green
    Write-Host "Visit: https://app.normless.store" -ForegroundColor Cyan
    
    Write-Host "`nStatus:" -ForegroundColor Yellow
    ssh $server "pm2 status"
}

# Run it
Deploy-Complete
```

**Use it:**
```powershell
./deploy-complete.ps1
```

---

## Summary: Windows Deployment Methods

| Method | Ease | Speed | Features |
|--------|------|-------|----------|
| **WinSCP GUI** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | Visual, drag-drop |
| **PowerShell SSH** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Commands, scripting |
| **PowerShell SCP** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Fast uploads |
| **Deploy Scripts** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Automated, powerful |

---

## Your Best Workflow

```
1. Use WinSCP for initial file upload (visual & easy)
2. Use PowerShell for commands (fast & scriptable)
3. Use deploy script for automated updates
```

---

**Now you have complete Windows PowerShell + WinSCP deployment! 🎉**

Would you like me to help with any specific part?
