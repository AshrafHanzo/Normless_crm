/**
 * The Team section's tables: people and payroll, leave, claims, and the task boards. Shared by
 * Normless and Crewfit — each row that belongs to one company says so in `company`
 * ('normless' | 'crewfit' | 'both'), so one list serves both menus.
 */

const db = require('../db/connection');

async function ensureTeamSchema() {
    try {
        await db.exec(`
            -- Tasks are for everyone with a login, so on by default. Running boards and payroll
            -- are grants of their own.
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_tasks BOOLEAN DEFAULT true;
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_manage_boards BOOLEAN DEFAULT false;
            -- Salaries, bank details and every payslip: off unless granted.
            ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS can_view_payroll BOOLEAN DEFAULT false;

            -- Everyone on the payroll, with or without a CRM login (username links the two).
            CREATE TABLE IF NOT EXISTS team_employees (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                emp_code TEXT,
                name TEXT NOT NULL,
                phone TEXT,
                email TEXT,
                username TEXT,
                company TEXT NOT NULL DEFAULT 'normless',
                department TEXT,
                designation TEXT,
                -- Who approves their leave and claims first. A CRM username.
                manager_username TEXT,
                joined_on DATE,
                left_on DATE,
                status TEXT NOT NULL DEFAULT 'active',      -- active | notice | left
                monthly_salary NUMERIC NOT NULL DEFAULT 0,
                -- Overrides the payroll setting when set (a senior who gets 2 days a month).
                paid_leave_per_month NUMERIC,
                bank_name TEXT,
                bank_account TEXT,
                bank_ifsc TEXT,
                upi_id TEXT,
                pan TEXT,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS team_employees_username_idx ON team_employees (LOWER(username)) WHERE username IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS team_employees_code_idx ON team_employees (emp_code) WHERE emp_code IS NOT NULL;

            CREATE TABLE IF NOT EXISTS team_salary_history (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                employee_id INTEGER NOT NULL REFERENCES team_employees(id) ON DELETE CASCADE,
                effective_from DATE NOT NULL,
                monthly_salary NUMERIC NOT NULL,
                note TEXT,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Payroll and leave settings as one JSON document per key ('payroll').
            CREATE TABLE IF NOT EXISTS team_settings (
                key TEXT PRIMARY KEY,
                value JSONB NOT NULL,
                updated_by TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS team_holidays (
                day DATE PRIMARY KEY,
                name TEXT NOT NULL
            );

            -- Leave, half days, permission hours, and absences a lead marks.
            CREATE TABLE IF NOT EXISTS team_leave (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                employee_id INTEGER NOT NULL REFERENCES team_employees(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,                 -- leave | half | permission | absent
                from_date DATE NOT NULL,
                to_date DATE NOT NULL,
                half TEXT,                          -- am | pm, for a half day
                hours NUMERIC,                      -- for a permission
                start_time TEXT,
                end_time TEXT,
                reason TEXT,
                status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | cancelled
                decided_by TEXT,
                decided_at TIMESTAMP,
                decision_note TEXT,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS team_leave_emp_idx ON team_leave (employee_id, from_date);

            -- Money someone spent for the company, paid back with salary or straight away.
            CREATE TABLE IF NOT EXISTS team_claims (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                employee_id INTEGER NOT NULL REFERENCES team_employees(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                amount NUMERIC NOT NULL,
                spent_on DATE NOT NULL,
                category TEXT,
                company TEXT,
                link_ref TEXT,
                receipts JSONB DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'pending',   -- pending | lead_ok | approved | rejected | paid
                with_salary BOOLEAN DEFAULT true,
                lead_by TEXT, lead_at TIMESTAMP,
                approved_by TEXT, approved_at TIMESTAMP,
                rejected_by TEXT, rejected_reason TEXT,
                paid_run_id INTEGER,
                paid_at TIMESTAMP,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Salary given ahead, taken back a set amount each month.
            CREATE TABLE IF NOT EXISTS team_advances (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                employee_id INTEGER NOT NULL REFERENCES team_employees(id) ON DELETE CASCADE,
                amount NUMERIC NOT NULL,
                given_on DATE NOT NULL,
                recover_per_month NUMERIC NOT NULL,
                note TEXT,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS team_pay_runs (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                month DATE NOT NULL UNIQUE,                 -- the first of the month paid for
                status TEXT NOT NULL DEFAULT 'draft',       -- draft | approved | paid
                pay_date DATE,
                prepared_by TEXT,
                approved_by TEXT, approved_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- One person in one run. Amounts are frozen here once approved, so a later salary
            -- change never rewrites a payslip already sent.
            CREATE TABLE IF NOT EXISTS team_pay_lines (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                run_id INTEGER NOT NULL REFERENCES team_pay_runs(id) ON DELETE CASCADE,
                employee_id INTEGER NOT NULL REFERENCES team_employees(id),
                salary NUMERIC NOT NULL DEFAULT 0,
                day_rate NUMERIC NOT NULL DEFAULT 0,
                paid_leave_days NUMERIC NOT NULL DEFAULT 0,
                lop_days NUMERIC NOT NULL DEFAULT 0,
                lop_amount NUMERIC NOT NULL DEFAULT 0,
                incentive NUMERIC NOT NULL DEFAULT 0,
                incentive_note TEXT,
                claims NUMERIC NOT NULL DEFAULT 0,
                advance_back NUMERIC NOT NULL DEFAULT 0,
                net NUMERIC NOT NULL DEFAULT 0,
                pay_to TEXT,
                detail JSONB DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'pending',     -- pending | paid
                utr TEXT,
                paid_at TIMESTAMP,
                UNIQUE (run_id, employee_id)
            );

            -- Task boards.
            CREATE TABLE IF NOT EXISTS task_boards (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                key TEXT NOT NULL UNIQUE,                   -- MKT, the prefix of task numbers
                name TEXT NOT NULL,
                company TEXT NOT NULL DEFAULT 'both',
                lead_username TEXT,
                members TEXT[] NOT NULL DEFAULT '{}',
                use_sprints BOOLEAN NOT NULL DEFAULT true,
                sprint_weeks INTEGER NOT NULL DEFAULT 2,
                estimate_kind TEXT NOT NULL DEFAULT 'points',  -- points | hours | none
                wip_limits JSONB NOT NULL DEFAULT '{}',
                next_no INTEGER NOT NULL DEFAULT 1,
                archived BOOLEAN NOT NULL DEFAULT false,
                created_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS task_sprints (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                board_id INTEGER NOT NULL REFERENCES task_boards(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                goal TEXT,
                starts_on DATE NOT NULL,
                ends_on DATE NOT NULL,
                status TEXT NOT NULL DEFAULT 'planned',     -- planned | active | closed
                planned_points NUMERIC,
                closed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                board_id INTEGER NOT NULL REFERENCES task_boards(id) ON DELETE CASCADE,
                number INTEGER NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                -- ideas | todo | in_progress | hold | blocked | done | rejected
                status TEXT NOT NULL DEFAULT 'todo',
                status_reason TEXT,
                priority TEXT NOT NULL DEFAULT 'medium',    -- low | medium | high | urgent
                assignee TEXT,
                reporter TEXT,
                due_on DATE,
                estimate NUMERIC,
                labels TEXT[] NOT NULL DEFAULT '{}',
                sprint_id INTEGER REFERENCES task_sprints(id) ON DELETE SET NULL,
                parent_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
                position NUMERIC NOT NULL DEFAULT 0,
                checklist JSONB NOT NULL DEFAULT '[]',
                links JSONB NOT NULL DEFAULT '[]',
                watchers TEXT[] NOT NULL DEFAULT '{}',
                -- { every: day|weekday|week|month, next_on: 'YYYY-MM-DD' } on the task that repeats.
                repeat JSONB,
                started_at TIMESTAMP,
                done_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (board_id, number)
            );
            CREATE INDEX IF NOT EXISTS tasks_board_idx ON tasks (board_id, status);
            CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee, status);

            CREATE TABLE IF NOT EXISTS task_comments (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                author TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS task_files (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                path TEXT NOT NULL,
                name TEXT NOT NULL,
                size INTEGER,
                uploaded_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS task_activity (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                actor TEXT,
                what TEXT NOT NULL,
                from_val TEXT,
                to_val TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS task_activity_task_idx ON task_activity (task_id, created_at);

            -- What each person wants by email, and emails waiting to go out (changes to one task
            -- within a few minutes are sent together).
            CREATE TABLE IF NOT EXISTS team_notify_prefs (
                username TEXT PRIMARY KEY,
                prefs JSONB NOT NULL DEFAULT '{}',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS team_email_queue (
                id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                to_email TEXT NOT NULL,
                group_key TEXT NOT NULL,
                subject TEXT NOT NULL,
                line TEXT NOT NULL,
                link TEXT,
                send_after TIMESTAMP NOT NULL,
                sent_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS team_email_queue_due_idx ON team_email_queue (sent_at, send_after);
        `);
        await db.query(`UPDATE admin_users SET can_view_tasks = true, can_manage_boards = true, can_view_payroll = true
                         WHERE role IN ('owner','admin')`);
    } catch (err) {
        console.error('ensureTeamSchema error:', err.message);
    }
}

module.exports = { ensureTeamSchema };
