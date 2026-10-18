/**
 * WhatsApp settings: the menu, templates, catalogue, team, assignment and lead statuses.
 *
 * Mounted under /api/whatsapp/admin behind the manager check in whatsapp.js, so every route here
 * already knows the caller can run the inbox. Two things need more than that: giving somebody a
 * login, and changing who is a manager. Those are account changes, so they stay with the roles
 * that make them on the Admin page — admin and owner.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/connection');
const wa = require('../services/whatsapp');
const routing = require('../services/wa-routing');

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const extras = require('../services/wa-extras');

const router = express.Router();

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
const safeJson = (v, fallback) => {
    try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); }
    catch { return fallback; }
};
const isAdmin = (req) => req.user?.role === 'admin' || req.user?.role === 'owner';
const HEX = /^#[0-9a-f]{6}$/i;

async function putSetting(key, value, who) {
    await db.query(
        `INSERT INTO wa_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
             updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [key, value, who || null]);
}

async function getSettings() {
    const r = await db.query('SELECT key, value FROM wa_settings');
    return Object.fromEntries(r.rows.map(x => [x.key, x.value]));
}

/* ── Lead statuses ───────────────────────────────────────────────────────────────────────────
   Saved as a whole list, in order, because that is how the page edits them: reorder, rename,
   recolour, add, remove, then save once. A removed status has its leads moved to the default
   rather than left pointing at nothing. */

router.get('/statuses', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT s.key, s.name, s.color, s.description, s.stage, s.sort_order, s.is_default,
                    (SELECT COUNT(*)::int FROM crewfit_leads l WHERE l.status = s.key) AS leads
               FROM wa_lead_statuses s ORDER BY s.sort_order, s.name`);
        res.json({ statuses: r.rows });
    } catch (err) {
        console.error('whatsapp settings statuses error:', err);
        res.status(500).json({ error: 'Could not load the statuses' });
    }
});

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

router.put('/statuses', async (req, res) => {
    try {
        const list = Array.isArray(req.body?.statuses) ? req.body.statuses : null;
        if (!list || !list.length) return res.status(400).json({ error: 'Keep at least one status' });
        if (list.length > 20) return res.status(400).json({ error: 'Twenty statuses is the most the inbox can show' });

        const seenKeys = new Set();
        const seenNames = new Set();
        const clean = [];
        for (const s of list) {
            const name = trim(s?.name);
            if (!name) return res.status(400).json({ error: 'Every status needs a name' });
            if (name.length > 30) return res.status(400).json({ error: `"${name}" is longer than 30 characters` });
            if (seenNames.has(name.toLowerCase())) return res.status(400).json({ error: `There are two statuses called "${name}"` });
            seenNames.add(name.toLowerCase());
            let key = trim(s?.key) || slug(name) || 'status';
            while (seenKeys.has(key)) key = `${key}_2`;
            seenKeys.add(key);
            clean.push({
                key, name,
                color: HEX.test(s?.color || '') ? s.color : '#60a5fa',
                description: trim(s?.description),
                stage: ['open', 'won', 'lost'].includes(s?.stage) ? s.stage : 'open',
                is_default: !!s?.is_default,
            });
        }
        if (clean.filter(s => s.is_default).length !== 1) {
            return res.status(400).json({ error: 'Pick exactly one status for new chats' });
        }
        const fallback = clean.find(s => s.is_default).key;

        await db.transaction(async (c) => {
            const keys = clean.map(s => s.key);
            await c.query(`UPDATE crewfit_leads SET status = $1 WHERE NOT (status = ANY($2::text[]))`, [fallback, keys]);
            await c.query(`DELETE FROM wa_lead_statuses WHERE NOT (key = ANY($1::text[]))`, [keys]);
            for (const [i, s] of clean.entries()) {
                await c.query(
                    `INSERT INTO wa_lead_statuses (key, name, color, description, stage, is_default, sort_order)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color,
                         description = EXCLUDED.description, stage = EXCLUDED.stage,
                         is_default = EXCLUDED.is_default, sort_order = EXCLUDED.sort_order`,
                    [s.key, s.name, s.color, s.description, s.stage, s.is_default, i]);
            }
            // Rules pointing at a status that is gone would never match again.
            await c.query(`DELETE FROM wa_assign_rules WHERE field = 'lead_status' AND NOT (value = ANY($1::text[]))`, [keys]);
        });
        const r = await db.query(
            `SELECT s.key, s.name, s.color, s.description, s.stage, s.sort_order, s.is_default,
                    (SELECT COUNT(*)::int FROM crewfit_leads l WHERE l.status = s.key) AS leads
               FROM wa_lead_statuses s ORDER BY s.sort_order, s.name`);
        res.json({ statuses: r.rows });
    } catch (err) {
        console.error('whatsapp settings statuses save error:', err);
        res.status(500).json({ error: 'Could not save the statuses' });
    }
});

/* ── Team ────────────────────────────────────────────────────────────────────────────────────── */

async function teamPayload() {
    const members = await db.query(
        `SELECT u.id, u.username, u.role, u.last_login,
                COALESCE(u.is_sales_agent, false) AS is_sales_agent,
                u.wa_max_open,
                (u.role IN ('owner','admin') OR COALESCE(u.can_manage_whatsapp, false)) AS is_manager,
                (SELECT COUNT(*)::int FROM wa_conversations v
                  WHERE LOWER(v.assigned_to) = LOWER(u.username) AND v.status = 'open') AS open_chats,
                COALESCE((SELECT ARRAY_AGG(t.team_id ORDER BY t.team_id) FROM wa_team_members t
                           WHERE LOWER(t.username) = LOWER(u.username)), '{}') AS team_ids
           FROM admin_users u
          WHERE COALESCE(u.is_active, true) = true
            AND (u.role IN ('owner','admin') OR COALESCE(u.can_view_whatsapp, false) = true)
          ORDER BY LOWER(u.username)`);
    const teams = await db.query(
        `SELECT t.id, t.name,
                COALESCE((SELECT ARRAY_AGG(m.username ORDER BY LOWER(m.username)) FROM wa_team_members m
                           WHERE m.team_id = t.id), '{}') AS members
           FROM wa_teams t ORDER BY LOWER(t.name)`);
    // People who could be given the inbox: active, not already in it.
    const others = await db.query(
        `SELECT username FROM admin_users
          WHERE COALESCE(is_active, true) = true AND role NOT IN ('owner','admin')
            AND COALESCE(can_view_whatsapp, false) = false
          ORDER BY LOWER(username)`);
    return { members: members.rows, teams: teams.rows, others: others.rows.map(r => r.username) };
}

router.get('/team', async (req, res) => {
    try {
        res.json({ ...await teamPayload(), canGrant: isAdmin(req) });
    } catch (err) {
        console.error('whatsapp team error:', err);
        res.status(500).json({ error: 'Could not load the team' });
    }
});

async function setTeams(c, username, teamIds) {
    await c.query('DELETE FROM wa_team_members WHERE LOWER(username) = LOWER($1)', [username]);
    for (const id of teamIds) {
        await c.query(
            `INSERT INTO wa_team_members (team_id, username) SELECT id, $2 FROM wa_teams WHERE id = $1
             ON CONFLICT DO NOTHING`, [id, username]);
    }
}

const cap = (v) => {
    if (v === '' || v == null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : undefined;
};

/**
 * Add somebody to the inbox: an existing CRM login, or a new one made here.
 * Either way it is an account change, so it needs an admin.
 */
router.post('/team/members', async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can give somebody access' });
        const b = req.body || {};
        const username = trim(b.username);
        if (!username) return res.status(400).json({ error: 'Who should be added?' });
        const maxOpen = cap(b.wa_max_open);
        if (maxOpen === undefined) return res.status(400).json({ error: 'The chat limit has to be a whole number' });
        const teamIds = Array.isArray(b.team_ids) ? b.team_ids.map(Number).filter(Boolean) : [];

        await db.transaction(async (c) => {
            const existing = (await c.query(
                'SELECT id, role FROM admin_users WHERE LOWER(username) = LOWER($1)', [username])).rows[0];
            if (b.create) {
                if (existing) throw Object.assign(new Error('There is already a login with that email'), { status: 400 });
                const password = String(b.password || '');
                if (password.length < 8) throw Object.assign(new Error('The password needs at least 8 characters'), { status: 400 });
                const hash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));
                // A Crewfit login that can open the inbox, and nothing else until the Admin page
                // says otherwise.
                await c.query(
                    `INSERT INTO admin_users (username, password_hash, role, is_active, can_access_crewfit,
                                              can_view_whatsapp, can_manage_whatsapp, is_sales_agent, wa_max_open)
                     VALUES ($1,$2,'operator',true,true,true,$3,$4,$5)`,
                    [username, hash, !!b.is_manager, !!b.is_sales_agent, maxOpen]);
            } else {
                if (!existing) throw Object.assign(new Error('No CRM login with that email'), { status: 404 });
                await c.query(
                    `UPDATE admin_users SET can_access_crewfit = true, can_view_whatsapp = true,
                            can_manage_whatsapp = $2, is_sales_agent = $3, wa_max_open = $4
                      WHERE id = $1`,
                    [existing.id, !!b.is_manager, !!b.is_sales_agent, maxOpen]);
            }
            await setTeams(c, username, teamIds);
        });
        res.status(201).json(await teamPayload());
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error('whatsapp team add error:', err);
        res.status(500).json({ error: 'Could not add that person' });
    }
});

/** Their place on the rota, their limit, their teams — and, for an admin, whether they manage. */
router.patch('/team/members/:id', async (req, res) => {
    try {
        const b = req.body || {};
        const user = (await db.query('SELECT id, username, role FROM admin_users WHERE id = $1', [req.params.id])).rows[0];
        if (!user) return res.status(404).json({ error: 'That person is gone' });

        const sets = [];
        const params = [user.id];
        if ('is_sales_agent' in b) { params.push(!!b.is_sales_agent); sets.push(`is_sales_agent = $${params.length}`); }
        if ('wa_max_open' in b) {
            const v = cap(b.wa_max_open);
            if (v === undefined) return res.status(400).json({ error: 'The chat limit has to be a whole number' });
            params.push(v); sets.push(`wa_max_open = $${params.length}`);
        }
        if ('is_manager' in b) {
            if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can change who manages the inbox' });
            if (user.role === 'owner' || user.role === 'admin') {
                return res.status(400).json({ error: 'Admins and owners always manage the inbox' });
            }
            params.push(!!b.is_manager); sets.push(`can_manage_whatsapp = $${params.length}`);
        }
        await db.transaction(async (c) => {
            if (sets.length) await c.query(`UPDATE admin_users SET ${sets.join(', ')} WHERE id = $1`, params);
            if (Array.isArray(b.team_ids)) await setTeams(c, user.username, b.team_ids.map(Number).filter(Boolean));
        });
        res.json(await teamPayload());
    } catch (err) {
        console.error('whatsapp team update error:', err);
        res.status(500).json({ error: 'Could not change that' });
    }
});

/** Take somebody out of the inbox. Their open chats go back to Unassigned. */
router.delete('/team/members/:id', async (req, res) => {
    try {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can remove access' });
        const user = (await db.query('SELECT id, username, role FROM admin_users WHERE id = $1', [req.params.id])).rows[0];
        if (!user) return res.status(404).json({ error: 'That person is gone' });
        if (user.role === 'owner' || user.role === 'admin') {
            return res.status(400).json({ error: 'Admins and owners always have the inbox' });
        }
        await db.transaction(async (c) => {
            await c.query(
                `UPDATE admin_users SET can_view_whatsapp = false, can_manage_whatsapp = false, is_sales_agent = false
                  WHERE id = $1`, [user.id]);
            await c.query('DELETE FROM wa_team_members WHERE LOWER(username) = LOWER($1)', [user.username]);
            await c.query(
                `UPDATE wa_conversations SET assigned_to = NULL, updated_at = CURRENT_TIMESTAMP
                  WHERE LOWER(assigned_to) = LOWER($1) AND status = 'open'`, [user.username]);
        });
        res.json(await teamPayload());
    } catch (err) {
        console.error('whatsapp team remove error:', err);
        res.status(500).json({ error: 'Could not remove that person' });
    }
});

router.post('/teams', async (req, res) => {
    try {
        const name = trim(req.body?.name);
        if (!name) return res.status(400).json({ error: 'A team needs a name' });
        await db.query('INSERT INTO wa_teams (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name.slice(0, 40)]);
        res.status(201).json(await teamPayload());
    } catch (err) {
        console.error('whatsapp team create error:', err);
        res.status(500).json({ error: 'Could not make that team' });
    }
});

router.patch('/teams/:id', async (req, res) => {
    try {
        const name = trim(req.body?.name);
        if (!name) return res.status(400).json({ error: 'A team needs a name' });
        await db.query('UPDATE wa_teams SET name = $2 WHERE id = $1', [req.params.id, name.slice(0, 40)]);
        res.json(await teamPayload());
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'There is already a team with that name' });
        console.error('whatsapp team rename error:', err);
        res.status(500).json({ error: 'Could not rename that team' });
    }
});

router.delete('/teams/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM wa_teams WHERE id = $1', [req.params.id]);
        await db.query(`DELETE FROM wa_settings WHERE key = 'fallback_team_id' AND value = $1`, [String(req.params.id)]);
        res.json(await teamPayload());
    } catch (err) {
        console.error('whatsapp team delete error:', err);
        res.status(500).json({ error: 'Could not remove that team' });
    }
});

/* ── Assignment ──────────────────────────────────────────────────────────────────────────────── */

async function assignmentPayload() {
    const settings = await getSettings();
    const rules = await db.query(
        `SELECT id, field, value, team_id, is_active, sort_order FROM wa_assign_rules ORDER BY sort_order, id`);
    return {
        mode: await routing.mode(),
        fallback_team_id: settings.fallback_team_id ? Number(settings.fallback_team_id) : null,
        rules: rules.rows,
    };
}

router.get('/assignment', async (req, res) => {
    try { res.json(await assignmentPayload()); }
    catch (err) {
        console.error('whatsapp assignment error:', err);
        res.status(500).json({ error: 'Could not load the assignment rules' });
    }
});

router.put('/assignment', async (req, res) => {
    try {
        const b = req.body || {};
        if ('mode' in b && !routing.MODES.includes(b.mode)) return res.status(400).json({ error: 'Unknown way of assigning' });
        let rules = null;
        if (Array.isArray(b.rules)) {
            if (b.rules.length > 50) return res.status(400).json({ error: 'Fifty rules is the most this keeps' });
            rules = [];
            for (const r of b.rules) {
                const value = trim(r?.value);
                const teamId = Number(r?.team_id) || null;
                if (!routing.RULE_FIELDS.includes(r?.field)) return res.status(400).json({ error: 'A rule has an unknown condition' });
                if (!value) return res.status(400).json({ error: 'Every rule needs a value to match' });
                if (!teamId) return res.status(400).json({ error: 'Every rule needs a team to send to' });
                rules.push({ field: r.field, value, team_id: teamId, is_active: r.is_active !== false });
            }
        }
        await db.transaction(async (c) => {
            if (rules) {
                await c.query('DELETE FROM wa_assign_rules');
                for (const [i, r] of rules.entries()) {
                    await c.query(
                        `INSERT INTO wa_assign_rules (field, value, team_id, is_active, sort_order)
                         SELECT $1,$2,id,$4,$5 FROM wa_teams WHERE id = $3`,
                        [r.field, r.value, r.team_id, r.is_active, i]);
                }
            }
        });
        if ('mode' in b) await putSetting('assign_mode', b.mode, req.user?.username);
        if ('fallback_team_id' in b) await putSetting('fallback_team_id', b.fallback_team_id ? String(Number(b.fallback_team_id)) : null, req.user?.username);
        res.json(await assignmentPayload());
    } catch (err) {
        console.error('whatsapp assignment save error:', err);
        res.status(500).json({ error: 'Could not save the assignment rules' });
    }
});

/* ── Templates ───────────────────────────────────────────────────────────────────────────────
   Every template on the account, not just the approved ones, so a manager can see what is still
   waiting on Meta and what was turned down. */

const VAR_SOURCES = ['first_name', 'name', 'company', 'product', 'quantity', 'quoted_amount', 'balance_due', 'needed_by', 'agent_name',
    'order_ref', 'order_total', 'advance_amount', 'balance_amount', 'payment_link', 'tracking_id', 'tracking_url',
    'courier', 'due_amount', 'document_link'];

router.get('/templates', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, name, language, category, status, body_text, variables, header_kind, var_map, synced_at
               FROM wa_templates ORDER BY LOWER(name), language`);
        res.json({
            templates: r.rows.map(t => ({ ...t, var_map: safeJson(t.var_map, []) })),
            canCreate: !!process.env.WA_BUSINESS_ACCOUNT_ID && wa.configured(),
        });
    } catch (err) {
        console.error('whatsapp settings templates error:', err);
        res.status(500).json({ error: 'Could not load the templates' });
    }
});

/** What fills each gap when a rep picks this template. */
router.put('/templates/:id', async (req, res) => {
    try {
        const map = Array.isArray(req.body?.var_map) ? req.body.var_map.map(v => (VAR_SOURCES.includes(v) ? v : '')) : null;
        if (!map) return res.status(400).json({ error: 'Nothing to change' });
        const r = await db.query(
            `UPDATE wa_templates SET var_map = $2 WHERE id = $1
             RETURNING id, name, language, category, status, body_text, variables, header_kind, var_map, synced_at`,
            [req.params.id, JSON.stringify(map)]);
        if (!r.rows[0]) return res.status(404).json({ error: 'That template is gone — sync again' });
        res.json({ template: { ...r.rows[0], var_map: safeJson(r.rows[0].var_map, []) } });
    } catch (err) {
        console.error('whatsapp template map error:', err);
        res.status(500).json({ error: 'Could not save that' });
    }
});

/** Write a new one and send it to Meta for approval. */
router.post('/templates', async (req, res) => {
    try {
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
        const b = req.body || {};
        const name = trim(b.name);
        const body = trim(b.body);
        const language = trim(b.language) || 'en';
        const category = ['UTILITY', 'MARKETING'].includes(b.category) ? b.category : 'UTILITY';
        if (!name || !/^[a-z0-9_]{1,512}$/.test(name)) {
            return res.status(400).json({ error: 'Names are lower case letters, numbers and underscores only' });
        }
        if (!body) return res.status(400).json({ error: 'The template has nothing to say' });
        if (body.length > 1024) return res.status(400).json({ error: 'WhatsApp allows 1,024 characters in a template' });

        const nums = [...new Set((body.match(/\{\{\s*(\d+)\s*\}\}/g) || []).map(m => Number(m.replace(/\D/g, ''))))].sort((a, b) => a - b);
        if (nums.some((n, i) => n !== i + 1)) return res.status(400).json({ error: 'Number the gaps {{1}}, {{2}} … in order, with none skipped' });
        const examples = Array.isArray(b.examples) ? b.examples.map(v => String(v ?? '').trim()) : [];
        if (examples.slice(0, nums.length).filter(Boolean).length < nums.length) {
            return res.status(400).json({ error: 'Meta needs an example for every gap before it will review the template' });
        }
        const buttons = (Array.isArray(b.buttons) ? b.buttons : []).map(t => String(t || '').trim()).filter(Boolean);
        if (buttons.length > 3) return res.status(400).json({ error: 'Three buttons at most' });
        if (buttons.some(t => t.length > 25)) return res.status(400).json({ error: 'Template buttons are 25 characters at most' });
        const map = Array.isArray(b.var_map) ? b.var_map.map(v => (VAR_SOURCES.includes(v) ? v : '')) : [];

        let created;
        try {
            created = await wa.createTemplate({ name, language, category, body, examples: examples.slice(0, nums.length), buttons });
        } catch (err) {
            if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
            throw err;
        }
        const r = await db.query(
            `INSERT INTO wa_templates (name, language, category, status, body_text, variables, var_map, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)
             ON CONFLICT (name, language) DO UPDATE SET category = EXCLUDED.category, status = EXCLUDED.status,
                 body_text = EXCLUDED.body_text, variables = EXCLUDED.variables, var_map = EXCLUDED.var_map,
                 synced_at = CURRENT_TIMESTAMP
             RETURNING id, name, language, category, status, body_text, variables, header_kind, var_map, synced_at`,
            [name, language, category, created.status || 'PENDING', body, nums.length, JSON.stringify(map)]);
        res.status(201).json({ template: { ...r.rows[0], var_map: safeJson(r.rows[0].var_map, []) } });
    } catch (err) {
        console.error('whatsapp template create error:', err);
        res.status(500).json({ error: 'Could not send that template to Meta' });
    }
});

/* ── Catalogue ───────────────────────────────────────────────────────────────────────────────
   The Crewfit catalog, with one switch per product: whether a rep can send it from a chat.
   Prices and descriptions stay on the Catalog page, the one place they are edited. */

router.get('/catalogue', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, name, category, fit, gsm, material, from_price, tiers, image_url,
                    COALESCE(active, true) AS active, COALESCE(wa_visible, true) AS wa_visible
               FROM crewfit_products ORDER BY sort_order, name`);
        const pdf = await extras.currentCatalogue();
        res.json({
            products: r.rows.map(p => ({ ...p, tiers: safeJson(p.tiers, []) })),
            catalogue: pdf ? { filename: pdf.filename, version: pdf.version, title: pdf.title } : null,
        });
    } catch (err) {
        console.error('whatsapp settings catalogue error:', err);
        res.status(500).json({ error: 'Could not load the catalogue' });
    }
});

router.patch('/catalogue/:id', async (req, res) => {
    try {
        const r = await db.query(
            `UPDATE crewfit_products SET wa_visible = $2 WHERE id = $1 RETURNING id, COALESCE(wa_visible, true) AS wa_visible`,
            [req.params.id, !!req.body?.wa_visible]);
        if (!r.rows[0]) return res.status(404).json({ error: 'That product is gone' });
        res.json({ product: r.rows[0] });
    } catch (err) {
        console.error('whatsapp catalogue toggle error:', err);
        res.status(500).json({ error: 'Could not change that' });
    }
});

/* ── Product photos ──────────────────────────────────────────────────────────────────────────
   One photo per product, sent with its details when a rep shares it. Replacing it deletes the old
   file: nothing else points at it. */

const PRODUCT_DIR = path.join(__dirname, '..', 'uploads', 'crewfit', 'products');
const photoUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { fs.mkdirSync(PRODUCT_DIR, { recursive: true }); cb(null, PRODUCT_DIR); },
        filename: (req, file, cb) => {
            const ext = (path.extname(file.originalname || '').toLowerCase().match(/^\.(jpe?g|png|webp)$/) || ['.jpg'])[0];
            cb(null, `${req.params.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (/^image\/(jpeg|png|webp)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Use a JPG, PNG or WebP photo'))),
});

const removePhoto = (url) => {
    if (!url) return;
    const file = path.join(PRODUCT_DIR, path.basename(url));
    fs.promises.unlink(file).catch(() => {});
};

router.post('/catalogue/:id/photo', (req, res, next) => photoUpload.single('photo')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photos must be under 5MB' : err.message });
}), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Choose a photo' });
        const old = (await db.query('SELECT image_url FROM crewfit_products WHERE id = $1', [req.params.id])).rows[0];
        if (!old) { removePhoto(req.file.filename); return res.status(404).json({ error: 'That product is gone' }); }
        const url = `/uploads/crewfit/products/${req.file.filename}`;
        await db.query('UPDATE crewfit_products SET image_url = $2 WHERE id = $1', [req.params.id, url]);
        removePhoto(old.image_url);
        res.json({ image_url: url });
    } catch (err) {
        console.error('whatsapp product photo error:', err);
        res.status(500).json({ error: 'Could not save that photo' });
    }
});

router.delete('/catalogue/:id/photo', async (req, res) => {
    try {
        const old = (await db.query('SELECT image_url FROM crewfit_products WHERE id = $1', [req.params.id])).rows[0];
        await db.query('UPDATE crewfit_products SET image_url = NULL WHERE id = $1', [req.params.id]);
        removePhoto(old?.image_url);
        res.json({ image_url: null });
    } catch (err) {
        console.error('whatsapp product photo delete error:', err);
        res.status(500).json({ error: 'Could not remove that photo' });
    }
});

/* ── Working hours ───────────────────────────────────────────────────────────────────────────── */

router.get('/work-hours', async (req, res) => {
    try {
        const hours = await extras.workHours();
        res.json({ hours, preview: extras.awayText(hours), open: extras.isOpen(hours) });
    } catch (err) {
        console.error('whatsapp work hours error:', err);
        res.status(500).json({ error: 'Could not load the working hours' });
    }
});

router.put('/work-hours', async (req, res) => {
    try {
        const b = req.body || {};
        const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
        const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter(d => d >= 0 && d <= 6))] : null;
        if (!days) return res.status(400).json({ error: 'Pick the working days' });
        if (!HHMM.test(b.start || '') || !HHMM.test(b.end || '')) return res.status(400).json({ error: 'Times look like 09:30' });
        if (b.start >= b.end) return res.status(400).json({ error: 'The day has to end after it starts' });
        const message = trim(b.message);
        if (!message) return res.status(400).json({ error: 'Write the message customers get outside these hours' });
        if (message.length > 1000) return res.status(400).json({ error: 'Keep the message under 1,000 characters' });
        const hours = { enabled: !!b.enabled, days, start: b.start, end: b.end, message, menuAfterHours: b.menuAfterHours !== false };
        await putSetting('work_hours', JSON.stringify(hours), req.user?.username);
        res.json({ hours, preview: extras.awayText(hours), open: extras.isOpen(hours) });
    } catch (err) {
        console.error('whatsapp work hours save error:', err);
        res.status(500).json({ error: 'Could not save the working hours' });
    }
});

/* ── Payment QR and the billing-details request ───────────────────────────────────────────── */

const QR_DIR = path.join(__dirname, '..', 'uploads', 'whatsapp');
const qrUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { fs.mkdirSync(QR_DIR, { recursive: true }); cb(null, QR_DIR); },
        filename: (req, file, cb) => {
            const ext = (path.extname(file.originalname || '').toLowerCase().match(/^\.(jpe?g|png|webp)$/) || ['.jpg'])[0];
            cb(null, `payment-qr-${Date.now()}${ext}`);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (/^image\/(jpeg|png|webp)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Use a JPG or PNG of the QR'))),
});

router.get('/payments', async (req, res) => {
    try {
        const s = await getSettings();
        res.json({ qr: s.payment_qr || null, billingRequest: s.billing_request || billingSvc().DEFAULT_REQUEST, billingDefault: billingSvc().DEFAULT_REQUEST });
    } catch (err) {
        console.error('whatsapp payments settings error:', err);
        res.status(500).json({ error: 'Could not load that' });
    }
});

router.post('/payments/qr', (req, res, next) => qrUpload.single('qr')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The QR image must be under 5MB' : err.message });
}), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Choose the QR image' });
        const old = (await getSettings()).payment_qr;
        const url = `/uploads/whatsapp/${req.file.filename}`;
        await putSetting('payment_qr', url, req.user?.username);
        if (old && old !== url) fs.promises.unlink(path.join(QR_DIR, path.basename(old))).catch(() => {});
        res.json({ qr: url });
    } catch (err) {
        console.error('whatsapp qr upload error:', err);
        res.status(500).json({ error: 'Could not save the QR' });
    }
});

router.put('/payments/billing-request', async (req, res) => {
    try {
        const text = trim(req.body?.text);
        if (!text) return res.status(400).json({ error: 'The message is empty' });
        await putSetting('billing_request', text.slice(0, 4000), req.user?.username);
        res.json({ billingRequest: text });
    } catch (err) {
        console.error('whatsapp billing request save error:', err);
        res.status(500).json({ error: 'Could not save that' });
    }
});

const billingSvc = () => require('../services/wa-billing');

/** Send all the Crewfit order templates to Meta for approval and link each to its message. */
router.post('/order-messages/templates', async (req, res) => {
    try {
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
        const results = await require('../services/wa-orders').submitTemplates(req.user?.username);
        res.json({ results });
    } catch (err) {
        console.error('whatsapp template submit error:', err);
        res.status(500).json({ error: 'Could not submit the templates' });
    }
});

/* ── Order messages ──────────────────────────────────────────────────────────────────────────
   Which order messages go out on their own, and the template each falls back on once the chat
   is past WhatsApp's 24-hour window. */

router.get('/order-messages', async (req, res) => {
    try {
        const { MESSAGES } = require('../services/wa-orders');
        const s = await getSettings();
        // Pending ones too: a template just submitted is linked at once and works once approved.
        const templates = await db.query(
            `SELECT id, name, language, variables, status FROM wa_templates WHERE status IN ('APPROVED','PENDING','IN_APPEAL') ORDER BY LOWER(name)`);
        res.json({
            messages: Object.entries(MESSAGES).map(([key, m]) => ({
                key, label: m.label, trigger: m.auto || null,
                auto: (s[`auto_${key}`] ?? (m.autoDefault ? 'true' : 'false')) === 'true',
                template_id: s[`order_tpl_${key}`] ? Number(s[`order_tpl_${key}`]) : null,
            })),
            templates: templates.rows,
        });
    } catch (err) {
        console.error('whatsapp order messages error:', err);
        res.status(500).json({ error: 'Could not load the order messages' });
    }
});

router.put('/order-messages/:key', async (req, res) => {
    try {
        const { MESSAGES } = require('../services/wa-orders');
        const m = MESSAGES[req.params.key];
        if (!m) return res.status(404).json({ error: 'No such message' });
        const b = req.body || {};
        if ('auto' in b) {
            if (b.auto && !m.auto) return res.status(400).json({ error: 'This message is only sent by hand' });
            await putSetting(`auto_${req.params.key}`, b.auto ? 'true' : 'false', req.user?.username);
        }
        if ('template_id' in b) {
            const id = b.template_id ? Number(b.template_id) : null;
            if (id && !(await db.query(`SELECT 1 FROM wa_templates WHERE id = $1 AND status IN ('APPROVED','PENDING','IN_APPEAL')`, [id])).rows[0]) {
                return res.status(400).json({ error: 'That template was rejected or removed at Meta' });
            }
            await putSetting(`order_tpl_${req.params.key}`, id ? String(id) : null, req.user?.username);
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('whatsapp order message save error:', err);
        res.status(500).json({ error: 'Could not save that' });
    }
});

/* ── Menu triggers ───────────────────────────────────────────────────────────────────────────
   The menu itself is saved through PUT /flows/:key; this is only when it is sent. */

router.get('/menu', async (req, res) => {
    try {
        const s = await getSettings();
        res.json({ keywords: s.menu_keywords ?? 'menu' });
    } catch (err) {
        console.error('whatsapp menu settings error:', err);
        res.status(500).json({ error: 'Could not load that' });
    }
});

router.put('/menu', async (req, res) => {
    try {
        const words = String(req.body?.keywords ?? '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean).slice(0, 20);
        await putSetting('menu_keywords', words.join(', '), req.user?.username);
        res.json({ keywords: words.join(', ') });
    } catch (err) {
        console.error('whatsapp menu settings save error:', err);
        res.status(500).json({ error: 'Could not save that' });
    }
});

module.exports = router;
