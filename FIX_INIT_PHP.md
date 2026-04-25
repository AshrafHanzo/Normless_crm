# 🔧 FIX: MOVE init.php TO API FOLDER

## Why 404?

The `.htaccess` file routes all requests to React (`index.html`)
So PHP files in `public_html/` can't be accessed
Solution: Put init.php in `public_html/api/` instead

---

## STEP 1: Delete init.php from public_html/

In ServerByt File Manager:

1. Go to: `public_html/`
2. Find: `init.php`
3. Right-click: `init.php`
4. Click: **Delete**

✅ Done

---

## STEP 2: Upload init.php to public_html/api/

In ServerByt File Manager:

1. Go to: `public_html/api/`
2. Drag & drop: `init.php` file from your computer
   (Or click Upload button)

Location: `c:/Users/abcom/Desktop/Personal/normless_crm/public_html/init.php`

✅ Done

---

## STEP 3: Visit init.php via API URL

Open browser and visit:

```
https://app.normless.store/api/init.php
```

**Note:** It's in the `/api/` folder now!

---

## STEP 4: Handle SSL Warning (if appears)

If you see SSL warning again:

1. Click: **Advanced**
2. Click: **Proceed** (or similar button)

---

## STEP 5: See Success Message

You should see:

```
🔧 Normless CRM - Database Initialization
✅ SUCCESS! Database initialized!

crm.db has been created with all tables.

You can now:
1. Delete this file (init.php)
2. Go to: https://app.normless.store
3. Login with:
   - Email: [YOUR_ADMIN_EMAIL]
   - Password: [REDACTED_PASSWORD]
```

✅ **DATABASE CREATED!**

---

## STEP 6: Delete init.php (Security!)

After you see the success message:

1. In ServerByt File Manager
2. Go to: `public_html/api/`
3. Right-click: `init.php`
4. Click: **Delete**

✅ Done - init.php removed for security

---

## STEP 7: Try to Login

Visit: `https://app.normless.store`

You should see:
- React login page
- Normless branding
- Login form

Login with:
- Email: `[YOUR_ADMIN_EMAIL]`
- Password: `[REDACTED_PASSWORD]`

---

## ✅ IF THIS WORKS:

- ✅ crm.db created
- ✅ Database initialized
- ✅ You can login
- ✅ Ready for Cron Job setup

---

**Do this now!** 👆

Let me know when you see the success message! 🎉
