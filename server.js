require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const session = require("express-session"); const pgSession = require("connect-pg-simple")(session);
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const https = require("https"); const cloudinary = require("cloudinary").v2; cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, first_name VARCHAR(100), last_name VARCHAR(100), state VARCHAR(100) DEFAULT 'Nigeria', profile_pic_url VARCHAR(255), is_admin BOOLEAN DEFAULT FALSE);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Nigeria';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_pic_url VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE; ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE; ALTER TABLE users ADD COLUMN IF NOT EXISTS school_name VARCHAR(200) DEFAULT 'General'; ALTER TABLE users ADD COLUMN IF NOT EXISTS paystack_subaccount VARCHAR(100); ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(50); ALTER TABLE users ADD COLUMN IF NOT EXISTS school_scout_code VARCHAR(50); ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(50); ALTER TABLE users ADD COLUMN IF NOT EXISTS school_scout_code VARCHAR(50); UPDATE users SET is_super_admin = TRUE WHERE email = 'admin@school.com';
            ALTER TABLE IF EXISTS subscriptions ADD COLUMN IF NOT EXISTS academic_class VARCHAR(255);
            CREATE TABLE IF NOT EXISTS subscriptions (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, academic_class VARCHAR(255));
            CREATE TABLE IF NOT EXISTS student_results (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, academic_class VARCHAR(255), term_number VARCHAR(50), file_name VARCHAR(255));
            CREATE TABLE IF NOT EXISTS grant_winners (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, display_name VARCHAR(150), full_name VARCHAR(200), email VARCHAR(255), state VARCHAR(100), level VARCHAR(100), award VARCHAR(200), claim_code VARCHAR(50));
        `);
        await pool.query("INSERT INTO users (email, password_hash, first_name, last_name, state, school_name, is_admin) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (email) DO NOTHING", ["admin@school.com", "admin123", "Principal", "Alimi", "Delta State", true]);
        console.log("Cloud database tables verified!");
    } catch (err) { console.error("DB init:", err.message); }
}
initDB();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set("view engine", "ejs");
app.use("/download", express.static(path.join(__dirname, "uploads")));
app.use(session({ store: new pgSession({ pool: pool, createTableIfMissing: true }), secret: process.env.SESSION_SECRET || "eduvault_production_secret_2026", resave: false, saveUninitialized: false, cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } }));
const storage = multer.diskStorage({
    destination: (req, file, cb) => { if (!fs.existsSync("./uploads")) fs.mkdirSync("./uploads"); cb(null, "./uploads"); },
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

async function unlockStudentTerm(uid, cid, term) {
    if (!uid || !cid || !term) return;
    const raw = String(cid).toUpperCase().trim();
    const keys = [`${raw}_TERM_${String(term).trim()}`, `${raw.replace(/_/g, " ")}_TERM_${String(term).trim()}`, `${raw.replace(/\s+/g, "_")}_TERM_${String(term).trim()}`];
    for (const k of [...new Set(keys)]) {
        const ex = await pool.query("SELECT id FROM subscriptions WHERE user_id = $1 AND academic_class = $2", [uid, k]);
        if (ex.rows.length === 0) await pool.query("INSERT INTO subscriptions (user_id, academic_class) VALUES ($1, $2)", [uid, k]);
    }
}

async function syncPaystackPaymentsForEmail(uid, email) {
    if (!uid || !email) return;
    return new Promise((resolve) => {
        const req = https.request({ hostname: "api.paystack.co", port: 443, path: "/transaction?status=success&perPage=20", method: "GET", headers: { "Authorization": "Bearer " + String(process.env.PAYSTACK_SECRET_KEY || "").trim() } }, (res) => {
            let chunks = []; res.on("data", c => chunks.push(c));
            res.on("end", async () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    if (data.status && Array.isArray(data.data)) {
                        for (const tx of data.data) {
                            if (String(tx.customer && tx.customer.email || "").toLowerCase().trim() === String(email).toLowerCase().trim()) {
                                const m = tx.metadata || {};// WALLET_START
          if (m.purpose === "wallet_topup" && uid) {
            const paidNaira = Math.round(Number(d.data.amount || 0) / 100);
            if (paidNaira >= 100) {
              try {
                await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance INTEGER DEFAULT 0");
                await pool.query("CREATE TABLE IF NOT EXISTS wallet_ledger (id SERIAL PRIMARY KEY, user_id INTEGER, reference TEXT UNIQUE, amount INTEGER, kind TEXT, note TEXT, created_at TIMESTAMP DEFAULT NOW())");
                const ins = await pool.query("INSERT INTO wallet_ledger (user_id, reference, amount, kind, note) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (reference) DO NOTHING RETURNING id", [uid, ref, paidNaira, "TOPUP", "Installment top-up via Paystack"]);
                if (ins.rows && ins.rows.length > 0) await pool.query("UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2", [paidNaira, uid]);
              } catch (we) {}
            }
            return req.session.save(() => res.redirect("/dashboard?wmsg=credited"));
          }
          // WALLET_END
          await unlockStudentTerm(uid, m.class_id || "PRIMARY_1", m.term_number || "1");
                            }
                        }
                    }
                } catch (e) {} resolve();
            });
        });
        req.on("error", () => resolve()); req.end();
    });
}
app.get("/", async (req, res) => {
    try {
        const wRes = await pool.query("SELECT * FROM grant_winners ORDER BY id DESC");
        res.render("index", { user: req.session.user || null, isAdmin: req.session.isAdmin || false, winners: wRes.rows.map(w => ({ id: w.id, userId: w.user_id, displayName: w.display_name, state: w.state, level: w.level, award: w.award })) });
    } catch (e) { res.render("index", { user: req.session.user || null, isAdmin: req.session.isAdmin || false, winners: [] }); }
});
app.get("/contact", (req, res) => res.render("contact", { sent: false }));
app.post("/contact", async (req, res) => {
    const cName = String(req.body.name || "").trim();
    const cPhone = String(req.body.phone || "").trim();
    const cTopic = String(req.body.topic || "General").trim();
    const cMsg = String(req.body.message || "").trim();
    try {
        await pool.query("CREATE TABLE IF NOT EXISTS contact_messages (id SERIAL PRIMARY KEY, name VARCHAR(150), phone VARCHAR(100), topic VARCHAR(150), message TEXT, created_at TIMESTAMP DEFAULT NOW())");
        await pool.query("INSERT INTO contact_messages (name, phone, topic, message) VALUES ($1,$2,$3,$4)", [cName, cPhone, cTopic, cMsg]);
    } catch (e) { console.error("Contact DB err:", e.message); }

    const apiKey = (process.env.RESEND_API_KEY || "").trim();
    if (apiKey) {
        try {
            const mailRes = await fetch("https://resend.com", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    from: "Result Vault <onboarding@resend.dev>",
                    to: ["info@nigeriapryandsecresultvaults.com"],
                    subject: `Website Inquiry: ${cTopic} — ${cName}`,
                    html: `<h3>New Contact Us Message</h3>
                           <p><strong>Name:</strong> ${cName}</p>
                           <p><strong>Phone / Email:</strong> ${cPhone}</p>
                           <p><strong>Topic:</strong> ${cTopic}</p>
                           <p><strong>Message:</strong><br>${cMsg}</p>`
                })
            });
            const mailData = await mailRes.json();
            console.log("Resend API response:", mailRes.status, JSON.stringify(mailData));
        } catch (mailErr) {
            console.error("Resend fetch err:", mailErr.message);
        }
    }
    return res.render("contact", { sent: true });
});
app.post("/contact", async (req, res) => {
    const cName = String(req.body.name || "").trim();
    const cPhone = String(req.body.phone || "").trim();
    const cTopic = String(req.body.topic || "General").trim();
    const cMsg = String(req.body.message || "").trim();
    try {
        await pool.query("CREATE TABLE IF NOT EXISTS contact_messages (id SERIAL PRIMARY KEY, name VARCHAR(150), phone VARCHAR(100), topic VARCHAR(150), message TEXT, created_at TIMESTAMP DEFAULT NOW())");
        await pool.query("INSERT INTO contact_messages (name, phone, topic, message) VALUES ($1,$2,$3,$4)", [cName, cPhone, cTopic, cMsg]);
    } catch (e) { console.error("Contact DB err:", e.message); }

    const apiKey = (process.env.RESEND_API_KEY || "").trim();
    console.log("CONTACT HIT -> RESEND_API_KEY present:", Boolean(apiKey));
    if (apiKey) {
        try {
            const mailRes = await fetch("https://resend.com", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    from: "Result Vault <onboarding@resend.dev>",
                    to: ["info@nigeriapryandsecresultvaults.com"],
                    subject: `Website Inquiry: ${cTopic} — ${cName}`,
                    html: `<h3>New Contact Us Message</h3>
                           <p><strong>Name:</strong> ${cName}</p>
                           <p><strong>Phone / Email:</strong> ${cPhone}</p>
                           <p><strong>Topic:</strong> ${cTopic}</p>
                           <p><strong>Message:</strong><br>${cMsg}</p>`
                })
            });
            const mailData = await mailRes.json();
            console.log("Resend API status:", mailRes.status, JSON.stringify(mailData));
        } catch (mailErr) {
            console.error("Resend fetch err:", mailErr.message);
        }
    }
    return res.render("contact", { sent: true });
});

app.get("/login", (req, res) => res.render("login"));
app.get("/admin", (req, res) => res.redirect("/admin/dashboard"));
app.post("/login", async (req, res) => {
    try {
        const r = await pool.query("SELECT * FROM users WHERE email = $1", [String(req.body.email || "").toLowerCase().trim()]);
        if (r.rows.length > 0 && req.body.password === r.rows[0].password_hash) {
            const u = r.rows[0]; req.session.userId = u.id; req.session.isAdmin = u.is_admin || false; req.session.isSuperAdmin = u.is_super_admin || (u.email === 'admin@school.com'); req.session.schoolName = u.school_name || 'General';
            req.session.user = { id: u.id, firstName: u.first_name, lastName: u.last_name, email: u.email, profilePicUrl: u.profile_pic_url || "" };
            return res.redirect(req.session.isAdmin ? "/admin/dashboard" : "/dashboard");
        }
        res.send("<h2>Invalid credentials. <a href='/login'>Try again</a>.</h2>");
    } catch (err) { res.status(500).send("Database error."); }
});
function makeSchoolSlug(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

app.get("/school/:slug", async (req, res) => {
    const slug = makeSchoolSlug(req.params.slug);
    try {
        const schRes = await pool.query("SELECT DISTINCT school_name FROM users WHERE is_admin = TRUE AND school_name IS NOT NULL AND school_name != 'General' ORDER BY school_name ASC");
        const starterSchools = [
            "Auntie Azuk's Schools, Sapele",
            "Chude Girls Model Secondary School, Sapele",
            "Eagles International Academy, Sapele",
            "Gloryland International Secondary School, Sapele",
            "Mona School, Sapele",
            "Obule Integrated Schools, Sapele",
            "Okotie-Eboh Grammar School, Sapele",
            "Okpe Grammar School, Sapele",
            "St. Louis College, Sapele",
            "Ufuoma Mixed Secondary School, Sapele"
        ];
        const allSchools = [...new Set([...schRes.rows.map(r => r.school_name), ...starterSchools])].sort();
        const matched = allSchools.find(s => makeSchoolSlug(s) === slug) || null;
        return res.render("register", { schools: allSchools, selectedSchool: matched });
    } catch (e) {
        return res.redirect("/register");
    }
});

app.get("/ref/:code", (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (code) req.session.refCode = code;
    res.redirect("/register" + (code ? "?ref=" + encodeURIComponent(code) : ""));
});

app.post("/contact", async (req, res) => { const cName = String(req.body.name || "").trim(); const cPhone = String(req.body.phone || "").trim(); const cTopic = String(req.body.topic || "General").trim(); const cMsg = String(req.body.message || "").trim(); try { await pool.query("CREATE TABLE IF NOT EXISTS contact_messages (id SERIAL PRIMARY KEY, name VARCHAR(150), phone VARCHAR(100), topic VARCHAR(150), message TEXT, created_at TIMESTAMP DEFAULT NOW())"); await pool.query("INSERT INTO contact_messages (name, phone, topic, message) VALUES ($1,$2,$3,$4)", [cName, cPhone, cTopic, cMsg]); } catch (e) {} const apiKey = (process.env.RESEND_API_KEY || "").trim(); console.log("CONTACT FORM -> RESEND_API_KEY set:", Boolean(apiKey)); if (apiKey) { for (const toAddr of ["info@nigeriapryandsecresultvaults.com", "ogodoafure@gmail.com"]) { try { const r = await fetch("https://resend.com", { method: "POST", headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ from: "Result Vault <onboarding@resend.dev>", to: [toAddr], subject: "Website Inquiry: " + cTopic + " - " + cName, html: "<h3>New Contact Us Message</h3><p><b>Name:</b> " + cName + "</p><p><b>Phone/Email:</b> " + cPhone + "</p><p><b>Topic:</b> " + cTopic + "</p><p><b>Message:</b><br>" + cMsg + "</p>" }) }); const d = await r.json(); console.log("Resend ->", toAddr, r.status, JSON.stringify(d)); } catch (err) { console.error("Resend err:", err.message); } } } return res.render("contact", { sent: true }); }); app.use(async (req, res, next) => { if (req.method === "POST" && req.path.toLowerCase().includes("contact")) { const cName = String(req.body.name || req.body.fullName || "").trim(); const cPhone = String(req.body.phone || req.body.email || "").trim(); const cTopic = String(req.body.topic || req.body.subject || "General").trim(); const cMsg = String(req.body.message || req.body.msg || "").trim(); const apiKey = (process.env.RESEND_API_KEY || "").trim(); console.log("GLOBAL_CONTACT_MAILER HIT | key:", Boolean(apiKey), "| from:", cName); if (apiKey) { const atSign = String.fromCharCode(64); const sender = "Result Vault <onboarding" + atSign + "resend.dev>"; const url = "https:" + "//://resend.com"; for (const toAddr of ["info" + atSign + "nigeriapryandsecresultvaults.com", "ogodoafure" + atSign + "gmail.com"]) { try { const r = await fetch(url, { method: "POST", headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ from: sender, to: [toAddr], subject: "Website Inquiry: " + cTopic + " - " + cName, html: "<h3>New Contact Us Message</h3><p><b>Name:</b> " + cName + "</p><p><b>Phone/Email:</b> " + cPhone + "</p><p><b>Topic:</b> " + cTopic + "</p><p><b>Message:</b><br>" + cMsg + "</p>" }) }); const d = await r.json(); console.log("Resend ->", toAddr, r.status, JSON.stringify(d)); } catch (err) { console.error("Resend err:", err.message); } } } } next(); }); app.get("/refer", async (req, res) => {
    const lookup = String(req.query.code || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    let stats = null;
    if (lookup) {
        try {
            await pool.query("CREATE TABLE IF NOT EXISTS referrers (id SERIAL PRIMARY KEY, ref_code VARCHAR(50) UNIQUE, full_name VARCHAR(150), phone VARCHAR(60), bank_name VARCHAR(120), account_number VARCHAR(30), account_name VARCHAR(150), created_at TIMESTAMP DEFAULT NOW())");
            await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(50)");
            await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS school_scout_code VARCHAR(50)");
            await pool.query("ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ref_settled BOOLEAN DEFAULT FALSE");
            const rInfo = await pool.query("SELECT * FROM referrers WHERE ref_code = $1", [lookup]);
            if (rInfo.rows.length > 0) {
                const subRows = await pool.query(`
                    SELECT s.id, COALESCE(s.ref_settled, FALSE) AS ref_settled,
                           CASE WHEN TRIM(LOWER(u.school_name)) IN (SELECT DISTINCT TRIM(LOWER(school_name)) FROM users WHERE is_admin = TRUE AND email != 'admin@school.com' AND school_name IS NOT NULL AND TRIM(LOWER(school_name)) != 'general') THEN 500 ELSE 1000 END AS comm
                    FROM subscriptions s
                    JOIN users u ON s.user_id = u.id
                    LEFT JOIN users sa ON sa.is_admin = TRUE AND TRIM(LOWER(sa.school_name)) = TRIM(LOWER(u.school_name))
                    WHERE u.is_admin = FALSE AND (UPPER(COALESCE(u.referred_by,'')) = $1 OR UPPER(COALESCE(sa.school_scout_code,'')) = $1)
                `, [lookup]);
                const totalEarned = subRows.rows.reduce((sum, x) => sum + Number(x.comm || 0), 0);
                const totalPaid = subRows.rows.filter(x => x.ref_settled).reduce((sum, x) => sum + Number(x.comm || 0), 0);
                stats = { profile: rInfo.rows, paidTerms: subRows.rows.length, totalEarned, totalPaid, pending: totalEarned - totalPaid };
            }
        } catch (e) { console.error("Refer lookup err:", e.message); }
    }
    res.render("refer", { created: req.query.created || null, lookup, stats, host: req.get("host"), protocol: req.protocol });
});

app.post("/refer/create", async (req, res) => {
    const fullName = String(req.body.fullName || "").trim();
    const phone = String(req.body.phone || "").trim();
    const bankName = String(req.body.bankName || "").trim();
    const accountNumber = String(req.body.accountNumber || "").trim();
    const accountName = String(req.body.accountName || "").trim();
    let rawCode = String(req.body.customCode || fullName.split(/\s+/)[0] || "REF").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    if (rawCode.length < 3) rawCode = "REF" + Math.floor(100 + Math.random() * 900);
    try {
        await pool.query("CREATE TABLE IF NOT EXISTS referrers (id SERIAL PRIMARY KEY, ref_code VARCHAR(50) UNIQUE, full_name VARCHAR(150), phone VARCHAR(60), bank_name VARCHAR(120), account_number VARCHAR(30), account_name VARCHAR(150), created_at TIMESTAMP DEFAULT NOW())");
        const exists = await pool.query("SELECT ref_code FROM referrers WHERE ref_code = $1", [rawCode]);
        if (exists.rows.length > 0) rawCode = rawCode + Math.floor(10 + Math.random() * 89);
        await pool.query("INSERT INTO referrers (ref_code, full_name, phone, bank_name, account_number, account_name) VALUES ($1,$2,$3,$4,$5,$6)", [rawCode, fullName, phone, bankName, accountNumber, accountName]);
        return res.redirect("/refer?created=" + encodeURIComponent(rawCode) + "&code=" + encodeURIComponent(rawCode));
    } catch (e) {
        console.error("Create ref err:", e.message);
        return res.redirect("/refer");
    }
});

app.post("/admin/settle-ref-commission", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    const isSuper = req.session.isSuperAdmin || (req.session.user && req.session.user.email === "admin@school.com");
    if (!isSuper) return res.status(403).send("Unauthorized");
    const subId = Number(req.body.subId);
    if (subId) {
        try {
            await pool.query("ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ref_settled BOOLEAN DEFAULT FALSE");
            await pool.query("UPDATE subscriptions SET ref_settled = TRUE WHERE id = $1", [subId]);
        } catch (e) {}
    }
    res.redirect("/admin/dashboard");
});

app.post("/admin/update-school-scout", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    const isSuper = req.session.isSuperAdmin || (req.session.user && req.session.user.email === "admin@school.com");
    if (!isSuper) return res.status(403).send("Unauthorized");
    const adminId = Number(req.body.adminId);
    const scoutCode = String(req.body.schoolScoutCode || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (adminId) {
        try {
            await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS school_scout_code VARCHAR(50)");
            await pool.query("UPDATE users SET school_scout_code = $1 WHERE id = $2", [scoutCode, adminId]);
        } catch (e) {}
    }
    res.redirect("/admin/dashboard");
});

app.get("/register", (req, res) => res.render("register"));
app.post("/register", async (req, res) => {
    const { email, password, firstName, lastName, role, state, schoolName } = req.body;
    try {
        await pool.query("INSERT INTO users (email, password_hash, first_name, last_name, state, school_name, is_admin) VALUES ($1,$2,$3,$4,$5,$6,$7)", [email.toLowerCase().trim(), password, firstName.trim(), lastName.trim(), state || "Nigeria", (schoolName || "General").trim(), role === "registry" || role === "admin"]);
        res.redirect("/login");
    } catch (err) { console.error('Register err:', err.message); res.send('<h2>Registration error: ' + err.message + ' <a href="/register">Try again</a>.</h2>'); }
});
app.get("/classmates", async (req, res) => { if (!req.session.userId) return res.redirect("/login"); try { await pool.query("CREATE TABLE IF NOT EXISTS peer_connections (id SERIAL PRIMARY KEY, sender_id INT, receiver_id INT, status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW())"); await pool.query("CREATE TABLE IF NOT EXISTS peer_messages (id SERIAL PRIMARY KEY, sender_id INT, receiver_id INT, body TEXT, created_at TIMESTAMP DEFAULT NOW())"); await pool.query("CREATE TABLE IF NOT EXISTS school_memories (id SERIAL PRIMARY KEY, school_name VARCHAR(200), author_id INT, author_name VARCHAR(150), class_tag VARCHAR(80), memory_text TEXT, created_at TIMESTAMP DEFAULT NOW())"); const meRes = await pool.query("SELECT id, first_name, last_name, school_name, state FROM users WHERE id = $1", [req.session.userId]); const me = meRes.rows; if (!me) return res.redirect("/login"); const q = String(req.query.q || "").trim(); const chatWith = Number(req.query.chat || 0); const peersRes = q ? await pool.query("SELECT id, first_name, last_name, school_name, state FROM users WHERE is_admin = FALSE AND id != $1 AND (LOWER(first_name || ' ' || last_name) LIKE LOWER($2) OR LOWER(COALESCE(school_name, '')) LIKE LOWER($2) OR LOWER(COALESCE(state, '')) LIKE LOWER($2)) ORDER BY id DESC LIMIT 30", [me.id, "%" + q + "%"]) : await pool.query("SELECT id, first_name, last_name, school_name, state FROM users WHERE is_admin = FALSE AND id != $1 ORDER BY (CASE WHEN LOWER(TRIM(COALESCE(school_name, ''))) = LOWER(TRIM(COALESCE($2, ''))) THEN 0 ELSE 1 END), id DESC LIMIT 30", [me.id, me.school_name || ""]); const connsRes = await pool.query("SELECT * FROM peer_connections WHERE sender_id = $1 OR receiver_id = $1 ORDER BY id DESC", [me.id]); const incomingRes = await pool.query("SELECT pc.id AS conn_id, u.id AS user_id, u.first_name, u.last_name, u.school_name, u.state FROM peer_connections pc JOIN users u ON pc.sender_id = u.id WHERE pc.receiver_id = $1 AND pc.status = 'pending' ORDER BY pc.id DESC", [me.id]); const friendsRes = await pool.query("SELECT u.id, u.first_name, u.last_name, u.school_name, u.state FROM peer_connections pc JOIN users u ON (CASE WHEN pc.sender_id = $1 THEN pc.receiver_id ELSE pc.sender_id END) = u.id WHERE (pc.sender_id = $1 OR pc.receiver_id = $1) AND pc.status = 'accepted'", [me.id]); const memRes = await pool.query("SELECT * FROM school_memories WHERE LOWER(TRIM(COALESCE(school_name, ''))) = LOWER(TRIM(COALESCE($1, ''))) ORDER BY id DESC LIMIT 25", [me.school_name || "General"]); let activeFriend = null, messages = []; if (chatWith) { const isFriend = friendsRes.rows.find(f => f.id === chatWith); if (isFriend) { activeFriend = isFriend; const msgRes = await pool.query("SELECT * FROM peer_messages WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1) ORDER BY id ASC LIMIT 60", [me.id, chatWith]); messages = msgRes.rows; } } res.render("classmates", { me, q, peers: peersRes.rows, conns: connsRes.rows, incoming: incomingRes.rows, friends: friendsRes.rows, memories: memRes.rows, activeFriend, messages }); } catch (e) { console.error("Classmates err:", e.message); res.redirect("/dashboard"); } }); app.post("/classmates/connect", async (req, res) => { if (!req.session.userId) return res.redirect("/login"); const targetId = Number(req.body.targetId); if (targetId && targetId !== req.session.userId) { try { const ex = await pool.query("SELECT id FROM peer_connections WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)", [req.session.userId, targetId]); if (ex.rows.length === 0) await pool.query("INSERT INTO peer_connections (sender_id, receiver_id, status) VALUES ($1, $2, 'pending')", [req.session.userId, targetId]); } catch (e) {} } res.redirect("/classmates"); }); app.post("/classmates/respond", async (req, res) => { if (!req.session.userId) return res.redirect("/login"); const connId = Number(req.body.connId); const action = req.body.action === "accept" ? "accepted" : "blocked"; if (connId) { try { await pool.query("UPDATE peer_connections SET status = $1 WHERE id = $2 AND receiver_id = $3", [action, connId, req.session.userId]); } catch (e) {} } res.redirect("/classmates"); }); app.post("/classmates/send", async (req, res) => { if (!req.session.userId) return res.redirect("/login"); const receiverId = Number(req.body.receiverId); const body = String(req.body.body || "").trim().slice(0, 600); if (receiverId && body) { try { const ok = await pool.query("SELECT id FROM peer_connections WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)) AND status = 'accepted'", [req.session.userId, receiverId]); if (ok.rows.length > 0) await pool.query("INSERT INTO peer_messages (sender_id, receiver_id, body) VALUES ($1, $2, $3)", [req.session.userId, receiverId, body]); } catch (e) {} } res.redirect("/classmates?chat=" + receiverId); }); app.post("/classmates/memory", async (req, res) => { if (!req.session.userId) return res.redirect("/login"); const classTag = String(req.body.classTag || "Alumni").trim().slice(0, 60); const memoryText = String(req.body.memoryText || "").trim().slice(0, 500); if (memoryText) { try { const u = await pool.query("SELECT first_name, last_name, school_name FROM users WHERE id = $1", [req.session.userId]); if (u.rows.length > 0) await pool.query("INSERT INTO school_memories (school_name, author_id, author_name, class_tag, memory_text) VALUES ($1, $2, $3, $4, $5)", [u.rows.school_name || "General", req.session.userId, u.rows.first_name + " " + u.rows.last_name, classTag, memoryText]); } catch (e) {} } res.redirect("/classmates"); }); app.get("/dashboard", async (req, res) => {
    if (!req.session.userId || req.session.isAdmin) return res.redirect("/login");
    try {
        await syncPaystackPaymentsForEmail(req.session.userId, req.session.user && req.session.user.email);
        const subRes = await pool.query("SELECT academic_class FROM subscriptions WHERE user_id = $1", [req.session.userId]);
        const resQuery = await pool.query("SELECT academic_class, term_number, file_name FROM student_results WHERE user_id = $1", [req.session.userId]);
        const savedResults = {}; resQuery.rows.forEach(r => { savedResults[r.academic_class + "_TERM_" + r.term_number] = r.file_name; });
        const winQuery = await pool.query("SELECT * FROM grant_winners WHERE user_id = $1 LIMIT 1", [req.session.userId]);
        const myWin = winQuery.rows.length > 0 ? { award: winQuery.rows[0].award, level: winQuery.rows[0].level, claimCode: winQuery.rows[0].claim_code } : null;// WALLET_START
    let walletBalance = 0, walletLedger = [];
    try {
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance INTEGER DEFAULT 0");
      await pool.query("CREATE TABLE IF NOT EXISTS wallet_ledger (id SERIAL PRIMARY KEY, user_id INTEGER, reference TEXT UNIQUE, amount INTEGER, kind TEXT, note TEXT, created_at TIMESTAMP DEFAULT NOW())");
      const uEmail = String(req.session.user && req.session.user.email || "").trim().toLowerCase();
      if (uEmail && process.env.PAYSTACK_SECRET_KEY) {
        const psList = await new Promise((resolve) => {
          const r = https.request({ hostname: "api.paystack.co", port: 443, path: "/transaction?perPage=30&status=success", method: "GET", headers: { Authorization: "Bearer " + String(process.env.PAYSTACK_SECRET_KEY).trim() } }, res2 => {
            let b = []; res2.on("data", c => b.push(c));
            res2.on("end", () => { try { resolve(JSON.parse(Buffer.concat(b).toString()).data || []); } catch (e) { resolve([]); } });
          });
          r.on("error", () => resolve([])); r.end();
        });
        for (const tx of psList) {
          const meta = tx.metadata || {};
          const custEmail = String(tx.customer && tx.customer.email || "").trim().toLowerCase();
          if (meta.purpose === "wallet_topup" && (Number(meta.user_id) === Number(req.session.userId) || custEmail === uEmail)) {
            const paidNaira = Math.round(Number(tx.amount || 0) / 100);
            if (paidNaira >= 100 && tx.reference) {
              const ins = await pool.query("INSERT INTO wallet_ledger (user_id, reference, amount, kind, note) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (reference) DO NOTHING RETURNING id", [req.session.userId, tx.reference, paidNaira, "TOPUP", "Installment top-up via Paystack"]);
              if (ins.rows && ins.rows.length > 0) {
                await pool.query("UPDATE users SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2", [paidNaira, req.session.userId]);
              }
            }
          }
        }
      }
      const wb = await pool.query("SELECT COALESCE(wallet_balance, 0) AS wb FROM users WHERE id = $1", [req.session.userId]);
      if (wb.rows && wb.rows.length > 0) walletBalance = Number(wb.rows[0].wb || 0);
      walletLedger = (await pool.query("SELECT amount, note FROM wallet_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 5", [req.session.userId])).rows || [];
    } catch (we) { console.error("Wallet sync err:", we.message); }
    // WALLET_END
    res.render("dashboard", { user: req.session.user, unlockedClasses: subRes.rows.map(r => r.academic_class), savedResults, publicKey: (process.env.PAYSTACK_PUBLIC_KEY || "").trim(), myWin, walletBalance, walletLedger, walletMsg: req.query.wmsg || "" });
    } catch (err) { res.status(500).send("Error loading dashboard."); }
});
app.post("/admin/seed-10-schools", async (req, res) => { if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login"); const isSuper = req.session.isSuperAdmin || (req.session.user && req.session.user.email === "admin@school.com"); if (!isSuper) return res.status(403).send("Unauthorized"); const schools = [["Okpe Grammar School, Sapele","admin@okpegrammar.edu.ng","OkpeAdmin2026","Delta State"],["St. Louis College, Sapele","admin@stlouissapele.edu.ng","StLouisAdmin2026","Delta State"],["Obule Integrated Schools, Sapele","admin@obuleschools.edu.ng","ObuleAdmin2026","Delta State"],["Gloryland International Secondary School, Sapele","admin@glorylandsapele.edu.ng","GloryAdmin2026","Delta State"],["Zik Grammar School, Sapele","admin@zikgrammar.edu.ng","ZikAdmin2026","Delta State"],["Hussey College, Warri","admin@husseywarri.edu.ng","HusseyAdmin2026","Delta State"],["Ikeja High School, Ikeja Lagos","admin@ikejahigh.edu.ng","IkejaAdmin2026","Lagos State"],["Vivian Fowler Memorial College, Lagos","admin@vivianfowler.edu.ng","VivianAdmin2026","Lagos State"],["Garki Model Secondary School, Abuja","admin@garkimodel.edu.ng","GarkiAdmin2026","FCT Abuja"],["Funtaj International School, Abuja","admin@funtajabuja.edu.ng","FuntajAdmin2026","FCT Abuja"],["St. Patrick\u0027s College, Asaba","admin@stpatricksasaba.edu.ng","StPatrickAdmin2026","Delta State"],["Federal Government Girls\u0027 College, Ibusa-Asaba","admin@fggcasaba.edu.ng","FggcAsabaAdmin2026","Delta State"],["Graceland International School, Asaba","admin@gracelandasaba.edu.ng","GracelandAdmin2026","Delta State"],["Dennis Memorial Model College, Asaba","admin@dennisasaba.edu.ng","DennisAdmin2026","Delta State"],["Master Care International School, Asaba","admin@mastercareasaba.edu.ng","MasterCareAdmin2026","Delta State"],["Federal Government College, Warri","admin@fgcwarri.edu.ng","FgcWarriAdmin2026","Delta State"],["Our Lady\u0027s High School, Effurun-Warri","admin@ourladyswarri.edu.ng","OurLadyAdmin2026","Delta State"],["DSC Technical High School, Aladja-Warri","admin@dsctechwarri.edu.ng","DscTechAdmin2026","Delta State"],["Urhobo College, Effurun-Warri","admin@urhobocollege.edu.ng","UrhoboAdmin2026","Delta State"],["Hilltop International Academy, Warri","admin@hilltopwarri.edu.ng","HilltopAdmin2026","Delta State"],["Edo College, Benin City","admin@edocollegebenin.edu.ng","EdoCollegeAdmin2026","Edo State"],["Idia College, Benin City","admin@idiacollegebenin.edu.ng","IdiaAdmin2026","Edo State"],["Lumen Christi International High School, Benin","admin@lumenbenin.edu.ng","LumenAdmin2026","Edo State"],["Igbinedion Education Centre, Benin City","admin@igbinedionbenin.edu.ng","IgbinedionAdmin2026","Edo State"],["Word of Faith Group of Schools, Benin City","admin@wordoffaithbenin.edu.ng","WordFaithAdmin2026","Edo State"]]; for (const [sName, sEmail, sPass, sState] of schools) { try { await pool.query("INSERT INTO users (email, password_hash, first_name, last_name, state, school_name, is_admin) VALUES ($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT (email) DO NOTHING", [sEmail, sPass, "School", "Admin", sState, sName]); } catch (e) {} } res.redirect("/admin/dashboard"); }); app.post("/admin/confirm-bonafide", async (req, res) => { if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login"); const studentId = Number(req.body.studentId); if (studentId) { try { await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bonafide BOOLEAN DEFAULT FALSE"); const isSuper = req.session.isSuperAdmin || (req.session.user && req.session.user.email === "admin@school.com"); if (isSuper) { await pool.query("UPDATE users SET is_bonafide = NOT COALESCE(is_bonafide, FALSE) WHERE id = $1 AND is_admin = FALSE", [studentId]); } else { const me = await pool.query("SELECT school_name FROM users WHERE id = $1", [req.session.userId]); const mySchool = (me.rows[0] && me.rows[0].school_name) ? me.rows[0].school_name.trim().toLowerCase() : ""; await pool.query("UPDATE users SET is_bonafide = NOT COALESCE(is_bonafide, FALSE) WHERE id = $1 AND is_admin = FALSE AND TRIM(LOWER(COALESCE(school_name, ''))) = $2", [studentId, mySchool]); } } catch (e) { console.error("Bonafide err:", e.message); } } res.redirect("/admin/dashboard"); }); app.get("/admin/dashboard", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    try {
        const isSuper = req.session.isSuperAdmin || (req.session.user && req.session.user.email === "admin@school.com");
        const sch = req.session.schoolName || "General";
        await pool.query("ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS commission_settled BOOLEAN DEFAULT FALSE");
        await pool.query("CREATE TABLE IF NOT EXISTS school_reports (id SERIAL PRIMARY KEY, school_name VARCHAR(200), sender_email VARCHAR(200), subscribed_count INT, student_names TEXT, note TEXT, created_at TIMESTAMP DEFAULT NOW())");
        const resQuery = isSuper
            ? await pool.query("SELECT r.file_name, r.academic_class, r.term_number, u.first_name, u.last_name, u.email, u.school_name FROM student_results r JOIN users u ON r.user_id = u.id ORDER BY u.school_name ASC, u.last_name ASC")
            : await pool.query("SELECT r.file_name, r.academic_class, r.term_number, u.first_name, u.last_name, u.email, u.school_name FROM student_results r JOIN users u ON r.user_id = u.id WHERE TRIM(LOWER(u.school_name)) = TRIM(LOWER($1)) ORDER BY u.last_name ASC", [sch]);
        const stuQuery = isSuper
            ? await pool.query("SELECT u.id, u.first_name, u.last_name, u.email, u.school_name, COUNT(s.id) AS paid_count, COUNT(CASE WHEN s.commission_settled = TRUE THEN 1 END) AS settled_count FROM users u LEFT JOIN subscriptions s ON u.id = s.user_id WHERE u.is_admin = FALSE GROUP BY u.id, u.first_name, u.last_name, u.email, u.school_name ORDER BY u.first_name ASC")
            : await pool.query("SELECT u.id, u.first_name, u.last_name, u.email, u.school_name, COUNT(s.id) AS paid_count, COUNT(CASE WHEN s.commission_settled = TRUE THEN 1 END) AS settled_count FROM users u LEFT JOIN subscriptions s ON u.id = s.user_id WHERE u.is_admin = FALSE AND TRIM(LOWER(u.school_name)) = TRIM(LOWER($1)) GROUP BY u.id, u.first_name, u.last_name, u.email, u.school_name ORDER BY u.first_name ASC", [sch]);
        const admQuery = isSuper
            ? await pool.query("SELECT id, first_name, last_name, email, school_name, paystack_subaccount, school_scout_code FROM users WHERE is_admin = TRUE AND email != 'admin@school.com' ORDER BY school_name ASC")
            : { rows: [] };
        await pool.query("CREATE TABLE IF NOT EXISTS contact_messages (id SERIAL PRIMARY KEY, name VARCHAR(150), phone VARCHAR(100), topic VARCHAR(150), message TEXT, created_at TIMESTAMP DEFAULT NOW())");
        const repQuery = isSuper
            ? await pool.query("SELECT * FROM school_reports ORDER BY id DESC")
            : { rows: [] };
        const msgQuery = isSuper
            ? await pool.query("SELECT * FROM contact_messages ORDER BY id DESC")
            : { rows: [] };
        await pool.query("CREATE TABLE IF NOT EXISTS site_reviews (id SERIAL PRIMARY KEY, author_name VARCHAR(120), role_label VARCHAR(120), state_name VARCHAR(80), rating INT DEFAULT 5, comment TEXT, approved BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())");
        const allRevQuery = isSuper
            ? await pool.query("SELECT * FROM site_reviews ORDER BY id DESC")
            : { rows: [] };
                await pool.query("CREATE TABLE IF NOT EXISTS referrers (id SERIAL PRIMARY KEY, ref_code VARCHAR(50) UNIQUE, full_name VARCHAR(150), phone VARCHAR(60), bank_name VARCHAR(120), account_number VARCHAR(30), account_name VARCHAR(150), created_at TIMESTAMP DEFAULT NOW())");
        await pool.query("ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ref_settled BOOLEAN DEFAULT FALSE");
        const refLedgerQuery = isSuper ? await pool.query(`
            SELECT s.id AS sub_id, COALESCE(to_jsonb(s)->>'academic_class', to_jsonb(s)->>'class_level', '') AS academic_class, COALESCE(to_jsonb(s)->>'term_number', to_jsonb(s)->>'term', '') AS term_number, COALESCE(s.ref_settled, FALSE) AS ref_settled,
                   u.first_name, u.last_name, u.school_name,
                   COALESCE(NULLIF(UPPER(u.referred_by),''), UPPER(sa.school_scout_code)) AS active_code,
                   r.full_name AS ref_name, r.phone AS ref_phone, r.bank_name, r.account_number, r.account_name,
                   CASE WHEN TRIM(LOWER(u.school_name)) IN (SELECT DISTINCT TRIM(LOWER(school_name)) FROM users WHERE is_admin = TRUE AND email != 'admin@school.com' AND school_name IS NOT NULL AND TRIM(LOWER(school_name)) != 'general') THEN 500 ELSE 1000 END AS comm_amount
            FROM subscriptions s
            JOIN users u ON s.user_id = u.id
            LEFT JOIN users sa ON sa.is_admin = TRUE AND TRIM(LOWER(sa.school_name)) = TRIM(LOWER(u.school_name))
            LEFT JOIN referrers r ON r.ref_code = COALESCE(NULLIF(UPPER(u.referred_by),''), UPPER(sa.school_scout_code))
            WHERE u.is_admin = FALSE AND COALESCE(NULLIF(UPPER(u.referred_by),''), UPPER(sa.school_scout_code)) IS NOT NULL AND COALESCE(NULLIF(UPPER(u.referred_by),''), UPPER(sa.school_scout_code)) != ''
            ORDER BY s.id DESC
        `) : { rows: [] };
                await pool.query("CREATE TABLE IF NOT EXISTS referrers (id SERIAL PRIMARY KEY, ref_code VARCHAR(50) UNIQUE, full_name VARCHAR(150), phone VARCHAR(60), bank_name VARCHAR(120), account_number VARCHAR(30), account_name VARCHAR(150), created_at TIMESTAMP DEFAULT NOW())");
        await pool.query("ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ref_settled BOOLEAN DEFAULT FALSE");
        const winQuery = await pool.query("SELECT * FROM grant_winners ORDER BY id DESC");
        res.render("admin-dashboard", {
            user: req.session.user,
            isSuper,
            schoolName: sch,
            schoolAdmins: admQuery.rows, partnerSchoolNames: admQuery.rows.map(a => String(a.school_name || "").trim().toLowerCase()),
            schoolReports: repQuery.rows, contactMessages: msgQuery.rows, allReviews: allRevQuery.rows,
            uploadedResults: resQuery.rows,
            students: stuQuery.rows,
            winners: winQuery.rows.map(w => ({ id: w.id, displayName: w.display_name, fullName: w.full_name, email: w.email, state: w.state, level: w.level, award: w.award, claimCode: w.claim_code }))
        });
    } catch (err) {
        console.error("Admin dashboard error:", err.message);
        res.status(500).send("Admin dashboard error: " + err.message);
    }
});
app.post("/admin/submit-subscription-report", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    try {
        const sch = req.session.schoolName || "General";
        const paidRes = await pool.query("SELECT DISTINCT u.first_name, u.last_name, u.email FROM users u JOIN subscriptions s ON u.id = s.user_id WHERE u.is_admin = FALSE AND TRIM(LOWER(u.school_name)) = TRIM(LOWER($1)) ORDER BY u.last_name ASC", [sch]);
        const namesList = paidRes.rows.map(r => `${r.first_name} ${r.last_name} (${r.email})`).join(", ") || "No paid students yet";
        await pool.query("ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS commission_settled BOOLEAN DEFAULT FALSE");
        await pool.query("CREATE TABLE IF NOT EXISTS school_reports (id SERIAL PRIMARY KEY, school_name VARCHAR(200), sender_email VARCHAR(200), subscribed_count INT, student_names TEXT, note TEXT, created_at TIMESTAMP DEFAULT NOW())");
        await pool.query("INSERT INTO school_reports (school_name, sender_email, subscribed_count, student_names, note) VALUES ($1,$2,$3,$4,$5)", [sch, req.session.user.email, paidRes.rows.length, namesList, req.body.note || "Subscription verification & commission report"]);
    } catch (e) { console.error("Report err:", e.message); }
    res.redirect("/admin/dashboard?reported=1");
});

app.post("/admin/settle-student-commission", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    const isSuper = req.session.isSuperAdmin || (req.session.user && req.session.user.email === "admin@school.com");
    if (!isSuper) return res.status(403).send("Unauthorized");
    const targetId = Number(req.body.targetUserId);
    if (targetId) {
        try {
            await pool.query("ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS commission_settled BOOLEAN DEFAULT FALSE");
            await pool.query("UPDATE subscriptions SET commission_settled = TRUE WHERE user_id = $1", [targetId]);
        } catch (e) { console.error("Settle err:", e.message); }
    }
    res.redirect("/admin/dashboard");
});

app.post("/admin/reset-user-password", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    const targetId = Number(req.body.targetUserId);
    const newPass = String(req.body.newPassword || "").trim();
    if (!targetId || newPass.length < 4) return res.redirect("/admin/dashboard");
    try {
        const isSuper = req.session.isSuperAdmin || (req.session.user && req.session.user.email === "admin@school.com");
        const sch = req.session.schoolName || "General";
        if (isSuper) {
            await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2 AND email != 'admin@school.com'", [newPass, targetId]);
        } else {
            await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2 AND is_admin = FALSE AND TRIM(LOWER(school_name)) = TRIM(LOWER($3))", [newPass, targetId, sch]);
        }
    } catch (e) { console.error("Admin reset err:", e.message); }
    res.redirect("/admin/dashboard");
});

app.post("/admin/update-school-subaccount", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    const isSuper = req.session.isSuperAdmin || (req.session.user && req.session.user.email === "admin@school.com");
    if (!isSuper) return res.status(403).send("Unauthorized");
    const adminId = Number(req.body.adminId);
    const subCode = String(req.body.paystackSubaccount || "").trim();
    if (adminId) {
        try {
            await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS paystack_subaccount VARCHAR(100)");
            await pool.query("UPDATE users SET paystack_subaccount = $1 WHERE id = $2", [subCode, adminId]);
        } catch (e) { console.error("Subaccount update err:", e.message); }
    }
    res.redirect("/admin/dashboard");
});

app.post("/admin/create-school-admin", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    const { schoolName, firstName, lastName, email, password, state } = req.body;
    try {
        await pool.query("INSERT INTO users (email, password_hash, first_name, last_name, state, school_name, is_admin, is_super_admin) VALUES ($1,$2,$3,$4,$5,$6,TRUE,FALSE)", [email.toLowerCase().trim(), password, firstName.trim(), lastName.trim(), state || "Delta State", schoolName.trim()]);
    } catch (e) { console.error("School admin err:", e.message); }
    res.redirect("/admin/dashboard");
});
app.post("/admin/add-winner", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    try {
        const students = (await pool.query("SELECT * FROM users WHERE is_admin = FALSE")).rows;
        const chosen = req.body.studentId === "RANDOM" ? students[Math.floor(Math.random() * students.length)] : students.find(s => String(s.id) === String(req.body.studentId));
        if (chosen) {
            const lastInit = chosen.last_name ? chosen.last_name.charAt(0).toUpperCase() + "." : "";
            await pool.query("INSERT INTO grant_winners (user_id, display_name, full_name, email, state, level, award, claim_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [chosen.id, `${chosen.first_name} ${lastInit}`.trim(), `${chosen.first_name} ${chosen.last_name}`.trim(), chosen.email, chosen.state || "Nigeria", req.body.level, req.body.award, "GRANT-" + Math.floor(100000 + Math.random() * 900000)]);
        }
        res.redirect("/admin/dashboard");
    } catch (err) { res.status(500).send("Error publishing winner."); }
});
app.post("/admin/remove-winner", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    await pool.query("DELETE FROM grant_winners WHERE id = $1", [req.body.winnerId]);
    res.redirect("/admin/dashboard");
});
app.post("/paystack/initialize", (req, res) => {
    if (!req.session.userId) return res.redirect("/login");
    const payload = JSON.stringify({ email: req.session.user.email, amount: 600000, currency: "NGN", callback_url: `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}/paystack/callback`, metadata: { user_id: req.session.userId, class_id: req.body.classId, term_number: req.body.termNumber } });
    const pReq = https.request({ hostname: "api.paystack.co", port: 443, path: "/transaction/initialize", method: "POST", headers: { "Authorization": "Bearer " + String(process.env.PAYSTACK_SECRET_KEY || "").trim(), "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (pRes) => {
        let chunks = []; pRes.on("data", c => chunks.push(c));
        pRes.on("end", () => { try { const d = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (d.status && d.data && d.data.authorization_url) return res.redirect(d.data.authorization_url); res.send("Paystack error: " + (d.message || "")); } catch (e) { res.status(500).send("Error"); } });
    });
    pReq.on("error", () => res.status(500).send("Network error")); pReq.write(payload); pReq.end();
});
app.get("/paystack/callback", (req, res) => {
    const ref = req.query.reference || req.query.trxref;
    if (!ref) return res.redirect("/dashboard");
    const vReq = https.request({ hostname: "api.paystack.co", port: 443, path: `/transaction/verify/${encodeURIComponent(ref)}`, method: "GET", headers: { "Authorization": "Bearer " + String(process.env.PAYSTACK_SECRET_KEY || "").trim() } }, (vRes) => {
        let chunks = []; vRes.on("data", c => chunks.push(c));
        vRes.on("end", async () => {
            try {
                const d = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (d.status && d.data && d.data.status === "success") {
                    const m = d.data.metadata || {}; const uid = Number(req.session.userId || m.user_id);
                    await unlockStudentTerm(uid, m.class_id || "PRIMARY_1", m.term_number || "1");
                    if (uid && !req.session.userId) {
                        const uRes = await pool.query("SELECT * FROM users WHERE id = $1", [uid]);
                        if (uRes.rows.length > 0) { const u = uRes.rows[0]; req.session.userId = u.id; req.session.isAdmin = u.is_admin || false; req.session.isSuperAdmin = u.is_super_admin || (u.email === 'admin@school.com'); req.session.schoolName = u.school_name || 'General'; req.session.user = { id: u.id, firstName: u.first_name, lastName: u.last_name, email: u.email, profilePicUrl: u.profile_pic_url || "" }; }
                    }
                }
            } catch (e) {}
            req.session.save(() => res.redirect("/dashboard"));
        });
    });
    vReq.on("error", () => res.redirect("/dashboard")); vReq.end();
});
app.post("/paystack/webhook", async (req, res) => {
    try { if (req.body && req.body.event === "charge.success" && req.body.data && req.body.data.metadata) await unlockStudentTerm(Number(req.body.data.metadata.user_id), req.body.data.metadata.class_id, req.body.data.metadata.term_number); } catch (e) {}
    res.sendStatus(200);
});
app.post("/upload-result", upload.single("resultDoc"), async (req, res) => {
    if (!req.session.userId || !req.file) return res.redirect("/dashboard");
    try {
        const up = await cloudinary.uploader.upload(req.file.path, { folder: "eduvault_results", resource_type: "auto" });
        const cid = String(req.body.classId).toUpperCase().trim(); const term = String(req.body.term).trim();
        await pool.query("DELETE FROM student_results WHERE user_id = $1 AND academic_class = $2 AND term_number = $3", [req.session.userId, cid, term]);
        await pool.query("INSERT INTO student_results (user_id, academic_class, term_number, file_name) VALUES ($1,$2,$3,$4)", [req.session.userId, cid, term, up.secure_url]);
    } catch (e) { console.error("Cloudinary err:", e.message); }
    return res.redirect("/dashboard");
});
app.post("/upload-result-legacy", upload.single("resultDoc"), async (req, res) => {
    if (!req.session.userId || !req.file) return res.redirect("/dashboard");
    const cid = String(req.body.classId).toUpperCase().trim(); const term = String(req.body.term).trim();
    await pool.query("DELETE FROM student_results WHERE user_id = $1 AND academic_class = $2 AND term_number = $3", [req.session.userId, cid, term]);
    await pool.query("INSERT INTO student_results (user_id, academic_class, term_number, file_name) VALUES ($1,$2,$3,$4)", [req.session.userId, cid, term, req.file.filename]);
    res.redirect("/dashboard");
});
app.post("/upload-profile-pic", upload.single("avatarFile"), async (req, res) => {
    if (!req.session.userId || !req.file) return res.redirect("/dashboard");
    try {
        const up = await cloudinary.uploader.upload(req.file.path, { folder: "eduvault_avatars", resource_type: "image" });
        await pool.query("UPDATE users SET profile_pic_url = $1 WHERE id = $2", [up.secure_url, req.session.userId]);
        req.session.user.profilePicUrl = up.secure_url;
    } catch (e) { console.error("Cloudinary avatar err:", e.message); }
    return res.redirect("/dashboard");
});
app.post("/upload-profile-pic-legacy", upload.single("avatarFile"), async (req, res) => {
    if (!req.session.userId || !req.file) return res.redirect("/dashboard");
    const url = "/download/" + req.file.filename;
    await pool.query("UPDATE users SET profile_pic_url = $1 WHERE id = $2", [url, req.session.userId]);
    req.session.user.profilePicUrl = url; res.redirect("/dashboard");
});
app.get("/unlock-paid", async (req, res) => {
    if (!req.session.userId) return res.redirect("/login");
    await unlockStudentTerm(req.session.userId, "PRIMARY_1", "1");
    res.redirect("/dashboard");
});

// WROUTES_START
app.post("/wallet/topup", (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const amt = Math.round(Number(req.body.amount || 0));
  if (isNaN(amt) || amt < 500 || amt > 50000) return res.redirect("/dashboard?wmsg=invalid");
  const payload = JSON.stringify({
    email: req.session.user.email,
    amount: amt * 100,
    currency: "NGN",
    callback_url: `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}/paystack/callback`,
    metadata: { purpose: "wallet_topup", user_id: req.session.userId }
  });
  const pReq = https.request({ hostname: "api.paystack.co", port: 443, path: "/transaction/initialize", method: "POST", headers: { Authorization: "Bearer " + String(process.env.PAYSTACK_SECRET_KEY || "").trim(), "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, pRes => {
    let c = []; pRes.on("data", x => c.push(x));
    pRes.on("end", () => { try { const d = JSON.parse(Buffer.concat(c).toString()); if (d.status && d.data && d.data.authorization_url) return res.redirect(d.data.authorization_url); res.redirect("/dashboard?wmsg=err"); } catch (e) { res.redirect("/dashboard?wmsg=err"); } });
  });
  pReq.on("error", () => res.redirect("/dashboard?wmsg=err"));
  pReq.write(payload); pReq.end();
});
app.post("/wallet/unlock-term", async (req, res) => {
  if (!req.session.userId) return res.redirect("/login");
  const cid = String(req.body.classId || "").trim().toUpperCase(), tn = String(req.body.termNumber || "").trim();
  if (!cid || !["1", "2", "3"].includes(tn)) return res.redirect("/dashboard?wmsg=err");
  try {
    const sub = await pool.query("SELECT 1 FROM subscriptions WHERE user_id = $1 AND academic_class = $2 AND term_number = $3", [req.session.userId, cid, tn]);
    if (sub.rows.length > 0) return res.redirect("/dashboard?wmsg=already");
    const ded = await pool.query("UPDATE users SET wallet_balance = wallet_balance - 6000 WHERE id = $1 AND COALESCE(wallet_balance, 0) >= 6000 RETURNING wallet_balance", [req.session.userId]);
    if (ded.rows.length === 0) return res.redirect("/dashboard?wmsg=low");
    await pool.query("INSERT INTO wallet_ledger (user_id, reference, amount, kind, note) VALUES ($1, $2, $3, $4, $5)", [req.session.userId, "ULK-" + req.session.userId + "-" + Date.now(), -6000, "UNLOCK", "Unlocked " + cid + " T" + tn]);
    await unlockStudentTerm(req.session.userId, cid, tn);
    res.redirect("/dashboard?wmsg=unlocked");
  } catch (e) { res.redirect("/dashboard?wmsg=err"); }
});
// WROUTES_END
app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
app.listen(process.env.PORT || 3000, () => console.log("Server running"));
















































