const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple SQLite database
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./khezwo.db');

// Create tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      password TEXT NOT NULL,
      logo_url TEXT,
      is_suspended INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      description TEXT,
      photo_url TEXT,
      is_available INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL,
      order_number TEXT UNIQUE NOT NULL,
      customer_name TEXT,
      customer_phone TEXT,
      items_json TEXT NOT NULL,
      total DECIMAL(10,2) NOT NULL,
      payment_method TEXT CHECK(payment_method IN ('card', 'cash')) NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sponsor_ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      image_url TEXT,
      link_url TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✅ Database tables created');
});

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

// Helper for db queries
const query = (text, params) => new Promise((resolve, reject) => {
  db.all(text, params || [], (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

const queryOne = (text, params) => new Promise((resolve, reject) => {
  db.get(text, params || [], (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

const runQuery = (text, params) => new Promise((resolve, reject) => {
  db.run(text, params || [], function(err) {
    if (err) reject(err);
    else resolve({ id: this.lastID });
  });
});

// ============= ROUTES =============

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/menu/:vendorId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer-menu.html'));
});

// Vendor Signup
app.post('/api/vendor/signup', async (req, res) => {
  const { business_name, owner_name, email, phone, password } = req.body;
  
  if (!business_name || !owner_name || !email || !phone || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await runQuery(
      `INSERT INTO vendors (business_name, owner_name, email, phone, password) VALUES (?, ?, ?, ?, ?)`,
      [business_name, owner_name, email, phone, hashedPassword]
    );
    
    const vendorId = result.id;
    const baseUrl = getBaseUrl();
    const qrUrl = `${baseUrl}/menu/${vendorId}`;
    qrcode.toFile(`./uploads/qr_${vendorId}.png`, qrUrl, () => {});
    
    res.json({ success: true, vendor_id: vendorId });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Vendor Login
app.post('/api/vendor/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const vendor = await queryOne(`SELECT * FROM vendors WHERE email = ?`, [email]);
    if (!vendor) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    const valid = await bcrypt.compare(password, vendor.password);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    req.session.vendor = vendor;
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
    const vendor = await queryOne(`SELECT * FROM vendors WHERE id = ?`, [vendorId]);
    const menuItems = await query(`SELECT * FROM menu_items WHERE vendor_id = ? ORDER BY id DESC`, [vendorId]);
    const orders = await query(`SELECT * FROM orders WHERE vendor_id = ? AND status != 'completed' ORDER BY created_at DESC`, [vendorId]);
    
    res.json({
      vendor,
      menu_items: menuItems || [],
      orders: orders || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============= QR CODE ENDPOINTS =============

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
    console.error('QR generation error:', err);
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
    console.error('QR regeneration error:', err);
    res.status(500).json({ error: 'Failed to regenerate QR code' });
  }
});

// Add menu item
app.post('/api/vendor/add-menu-item', upload.single('photo'), async (req, res) => {
  if (!req.session.vendor) return res.status(401).json({ error: 'Not logged in' });
  
  const { name, price, description } = req.body;
  const photoUrl = req.file ? `/uploads/${req.file.filename}` : null;
  
  try {
    await runQuery(
      `INSERT INTO menu_items (vendor_id, name, price, description, photo_url) VALUES (?, ?, ?, ?, ?)`,
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
    await runQuery(
      `UPDATE menu_items SET is_available = ? WHERE id = ? AND vendor_id = ?`,
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
    let queryText = `UPDATE vendors SET business_name = ?, owner_name = ?, phone = ?`;
    let params = [business_name, owner_name, phone];
    
    if (logoUrl) {
      queryText += `, logo_url = ?`;
      params.push(logoUrl);
    }
    queryText += ` WHERE id = ?`;
    params.push(req.session.vendor.id);
    
    await runQuery(queryText, params);
    
    const vendor = await queryOne(`SELECT * FROM vendors WHERE id = ?`, [req.session.vendor.id]);
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
    await runQuery(
      `UPDATE orders SET status = ? WHERE id = ? AND vendor_id = ?`,
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
    await runQuery(
      `INSERT INTO orders (vendor_id, order_number, customer_name, customer_phone, items_json, total, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
      `SELECT * FROM orders WHERE vendor_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 5`,
      [vendorId]
    );
    res.json({ orders });
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
      `SELECT * FROM orders WHERE vendor_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 100`,
      [vendorId]
    );
    res.json(orders || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Menu API
app.get('/api/menu/:vendorId', async (req, res) => {
  const vendorId = req.params.vendorId;
  
  try {
    const vendor = await queryOne(`SELECT * FROM vendors WHERE id = ?`, [vendorId]);
    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }
    
    const items = await query(
      `SELECT * FROM menu_items WHERE vendor_id = ? AND is_available = 1 ORDER BY id DESC`,
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
      menu_items: items || [],
      sponsor_ad: ad || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============= ADMIN ROUTES =============

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const admin = await queryOne(`SELECT * FROM admin_users WHERE username = ?`, [username]);
    if (!admin) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
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

// Get all vendors
app.get('/api/admin/vendors', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const vendors = await query(`SELECT * FROM vendors ORDER BY created_at DESC`);
    res.json(vendors || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle vendor suspension
app.post('/api/admin/toggle-vendor', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  
  const { vendor_id, is_suspended } = req.body;
  
  try {
    await runQuery(
      `UPDATE vendors SET is_suspended = ? WHERE id = ?`,
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
    res.json(ads || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/add-sponsor-ad', upload.single('image'), async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  
  const { name, link_url } = req.body;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  
  try {
    await runQuery(
      `INSERT INTO sponsor_ads (name, image_url, link_url) VALUES (?, ?, ?)`,
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
    await runQuery(`DELETE FROM sponsor_ads WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/toggle-sponsor-ad', async (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  
  const { ad_id, is_active } = req.body;
  
  try {
    await runQuery(
      `UPDATE sponsor_ads SET is_active = ? WHERE id = ?`,
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
      total_vendors: vendors.count || 0,
      total_orders: orders.count || 0,
      pending_orders: pendingOrders.count || 0,
      active_ads: activeAds.count || 0
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
// Setup admin user
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
