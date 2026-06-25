const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const qrcode = require('qrcode');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ CORS CONFIGURATION ============
// Allow your Emergent preview URL and other origins
const allowedOrigins = [
    'https://app-builder-7943.preview.emergentagent.com',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:8080',
    'https://khezwo-lite.onrender.com',
    'exp://localhost:19000',
    'exp://192.168.1.*:19000',
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('Blocked CORS from:', origin);
            callback(null, true); // Allow all for testing
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
}));

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

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// File upload validation
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only images allowed.'), false);
    }
};

// Create tables
async function initDatabase() {
    console.log('🔄 Initializing database...');
    const client = await pool.connect();
    try {
        // Add is_active column to sponsor_ads if it doesn't exist
        try {
            await client.query(`
                ALTER TABLE sponsor_ads ADD COLUMN IF NOT EXISTS is_active INTEGER DEFAULT 1
            `);
        } catch (err) {}

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
                push_token TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

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

        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL
            )
        `);

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

        await client.query(`
            CREATE TABLE IF NOT EXISTS feedback (
                id SERIAL PRIMARY KEY,
                vendor_id INTEGER REFERENCES vendors(id),
                customer_name TEXT,
                customer_email TEXT,
                customer_phone TEXT,
                message TEXT NOT NULL,
                rating INTEGER DEFAULT 5,
                status TEXT DEFAULT 'new',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('✅ Tables ready');
    } catch (err) {
        console.error('❌ Database init error:', err.message);
    } finally {
        client.release();
    }
}

initDatabase();

// Ensure uploads folder exists
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// File upload with validation
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: fileFilter
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'khezwo-lite-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: false,
        sameSite: 'lax'
    }
}));

const getBaseUrl = () => process.env.BASE_URL || `http://localhost:${PORT}`;

// ============= ROUTES =============

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Customer Menu Route
app.get('/menu/:vendorId', async (req, res) => {
    try {
        const vendorId = req.params.vendorId;
        const vendor = await queryOne(`SELECT * FROM vendors WHERE id = $1`, [vendorId]);
        
        if (!vendor) {
            const allVendors = await query(`SELECT id, business_name FROM vendors ORDER BY id`);
            
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
                        .vendor-list { text-align: left; margin-top: 20px; padding: 10px; background: #f8f9fa; border-radius: 10px; font-size: 14px; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>🍽️ Vendor Not Found</h1>
                        <p>The QR code you scanned is not valid or the vendor is no longer active.</p>
                        <div class="vendor-list">
                            <p><strong>Available vendors:</strong></p>
                            <p>${allVendors.rows.map(v => `ID ${escapeHtml(String(v.id))}: ${escapeHtml(v.business_name)}`).join('<br>') || 'No vendors found'}</p>
                        </div>
                        <a href="/" class="btn">Go Home</a>
                    </div>
                </body>
                </html>
            `);
        }
        
        res.sendFile(path.join(__dirname, 'public', 'customer-menu.html'));
    } catch (err) {
        console.error('❌ Menu route error:', err);
        res.status(500).send('Server error');
    }
});

// ============= API ROUTES =============

// Vendor Signup
app.post('/api/vendor/signup', async (req, res) => {
    console.log('📝 Signup request received:', req.body.email);
    const { business_name, owner_name, email, phone, password } = req.body;
    
    if (!business_name || !owner_name || !email || !phone || !password) {
        return res.status(400).json({ error: 'All fields required' });
    }
    
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    
    const sanitizedBusiness = business_name.replace(/[<>]/g, '');
    const sanitizedName = owner_name.replace(/[<>]/g, '');
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await query(
            `INSERT INTO vendors (business_name, owner_name, email, phone, password) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [sanitizedBusiness, sanitizedName, email, phone, hashedPassword]
        );
        
        const vendorId = result.rows[0].id;
        const baseUrl = getBaseUrl();
        const qrUrl = `${baseUrl}/menu/${vendorId}`;
        qrcode.toFile(`./uploads/qr_${vendorId}.png`, qrUrl, () => {});
        
        console.log(`✅ New vendor: ${sanitizedBusiness} (ID: ${vendorId})`);
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
    console.log('🔑 Login attempt:', email);
    
    try {
        const result = await query(`SELECT * FROM vendors WHERE email = $1`, [email]);
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        const vendor = result.rows[0];
        
        if (vendor.is_suspended === 1) {
            return res.status(403).json({ error: 'Account suspended. Please contact support.' });
        }
        
        const valid = await bcrypt.compare(password, vendor.password);
        if (!valid) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        req.session.vendor = vendor;
        console.log(`✅ Vendor logged in: ${vendor.business_name} (ID: ${vendor.id})`);
        res.json({ success: true, redirect: '/vendor-dashboard.html' });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/vendor/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Get vendor data (MUST BE BEFORE /api/vendor/:id routes)
app.get('/api/vendor/data', async (req, res) => {
    console.log('📊 Vendor data requested, session:', !!req.session.vendor);
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    if (req.session.vendor.is_suspended === 1) {
        req.session.destroy();
        return res.status(403).json({ error: 'Account suspended' });
    }
    
    const vendorId = req.session.vendor.id;
    
    try {
        const vendor = await queryOne(`SELECT id, business_name, owner_name, email, phone, logo_url, is_suspended, created_at FROM vendors WHERE id = $1`, [vendorId]);
        const menuItems = await query(`SELECT * FROM menu_items WHERE vendor_id = $1 ORDER BY id DESC`, [vendorId]);
        const orders = await query(`SELECT * FROM orders WHERE vendor_id = $1 AND status != 'completed' ORDER BY created_at DESC`, [vendorId]);
        
        res.json({
            vendor: vendor,
            menu_items: menuItems.rows || [],
            orders: orders.rows || []
        });
    } catch (err) {
        console.error('Vendor data error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Push token endpoint (for mobile apps)
app.post('/api/vendor/push-token', async (req, res) => {
    if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
    
    const { push_token } = req.body;
    
    try {
        await query(
            `UPDATE vendors SET push_token = $1 WHERE id = $2`,
            [push_token, req.session.vendor.id]
        );
        res.json({ success: true });
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
    
    const sanitizedName = name.replace(/[<>]/g, '');
    const sanitizedDesc = description ? description.replace(/[<>]/g, '') : '';
    
    try {
        await query(
            `INSERT INTO menu_items (vendor_id, name, price, description, photo_url) 
             VALUES ($1, $2, $3, $4, $5)`,
            [req.session.vendor.id, sanitizedName, price, sanitizedDesc, photoUrl]
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
    
    const sanitizedBusiness = business_name ? business_name.replace(/[<>]/g, '') : '';
    const sanitizedName = owner_name ? owner_name.replace(/[<>]/g, '') : '';
    
    try {
        let queryText = `UPDATE vendors SET business_name = $1, owner_name = $2, phone = $3`;
        let params = [sanitizedBusiness, sanitizedName, phone];
        if (logoUrl) {
            queryText += `, logo_url = $4 WHERE id = $5`;
            params.push(logoUrl, req.session.vendor.id);
        } else {
            queryText += ` WHERE id = $4`;
            params.push(req.session.vendor.id);
        }
        
        await query(queryText, params);
        const vendor = await queryOne(`SELECT id, business_name, owner_name, email, phone, logo_url, is_suspended, created_at FROM vendors WHERE id = $1`, [req.session.vendor.id]);
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

// Place order (secure)
app.post('/api/place-order', async (req, res) => {
    const { vendor_id, customer_name, customer_phone, items, payment_method } = req.body;
    console.log('📦 Order request:', { vendor_id, customer_name, items_count: items?.length });
    
    if (!vendor_id || !items || !items.length) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    try {
        let total = 0;
        const validatedItems = [];
        
        for (const item of items) {
            const menuItem = await queryOne(
                `SELECT id, name, price, is_available FROM menu_items WHERE id = $1 AND vendor_id = $2`,
                [item.id, vendor_id]
            );
            
            if (!menuItem) {
                return res.status(400).json({ error: `Item ${item.id} not found` });
            }
            
            if (menuItem.is_available === 0) {
                return res.status(400).json({ error: `${menuItem.name} is out of stock` });
            }
            
            const quantity = parseInt(item.quantity) || 1;
            const itemTotal = parseFloat(menuItem.price) * quantity;
            total += itemTotal;
            
            validatedItems.push({
                id: menuItem.id,
                name: menuItem.name,
                price: parseFloat(menuItem.price),
                quantity: quantity
            });
        }
        
        const orderNumber = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
        
        await query(
            `INSERT INTO orders (vendor_id, order_number, customer_name, customer_phone, items_json, total, payment_method) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [vendor_id, orderNumber, customer_name || 'Anonymous', customer_phone || '', JSON.stringify(validatedItems), total, payment_method || 'cash']
        );
        
        // Get vendor for notification
        const vendor = await queryOne(`SELECT business_name FROM vendors WHERE id = $1`, [vendor_id]);
        console.log('✅ Order placed:', orderNumber);
        
        res.json({ success: true, order_number: orderNumber });
    } catch (err) {
        console.error('Place order error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Vendor notifications
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
        const vendor = await queryOne(`SELECT id, business_name, logo_url, is_suspended FROM vendors WHERE id = $1`, [vendorId]);
        if (!vendor) {
            return res.status(404).json({ error: 'Vendor not found' });
        }
        
        if (vendor.is_suspended === 1) {
            return res.status(403).json({ error: 'Vendor is suspended' });
        }
        
        const items = await query(
            `SELECT id, name, price, description, photo_url, is_available FROM menu_items WHERE vendor_id = $1 AND is_available = 1 ORDER BY id DESC`,
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
        console.error('Menu API error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Feedback
app.post('/api/feedback', async (req, res) => {
    const { vendor_id, customer_name, customer_email, customer_phone, message, rating } = req.body;
    
    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }
    
    const sanitizedMessage = message.replace(/[<>]/g, '');
    const sanitizedName = customer_name ? customer_name.replace(/[<>]/g, '') : null;
    const sanitizedEmail = customer_email ? customer_email.replace(/[<>]/g, '') : null;
    
    try {
        await query(
            `INSERT INTO feedback (vendor_id, customer_name, customer_email, customer_phone, message, rating) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [vendor_id || null, sanitizedName, sanitizedEmail, customer_phone || null, sanitizedMessage, rating || 5]
        );
        res.json({ success: true, message: 'Thank you for your feedback!' });
    } catch (err) {
        console.error('Feedback error:', err);
        res.status(500).json({ error: 'Failed to submit feedback' });
    }
});

// ============= ADMIN ROUTES =============

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    console.log('🔐 Admin login attempt:', username);
    
    try {
        const adminCheck = await queryOne(`SELECT COUNT(*) as count FROM admin_users`);
        if (parseInt(adminCheck.count) === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await query(
                'INSERT INTO admin_users (username, password) VALUES ($1, $2)',
                ['admin', hashedPassword]
            );
        }
        
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
        console.error('Admin login error:', err);
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

app.get('/api/admin/feedback', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const feedback = await query(`
            SELECT f.*, v.business_name as vendor_name 
            FROM feedback f
            LEFT JOIN vendors v ON f.vendor_id = v.id
            ORDER BY f.created_at DESC
        `);
        res.json(feedback.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/feedback/update', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { feedback_id, status } = req.body;
    
    try {
        await query(
            `UPDATE feedback SET status = $1 WHERE id = $2`,
            [status, feedback_id]
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
        const feedbackCount = await queryOne(`SELECT COUNT(*) as count FROM feedback`);
        
        res.json({
            total_vendors: parseInt(vendors?.count) || 0,
            total_orders: parseInt(orders?.count) || 0,
            pending_orders: parseInt(pendingOrders?.count) || 0,
            active_ads: parseInt(activeAds?.count) || 0,
            total_feedback: parseInt(feedbackCount?.count) || 0
        });
    } catch (err) {
        res.json({ total_vendors: 0, total_orders: 0, pending_orders: 0, active_ads: 0, total_feedback: 0 });
    }
});

// Track order
app.get('/api/track-order/:orderNumber', async (req, res) => {
    const { orderNumber } = req.params;
    
    try {
        const orderResult = await query(`
            SELECT o.*, v.business_name, v.logo_url 
            FROM orders o
            JOIN vendors v ON o.vendor_id = v.id
            WHERE o.order_number = $1
        `, [orderNumber]);
        
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderResult.rows[0];
        const items = typeof order.items_json === 'string' ? JSON.parse(order.items_json) : order.items_json;
        
        const statuses = ['received', 'preparing', 'ready', 'completed'];
        let currentStatus = order.status;
        if (currentStatus === 'pending') currentStatus = 'received';
        
        let currentStep = statuses.indexOf(currentStatus);
        if (currentStep === -1) currentStep = 0;
        
        const progress = (currentStep / 3) * 100;
        
        res.json({
            order: {
                order_number: order.order_number,
                customer_name: order.customer_name,
                customer_phone: order.customer_phone,
                total: order.total,
                payment_method: order.payment_method,
                status: currentStatus,
                created_at: order.created_at,
                business_name: order.business_name,
                logo_url: order.logo_url
            },
            items: items,
            progress: progress,
            current_step: currentStep,
            statuses: statuses
        });
    } catch (err) {
        console.error('Track order error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============= START SERVER =============
app.listen(PORT, () => {
    console.log(`\n✅ KheZwo Lite is running!`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`📍 API Base: ${getBaseUrl()}/api`);
    console.log(`\n📋 Admin: Use the admin login page`);
    console.log(`🎉 Ready to go!\n`);
});
