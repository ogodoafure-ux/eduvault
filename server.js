require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const session = require("express-session");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const https = require("https");
const app = express();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                first_name VARCHAR(100),
                last_name VARCHAR(100),
                state VARCHAR(100) DEFAULT 'Nigeria',
                profile_pic_url VARCHAR(255),
                is_admin BOOLEAN DEFAULT FALSE
            );
            ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Nigeria';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_pic_url VARCHAR(255);
            ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS state VARCHAR(100) DEFAULT 'Nigeria';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_pic_url VARCHAR(255);
            CREATE TABLE IF NOT EXISTS subscriptions (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                academic_class VARCHAR(255),
                CONSTRAINT unique_user_class UNIQUE(user_id, academic_class)
            );
            CREATE TABLE IF NOT EXISTS student_results (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                academic_class VARCHAR(255),
                term_number VARCHAR(50),
                file_name VARCHAR(255),
                CONSTRAINT unique_student_term UNIQUE(user_id, academic_class, term_number)
            );
            CREATE TABLE IF NOT EXISTS grant_winners (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                display_name VARCHAR(150),
                full_name VARCHAR(200),
                email VARCHAR(255),
                state VARCHAR(100),
                level VARCHAR(100),
                award VARCHAR(200),
                claim_code VARCHAR(50)
            );
        `);
        await pool.query(
            `INSERT INTO users (email, password_hash, first_name, last_name, state, is_admin)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (email) DO NOTHING`,
            ["admin@school.com", "admin123", "Principal", "Alimi", "Delta State", true]
        );
        console.log("Cloud database tables verified!");
    } catch (err) {
        console.error("Database init notice:", err.message);
    }
}
initDB();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set("view engine", "ejs");
app.use("/download", express.static(path.join(__dirname, "uploads")));
app.use(session({
    secret: process.env.SESSION_SECRET || "eduvault_production_secret_2026",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync("./uploads")) fs.mkdirSync("./uploads");
        cb(null, "./uploads");
    },
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });
app.get("/", async (req, res) => {
    try {
        const wRes = await pool.query("SELECT * FROM grant_winners ORDER BY id DESC");
        const winners = wRes.rows.map(w => ({ id: w.id, userId: w.user_id, displayName: w.display_name, state: w.state, level: w.level, award: w.award }));
        res.render("index", { winners });
    } catch (e) { res.render("index", { winners: [] }); }
});

app.get("/login", (req, res) => res.render("login"));
app.get("/admin", (req, res) => res.redirect("/admin/dashboard"));

app.post("/login", async (req, res) => {
    const email = String(req.body.email || "").toLowerCase().trim();
    try {
        const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        if (result.rows.length > 0 && req.body.password === result.rows[0].password_hash) {
            const user = result.rows[0];
            req.session.userId = user.id;
            req.session.isAdmin = user.is_admin || false;
            req.session.user = { id: user.id, firstName: user.first_name, lastName: user.last_name, email: user.email, profilePicUrl: user.profile_pic_url || "" };
            return res.redirect(req.session.isAdmin ? "/admin/dashboard" : "/dashboard");
        }
        res.send("<h2>Invalid credentials. <a href='/login'>Try again</a>.</h2>");
    } catch (err) { res.status(500).send("Database connection error."); }
});

app.get("/register", (req, res) => res.render("register"));
app.post("/register", async (req, res) => {
    const { email, password, firstName, lastName, role, state } = req.body;
    try {
        await pool.query(
            "INSERT INTO users (email, password_hash, first_name, last_name, state, is_admin) VALUES ($1, $2, $3, $4, $5, $6)",
            [email.toLowerCase().trim(), password, firstName.trim(), lastName.trim(), state || "Nigeria", role === "registry" || role === "admin"]
        );
        res.redirect("/login");
    } catch (err) { res.send("<h2>Email already registered or database error. <a href='/register'>Try again</a>.</h2>"); }
});

app.get("/dashboard", async (req, res) => {
    if (!req.session.userId || req.session.isAdmin) return res.redirect("/login");
    try {
        const subRes = await pool.query("SELECT academic_class FROM subscriptions WHERE user_id = $1", [req.session.userId]);
        const unlockedClasses = subRes.rows.map(r => r.academic_class);
        const resQuery = await pool.query("SELECT academic_class, term_number, file_name FROM student_results WHERE user_id = $1", [req.session.userId]);
        const savedResults = {};
        resQuery.rows.forEach(r => { savedResults[r.academic_class + "_TERM_" + r.term_number] = r.file_name; });
        const winQuery = await pool.query("SELECT * FROM grant_winners WHERE user_id = $1 LIMIT 1", [req.session.userId]);
        const myWin = winQuery.rows.length > 0 ? { award: winQuery.rows[0].award, level: winQuery.rows[0].level, claimCode: winQuery.rows[0].claim_code } : null;
        res.render("dashboard", { user: req.session.user, unlockedClasses, savedResults, publicKey: (process.env.PAYSTACK_PUBLIC_KEY || "").trim(), myWin });
    } catch (err) { res.status(500).send("Error loading dashboard."); }
});

app.get("/admin/dashboard", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    try {
        const resQuery = await pool.query("SELECT r.file_name, r.academic_class, r.term_number, u.first_name, u.last_name, u.email FROM student_results r JOIN users u ON r.user_id = u.id ORDER BY u.last_name ASC");
        const stuQuery = await pool.query("SELECT id, first_name, last_name, email FROM users WHERE is_admin = FALSE ORDER BY first_name ASC");
        const winQuery = await pool.query("SELECT * FROM grant_winners ORDER BY id DESC");
        const winners = winQuery.rows.map(w => ({ id: w.id, displayName: w.display_name, fullName: w.full_name, email: w.email, state: w.state, level: w.level, award: w.award, claimCode: w.claim_code }));
        res.render("admin-dashboard", { user: req.session.user, uploadedResults: resQuery.rows, students: stuQuery.rows, winners });
    } catch (err) { res.status(500).send("Error loading admin dashboard."); }
});

app.post("/admin/add-winner", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    const { studentId, award, level } = req.body;
    try {
        const stuQuery = await pool.query("SELECT * FROM users WHERE is_admin = FALSE");
        const students = stuQuery.rows;
        const chosen = studentId === "RANDOM" ? students[Math.floor(Math.random() * students.length)] : students.find(s => String(s.id) === String(studentId));
        if (chosen) {
            const lastInit = chosen.last_name ? chosen.last_name.charAt(0).toUpperCase() + "." : "";
            const claimCode = "GRANT-" + Math.floor(100000 + Math.random() * 900000);
            await pool.query(
                "INSERT INTO grant_winners (user_id, display_name, full_name, email, state, level, award, claim_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                [chosen.id, `${chosen.first_name} ${lastInit}`.trim(), `${chosen.first_name} ${chosen.last_name}`.trim(), chosen.email, chosen.state || "Nigeria", level, award, claimCode]
            );
        }
        res.redirect("/admin/dashboard");
    } catch (err) { res.status(500).send("Error publishing winner."); }
});

app.post("/admin/remove-winner", async (req, res) => {
    if (!req.session.userId || !req.session.isAdmin) return res.redirect("/login");
    try {
        await pool.query("DELETE FROM grant_winners WHERE id = $1", [req.body.winnerId]);
        res.redirect("/admin/dashboard");
    } catch (err) { res.status(500).send("Error removing winner."); }
});

app.post("/paystack/initialize", (req, res) => {
    if (!req.session.userId) return res.redirect("/login");
    const { classId, termNumber } = req.body;
    const host = req.get("host");
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const callbackUrl = `${proto}://${host}/paystack/callback?classId=${encodeURIComponent(classId)}&termNumber=${encodeURIComponent(termNumber)}`;
    const payload = JSON.stringify({
        email: req.session.user.email,
        amount: 600000,
        currency: "NGN",
        callback_url: callbackUrl
    });
    const options = {
        hostname: "api.paystack.co",
        port: 443,
        path: "/transaction/initialize",
        method: "POST",
        headers: {
            "Authorization": "Bearer " + String(process.env.PAYSTACK_SECRET_KEY || "").trim(),
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
        }
    };
    const pReq = https.request(options, (pRes) => {
        let chunks = [];
        pRes.on("data", c => chunks.push(c));
        pRes.on("end", () => {
            try {
                const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (data.status && data.data && data.data.authorization_url) {
                    return res.redirect(data.data.authorization_url);
                }
                res.send("<h2>Paystack initialization error: " + (data.message || "Check Secret Key") + " <a href='/dashboard'>Back</a></h2>");
            } catch (e) { res.status(500).send("Payment gateway error."); }
        });
    });
    pReq.on("error", () => res.status(500).send("Network error connecting to Paystack."));
    pReq.write(payload);
    pReq.end();
});

app.get("/paystack/callback", (req, res) => {
    if (!req.session.userId) return res.redirect("/login");
    const { reference, classId, termNumber } = req.query;
    if (!reference) return res.redirect("/dashboard");
    const options = {
        hostname: "api.paystack.co",
        port: 443,
        path: `/transaction/verify/${encodeURIComponent(reference)}`,
        method: "GET",
        headers: { "Authorization": "Bearer " + String(process.env.PAYSTACK_SECRET_KEY || "").trim() }
    };
    const vReq = https.request(options, (vRes) => {
        let chunks = [];
        vRes.on("data", c => chunks.push(c));
        vRes.on("end", async () => {
            try {
                const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (data.status && data.data && data.data.status === "success") {
                    const key = String(classId).toUpperCase().trim() + "_TERM_" + String(termNumber).trim();
                    await pool.query("INSERT INTO subscriptions (user_id, academic_class) VALUES ($1, $2) ON CONFLICT (user_id, academic_class) DO NOTHING", [req.session.userId, key]);
                }
            } catch (e) {}
            res.redirect("/dashboard");
        });
    });
    vReq.on("error", () => res.redirect("/dashboard"));
    vReq.end();
});

app.post("/verify-inline-payment", (req, res) => {
    if (!req.session.userId) return res.sendStatus(401);
    const { classId, termNumber, reference } = req.body;
    const options = {
        hostname: "api.paystack.co", port: 443, path: `/transaction/verify/${encodeURIComponent(reference)}`, method: "GET",
        headers: { "Authorization": "Bearer " + String(process.env.PAYSTACK_SECRET_KEY || "").trim() }
    };
    const vReq = https.request(options, (vRes) => {
        let chunks = [];
        vRes.on("data", c => chunks.push(c));
        vRes.on("end", async () => {
            try {
                const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (data.status && data.data && data.data.status === "success") {
                    const key = String(classId).toUpperCase().trim() + "_TERM_" + String(termNumber).trim();
                    await pool.query("INSERT INTO subscriptions (user_id, academic_class) VALUES ($1, $2) ON CONFLICT (user_id, academic_class) DO NOTHING", [req.session.userId, key]);
                    return res.sendStatus(200);
                }
                res.sendStatus(400);
            } catch (e) { res.sendStatus(500); }
        });
    });
    vReq.on("error", () => res.sendStatus(500));
    vReq.end();
});

app.post("/upload-result", upload.single("resultDoc"), async (req, res) => {
    if (!req.session.userId || !req.file) return res.redirect("/dashboard");
    try {
        await pool.query(
            "INSERT INTO student_results (user_id, academic_class, term_number, file_name) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, academic_class, term_number) DO UPDATE SET file_name = EXCLUDED.file_name",
            [req.session.userId, String(req.body.classId).toUpperCase(), String(req.body.term), req.file.filename]
        );
        res.redirect("/dashboard");
    } catch (e) { res.status(500).send("Error saving result."); }
});

app.post("/upload-profile-pic", upload.single("avatarFile"), async (req, res) => {
    if (!req.session.userId || !req.file) return res.redirect("/dashboard");
    const url = "/download/" + req.file.filename;
    try {
        await pool.query("UPDATE users SET profile_pic_url = $1 WHERE id = $2", [url, req.session.userId]);
        req.session.user.profilePicUrl = url;
    } catch (e) {}
    res.redirect("/dashboard");
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));



