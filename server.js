
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const qrcode = require('qrcode');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Helper functions
const query = (text, params) => pool.query(text, params);
const queryOne = async (text, params) => {
    const result = await pool.query(text, params);
    return result.rows[0] || null;
};

// Create tables with error handling
async function initDatabase() {
    console.log('🔄 Initializing database...');
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS vendors (
                id SERIAL PRIMARY KEY,
                business_name TEXT NOT NULL,
                owner_name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                phone TEXT NOT NULL,
                password TEXT NOT NULL,
                logo_url TEXT,
                is_suspended INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ vendors table ready');

        await client.query(`
            CREATE TABLE IF NOT EXISTS menu_items (
                id SERIAL PRIMARY KEY,
                vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                description TEXT,
                photo_url TEXT,
                is_available INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ menu_items table ready');

        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
                order_number TEXT UNIQUE NOT NULL,
                customer_name TEXT,
                customer_phone TEXT,
                items_json TEXT NOT NULL,
                total DECIMAL(10,2) NOT NULL,
                payment_method TEXT CHECK(payment_method IN ('card', 'cash')) NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ orders table ready');

        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL
            )
        `);
        console.log('✅ admin_users table ready');

        await client.query(`
            CREATE TABLE IF NOT EXISTS sponsor_ads (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                image_url TEXT,
                link_url TEXT,
                is_active INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ sponsor_ads table ready');

        // Create default admin user
        const bcrypt = require('bcrypt');
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        await client.query(`
            INSERT INTO admin_users (username, password) 
            VALUES ('admin', $1)
            ON CONFLICT (username) DO NOTHING
        `, [hashedPassword]);

        // Check if any vendors exist
        const vendorCheck = await client.query(`SELECT COUNT(*) FROM vendors`);
        console.log(`📊 Vendors in database: ${vendorCheck.rows[0].count}`);

        console.log('✅ Lite tables ready in PostgreSQL');
    } catch (err) {
        console.error('❌ Database init error:', err.message);
    } finally {
        client.release();
    }
}

// Run init
initDatabase();

// Ensure uploads folder exists
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// Multer for file uploads
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(session({
    secret: 'khezwo-lite-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const getBaseUrl = () => process.env.BASE_URL || `http://localhost:${PORT}`;

// ============= ROUTES =============

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============= CUSTOMER MENU ROUTE =============
app.get('/menu/:vendorId', async (req, res) => {
    try {
        const vendorId = req.params.vendorId;
        console.log(`🔍 Looking for vendor ID: ${vendorId}`);
        
        const vendor = await queryOne(`SELECT * FROM vendors WHERE id = $1`, [vendorId]);
        
        if (!vendor) {
            console.log(`❌ Vendor ${vendorId} not found`);
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Vendor Not Found - KheZwo Lite</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                        .card { max-width: 400px; margin: 0 auto; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 5px 20px rgba(0,0,0,0.1); }
                        h1 { color: #667eea; }
                        .btn { display: inline-block; background: #667eea; color: white; padding: 12px 30px; border-radius: 30px; text-decoration: none; margin-top: 20px; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>🍽️ Vendor Not Found</h1>
                        <p>The QR code you scanned is not valid or the vendor is no longer active.</p>
                        <a href="/" class="btn">Go Home</a>
                    </div>
                </body>
                </html>
            `);
        }
        
        console.log(`✅ Vendor found: ${vendor.business_name} (ID: ${vendor.id})`);
        res.sendFile(path.join(__dirname, 'public', 'customer-menu.html'));
    } catch (err) {
        console.error('❌ Menu route error:', err);
        res.status(500).send('Server error');
    }
});

// ============= API ROUTES =============

// Vendor Signup
app.post('/api/vendor/signup', async (req, res) => {
    const { business_name, owner_name, email, phone, password } = req.body;
    
    if (!business_name || !owner_name || !email || !phone || !password) {
        return res.status(400).json({ error: 'All fields required' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await query(
            `INSERT INTO vendors (business_name, owner_name, email, phone, password) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [business_name, owner_name, email, phone, hashedPassword]
        );
        
        const vendorId = result.rows[0].id;
        const baseUrl = getBaseUrl();
        const qrUrl = `${baseUrl}/menu/${vendorId}`;
        qrcode.toFile(`./uploads/qr_${vendorId}.png`, qrUrl, () => {});
        
        console.log(`✅ New vendor created: ${business_name} (ID: ${vendorId})`);
        res.json({ success: true, vendor_id: vendorId });
    } catch (err) {
        if (err.constraint === 'vendors_email_key') {
            return res.status(400).json({ error: 'Email already registered' });
        }
        console.error('❌ Signup error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Vendor Login
app.post('/api/vendor/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const result = await query(`SELECT * FROM vendors WHERE email = $1`, [email]);
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        const vendor = result.rows[0];
        const valid = await bcrypt.compare(password, vendor.password);
        if (!valid) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        req.session.vendor = vendor;
        console.log(`✅ Vendor logged in: ${vendor.business_name} (ID: ${vendor.id})`);
        res.json({ success: true, redirect: '/vendor-dashboard.html' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/vendor/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Get vendor data
app.get('/api/vendor/data', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    
    try {
        const vendor = await queryOne(`SELECT * FROM vendors WHERE id = $1`, [vendorId]);
        const menuItems = await query(`SELECT * FROM menu_items WHERE vendor_id = $1 ORDER BY id DESC`, [vendorId]);
        const orders = await query(`SELECT * FROM orders WHERE vendor_id = $1 AND status != 'completed' ORDER BY created_at DESC`, [vendorId]);
        
        res.json({
            vendor: vendor,
            menu_items: menuItems.rows || [],
            orders: orders.rows || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// QR Code endpoints
app.get('/api/vendor/qr-code', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    const baseUrl = getBaseUrl();
    const qrUrl = `${baseUrl}/menu/${vendorId}`;
    
    try {
        const qrBase64 = await qrcode.toDataURL(qrUrl, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 300
        });
        res.json({ success: true, qrBase64: qrBase64 });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

app.get('/api/vendor/regenerate-qr', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    const baseUrl = getBaseUrl();
    const qrUrl = `${baseUrl}/menu/${vendorId}`;
    
    try {
        await qrcode.toFile(`./uploads/qr_${vendorId}.png`, qrUrl, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 300
        });
        const qrBase64 = await qrcode.toDataURL(qrUrl, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 300
        });
        res.json({ success: true, qrBase64: qrBase64 });
    } catch (err) {
        res.status(500).json({ error: 'Failed to regenerate QR code' });
    }
});

// Add menu item
app.post('/api/vendor/add-menu-item', upload.single('photo'), async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { name, price, description } = req.body;
    const photoUrl = req.file ? `/uploads/${req.file.filename}` : null;
    
    try {
        await query(
            `INSERT INTO menu_items (vendor_id, name, price, description, photo_url) 
             VALUES ($1, $2, $3, $4, $5)`,
            [req.session.vendor.id, name, price, description, photoUrl]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle availability
app.post('/api/vendor/toggle-availability', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { item_id, is_available } = req.body;
    
    try {
        await query(
            `UPDATE menu_items SET is_available = $1 WHERE id = $2 AND vendor_id = $3`,
            [is_available, item_id, req.session.vendor.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update vendor profile
app.post('/api/vendor/update-profile', upload.single('logo'), async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { business_name, owner_name, phone } = req.body;
    const logoUrl = req.file ? `/uploads/${req.file.filename}` : null;
    
    try {
        let queryText = `UPDATE vendors SET business_name = $1, owner_name = $2, phone = $3`;
        let params = [business_name, owner_name, phone];
        if (logoUrl) {
            queryText += `, logo_url = $4 WHERE id = $5`;
            params.push(logoUrl, req.session.vendor.id);
        } else {
            queryText += ` WHERE id = $4`;
            params.push(req.session.vendor.id);
        }
        
        await query(queryText, params);
        const vendor = await queryOne(`SELECT * FROM vendors WHERE id = $1`, [req.session.vendor.id]);
        req.session.vendor = vendor;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update order status
app.post('/api/vendor/update-order-status', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { order_id, status } = req.body;
    
    try {
        await query(
            `UPDATE orders SET status = $1 WHERE id = $2 AND vendor_id = $3`,
            [status, order_id, req.session.vendor.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Place order
app.post('/api/place-order', async (req, res) => {
    const { vendor_id, customer_name, customer_phone, items, total, payment_method } = req.body;
    
    const orderNumber = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    
    try {
        await query(
            `INSERT INTO orders (vendor_id, order_number, customer_name, customer_phone, items_json, total, payment_method) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [vendor_id, orderNumber, customer_name, customer_phone, JSON.stringify(items), total, payment_method]
        );
        res.json({ success: true, order_number: orderNumber });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check notifications
app.get('/api/vendor/check-notifications', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    
    try {
        const orders = await query(
            `SELECT * FROM orders WHERE vendor_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 5`,
            [vendorId]
        );
        res.json({ orders: orders.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Order history
app.get('/api/vendor/order-history', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const vendorId = req.session.vendor.id;
    
    try {
        const orders = await query(
            `SELECT * FROM orders WHERE vendor_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 100`,
            [vendorId]
        );
        res.json(orders.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Menu API
app.get('/api/menu/:vendorId', async (req, res) => {
    const vendorId = req.params.vendorId;
    
    try {
        const vendor = await queryOne(`SELECT * FROM vendors WHERE id = $1`, [vendorId]);
        if (!vendor) {
            return res.status(404).json({ error: 'Vendor not found' });
        }
        
        const items = await query(
            `SELECT * FROM menu_items WHERE vendor_id = $1 AND is_available = 1 ORDER BY id DESC`,
            [vendorId]
        );
        
        const ad = await queryOne(
            `SELECT * FROM sponsor_ads WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1`
        );
        
        res.json({
            vendor: {
                id: vendor.id,
                business_name: vendor.business_name,
                logo_url: vendor.logo_url
            },
            menu_items: items.rows || [],
            sponsor_ad: ad || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Setup admin
app.post('/api/setup-admin', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password || password.length < 6) {
        return res.status(400).json({ error: 'Invalid username or password' });
    }
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await query(
            'INSERT INTO admin_users (username, password) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET password = $2',
            [username, hashedPassword]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============= ADMIN ROUTES =============

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const result = await query(`SELECT * FROM admin_users WHERE username = $1`, [username]);
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        const admin = result.rows[0];
        const valid = await bcrypt.compare(password, admin.password);
        if (!valid) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        req.session.admin = admin;
        res.json({ success: true, redirect: '/admin-dashboard.html' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/vendors', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const vendors = await query(`SELECT * FROM vendors ORDER BY created_at DESC`);
        res.json(vendors.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/toggle-vendor', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { vendor_id, is_suspended } = req.body;
    
    try {
        await query(
            `UPDATE vendors SET is_suspended = $1 WHERE id = $2`,
            [is_suspended ? 1 : 0, vendor_id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Sponsor Ads
app.get('/api/admin/sponsor-ads', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const ads = await query(`SELECT * FROM sponsor_ads ORDER BY created_at DESC`);
        res.json(ads.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/add-sponsor-ad', upload.single('image'), async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { name, link_url } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
    
    try {
        await query(
            `INSERT INTO sponsor_ads (name, image_url, link_url) VALUES ($1, $2, $3)`,
            [name, imageUrl, link_url]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/delete-sponsor-ad/:id', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { id } = req.params;
    
    try {
        await query(`DELETE FROM sponsor_ads WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/toggle-sponsor-ad', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { ad_id, is_active } = req.body;
    
    try {
        await query(
            `UPDATE sponsor_ads SET is_active = $1 WHERE id = $2`,
            [is_active ? 1 : 0, ad_id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const vendors = await queryOne(`SELECT COUNT(*) as count FROM vendors`);
        const orders = await queryOne(`SELECT COUNT(*) as count FROM orders`);
        const pendingOrders = await queryOne(`SELECT COUNT(*) as count FROM orders WHERE status = 'pending'`);
        const activeAds = await queryOne(`SELECT COUNT(*) as count FROM sponsor_ads WHERE is_active = 1`);
        
        res.json({
            total_vendors: parseInt(vendors?.count) || 0,
            total_orders: parseInt(orders?.count) || 0,
            pending_orders: parseInt(pendingOrders?.count) || 0,
            active_ads: parseInt(activeAds?.count) || 0
        });
    } catch (err) {
        res.json({ total_vendors: 0, total_orders: 0, pending_orders: 0, active_ads: 0 });
    }
});

app.listen(PORT, () => {
    console.log(`\n✅ KheZwo Lite is running!`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`\n📋 Admin: username "admin" | password "admin123"`);
    console.log(`🎉 Ready to go!\n`);
});
