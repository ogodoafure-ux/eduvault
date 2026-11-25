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
            ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE; ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE; ALTER TABLE users ADD COLUMN IF NOT EXISTS school_name VARCHAR(200) DEFAULT 'General'; ALTER TABLE users ADD COLUMN IF NOT EXISTS paystack_subaccount VARCHAR(100); UPDATE users SET is_super_admin = TRUE WHERE email = 'admin@school.com';
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
                                const m = tx.metadata || {};
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
    try {
        await pool.query("CREATE TABLE IF NOT EXISTS contact_messages (id SERIAL PRIMARY KEY, name VARCHAR(150), phone VARCHAR(100), topic VARCHAR(150), message TEXT, created_at TIMESTAMP DEFAULT NOW())");
        await pool.query("INSERT INTO contact_messages (name, phone, topic, message) VALUES ($1,$2,$3,$4)", [req.body.name, req.body.phone, req.body.topic, req.body.message]);
    } catch (e) {}
    res.render("contact", { sent: true });
});

app.get("/forgot-password", (req, res) => res.render("forgot-password", { error: null, success: null }));
app.post("/forgot-password", async (req, res) => {
    const email = String(req.body.email || "").toLowerCase().trim();
    const lastName = String(req.body.lastName || "").trim();
    const newPassword = String(req.body.newPassword || "").trim();
    if (!email || !lastName || newPassword.length < 4) {
        return res.render("forgot-password", { error: "Please fill in all fields (minimum 4 characters for password).", success: null });
    }
    try {
        const check = await pool.query("SELECT id FROM users WHERE LOWER(email) = $1 AND TRIM(LOWER(last_name)) = TRIM(LOWER($2))", [email, lastName]);
        if (check.rows.length === 0) {
            return res.render("forgot-password", { error: "No account matched that Email and Last Name combination.", success: null });
        }
        await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [newPassword, check.rows[0].id]);
        return res.render("forgot-password", { error: null, success: "✓ Password updated successfully!" });
    } catch (e) {
        return res.render("forgot-password", { error: "Unable to reset password right now. Please try again.", success: null });
    }
});

app.post("/submit-review", async (req, res) => {
    const authorName = String(req.body.authorName || "").trim().slice(0, 80);
    const roleLabel = String(req.body.roleLabel || "Parent").trim().slice(0, 60);
    const stateName = String(req.body.stateName || "Delta State").trim().slice(0, 60);
    const rating = Math.min(5, Math.max(1, Number(req.body.rating || 5)));
    const comment = String(req.body.comment || "").trim().slice(0, 500);
    if (authorName && comment) {
        try {
            await pool.query("CREATE TABLE IF NOT EXISTS site_reviews (id SERIAL PRIMARY KEY, author_name VARCHAR(120), role_label VARCHAR(120), state_name VARCHAR(80), rating INT DEFAULT 5, comment TEXT, approved BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())");
            await pool.query("INSERT INTO site_reviews (author_name, role_label, state_name, rating, comment, approved) VALUES ($1,$2,$3,$4,$5,FALSE)", [authorName, roleLabel, stateName, rating, comment]);
        } catch (e) { console.error("Review err:", e.message); }
    }
    res.redirect("/?reviewSent=1#community-reviews");
});

app.post("/admin/toggle-review", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    const isSuper = req.session.isSuperAdmin || (req.session.user && req.session.user.email === "admin@school.com");
    if (!isSuper) return res.status(403).send("Unauthorized");
    const revId = Number(req.body.revId);
    const action = String(req.body.action || "");
    if (revId) {
        try {
            if (action === "approve") await pool.query("UPDATE site_reviews SET approved = TRUE WHERE id = $1", [revId]);
            if (action === "delete") await pool.query("DELETE FROM site_reviews WHERE id = $1", [revId]);
        } catch (e) {}
    }
    res.redirect("/admin/dashboard");
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

app.get("/register", (req, res) => res.render("register"));
app.post("/register", async (req, res) => {
    const { email, password, firstName, lastName, role, state, schoolName } = req.body;
    try {
        await pool.query("INSERT INTO users (email, password_hash, first_name, last_name, state, school_name, is_admin) VALUES ($1,$2,$3,$4,$5,$6,$7)", [email.toLowerCase().trim(), password, firstName.trim(), lastName.trim(), state || "Nigeria", (schoolName || "General").trim(), role === "registry" || role === "admin"]);
        res.redirect("/login");
    } catch (err) { console.error('Register err:', err.message); res.send('<h2>Registration error: ' + err.message + ' <a href="/register">Try again</a>.</h2>'); }
});
app.get("/dashboard", async (req, res) => {
    if (!req.session.userId || req.session.isAdmin) return res.redirect("/login");
    try {
        await syncPaystackPaymentsForEmail(req.session.userId, req.session.user && req.session.user.email);
        const subRes = await pool.query("SELECT academic_class FROM subscriptions WHERE user_id = $1", [req.session.userId]);
        const resQuery = await pool.query("SELECT academic_class, term_number, file_name FROM student_results WHERE user_id = $1", [req.session.userId]);
        const savedResults = {}; resQuery.rows.forEach(r => { savedResults[r.academic_class + "_TERM_" + r.term_number] = r.file_name; });
        const winQuery = await pool.query("SELECT * FROM grant_winners WHERE user_id = $1 LIMIT 1", [req.session.userId]);
        const myWin = winQuery.rows.length > 0 ? { award: winQuery.rows[0].award, level: winQuery.rows[0].level, claimCode: winQuery.rows[0].claim_code } : null;
        res.render("dashboard", { user: req.session.user, unlockedClasses: subRes.rows.map(r => r.academic_class), savedResults, publicKey: (process.env.PAYSTACK_PUBLIC_KEY || "").trim(), myWin });
    } catch (err) { res.status(500).send("Error loading dashboard."); }
});
app.get("/admin/dashboard", async (req, res) => {
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
            ? await pool.query("SELECT id, first_name, last_name, email, school_name, paystack_subaccount FROM users WHERE is_admin = TRUE AND email != 'admin@school.com' ORDER BY school_name ASC")
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

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
app.listen(process.env.PORT || 3000, () => console.log("Server running"));

























