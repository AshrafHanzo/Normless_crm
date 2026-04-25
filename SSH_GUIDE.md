# 🚀 SSH CONNECTION - COMPLETE GUIDE

Good news! You successfully connected to SSH! 

The connection closed because we need to run commands. Let me show you exactly what to do:

---

## STEP 1: Connect to SSH (Keep it open this time)

In Windows PowerShell, run:

```bash
ssh -i "$env:USERPROFILE\.ssh\id_rsa" normless.store@ssh.gb.stackcp.com
```

Wait for the welcome message, then you'll see: `PS C:\Users\abcom>`

---

## STEP 2: After SSH Connects - Run These Commands

**⚠️ IMPORTANT: Copy & Paste ONE AT A TIME and wait for each to complete!**

### Command 1: Navigate to API folder
```bash
cd public_html/api
```

Then press: **Enter**

You should see: `normless.store@ssh:~/public_html/api$`

---

### Command 2: Install Composer packages
```bash
composer install --no-dev
```

Then press: **Enter**

Wait for it to complete. You'll see many lines of output, then:
```
✓ installed
```

This takes 1-2 minutes. **WAIT FOR IT TO FINISH!**

---

### Command 3: Initialize Database (CREATES crm.db)
```bash
php -r "require 'vendor/autoload.php'; use App\Config\Env; use App\Db\Init; Env::load(); Init::run();"
```

Then press: **Enter**

Wait for output like:
```
✓ Database initialized
✓ Tables created
```

---

### Command 4: Verify crm.db was created
```bash
ls -la crm.db
```

Then press: **Enter**

You should see:
```
-rw-r--r-- 1 user user 24576 Apr 20 19:30 crm.db
```

If you see this, **IT WORKED!** ✅

---

## STEP 3: Set crm.db Permissions to 666

Still in SSH, run:

```bash
chmod 666 crm.db
```

Then press: **Enter**

---

## STEP 4: Verify permissions are correct

```bash
ls -la crm.db
```

Should show: `-rw-rw-rw-` (meaning 666) ✅

---

## STEP 5: Exit SSH

Type:
```bash
exit
```

Then press: **Enter**

---

## ✅ WHAT YOU'VE ACCOMPLISHED

- ✅ Composer packages installed
- ✅ crm.db database created
- ✅ Database tables created  
- ✅ Permissions set to 666
- ✅ Ready for next step!

---

## 📌 COPY-PASTE READY (All commands together)

If you want to run them all at once, you can do:

```bash
cd public_html/api && composer install --no-dev && php -r "require 'vendor/autoload.php'; use App\Config\Env; use App\Db\Init; Env::load(); Init::run();" && chmod 666 crm.db && ls -la crm.db
```

But **ONE AT A TIME is safer!**

---

## 🆘 IF SOMETHING GOES WRONG

### Composer says "command not found"?
Try:
```bash
/usr/local/bin/composer install --no-dev
```

### PHP says "file not found"?
Make sure you're in the right folder:
```bash
pwd
```

Should show: `/home/sites/3b/7/7b3d2b2433/public_html/api`

### Still stuck?
Just tell me what error message you see!

---

**Ready? Start the SSH connection now!** 👆

Open Windows PowerShell and run:
```bash
ssh -i "$env:USERPROFILE\.ssh\id_rsa" normless.store@ssh.gb.stackcp.com
```
