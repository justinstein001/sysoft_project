const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
//const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 5000;
const uploadsDir = path.join(__dirname, 'uploads');

// Set FRONTEND_URL on Render, e.g. https://your-site.onrender.com.
const corsOptions = {
  origin(origin, callback) {
    const allowedOrigin = process.env.FRONTEND_URL;
    if (!origin || !allowedOrigin || origin === allowedOrigin) return callback(null, true);
    return callback(new Error('This origin is not allowed by CORS.'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed.'));
  },
});

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'defaultdb',
  port: Number(process.env.DB_PORT || 17499),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Set DB_SSL=true only if your database provider requires TLS.
  ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
});
const db = pool.promise();
//const resend = new Resend(process.env.RESEND_API_KEY);
const activeAdminTokens = new Set();

function verifyAdminSession(req, res, next) {
  const token = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: 'Missing admin token.' });
  if (!activeAdminTokens.has(token)) return res.status(403).json({ error: 'Invalid or expired admin token.' });
  next();
}

function productValues(body) {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const price = Number(body.price);
  const stockQuantity = body.stock_quantity === '' || body.stock_quantity == null ? 0 : Number(body.stock_quantity);

  if (!name) throw Object.assign(new Error('Product name is required.'), { status: 400 });
  if (!Number.isFinite(price) || price < 0) throw Object.assign(new Error('Price must be a non-negative number.'), { status: 400 });
  if (!Number.isInteger(stockQuantity) || stockQuantity < 0) throw Object.assign(new Error('Stock quantity must be a non-negative whole number.'), { status: 400 });
  return { name, description, price, stockQuantity };
}

async function sendNotificationEmail(recipient, subject, html) {
  if (!process.env.RESEND_API_KEY) return;
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM || 'SYSOFT <onboarding@resend.dev>',
    to: recipient,
    subject,
    html,
  });
  if (error) console.error('Email delivery failed:', error);
}

app.post('/api/initiate-payment', async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    let cleanPhone = String(req.body.phone || '').trim().replace(/[\s+-]/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = `250${cleanPhone.slice(1)}`;
    if (!Number.isFinite(amount) || amount <= 0 || !/^2507\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({ success: false, error: 'Enter a valid Rwandan phone number and amount.' });
    }
    const auth = await axios.post('https://payments.paypack.rw/api/auth/agents/authorize', {
      client_id: process.env.PAYPACK_CLIENT_ID,
      client_secret: process.env.PAYPACK_CLIENT_SECRET,
    });
    const payment = await axios.post('https://payments.paypack.rw/api/transactions/cashin', {
      amount, number: cleanPhone,
    }, { headers: { Authorization: `Bearer ${auth.data.access}` } });
    res.json({ success: true, txRef: payment.data.ref });
  } catch (error) { next(error); }
});

app.get('/api/products', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const [products] = await db.query(
      'SELECT * FROM products WHERE name LIKE ? OR description LIKE ?',
      [`%${search}%`, `%${search}%`],
    );
    res.json(products);
  } catch (error) { next(error); }
});

app.post('/api/admin/products', verifyAdminSession, upload.single('productImage'), async (req, res, next) => {
  try {
    const { name, price, stockQuantity, description } = productValues(req.body);
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : '';
    const [result] = await db.query(
      'INSERT INTO products (name, price, stock_quantity, description, image_url) VALUES (?, ?, ?, ?, ?)',
      [name, price, stockQuantity, description, imageUrl],
    );
    res.status(201).json({ success: true, productId: result.insertId, imageUrl });
  } catch (error) { next(error); }
});

app.put('/api/admin/products/:id', verifyAdminSession, upload.single('productImage'), async (req, res, next) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId < 1) return res.status(400).json({ error: 'Invalid product ID.' });
    const { name, price, stockQuantity, description } = productValues(req.body);
    const query = req.file
      ? 'UPDATE products SET name=?, price=?, stock_quantity=?, description=?, image_url=? WHERE id=?'
      : 'UPDATE products SET name=?, price=?, stock_quantity=?, description=? WHERE id=?';
    const values = req.file
      ? [name, price, stockQuantity, description, `/uploads/${req.file.filename}`, productId]
      : [name, price, stockQuantity, description, productId];
    const [result] = await db.query(query, values);
    if (!result.affectedRows) return res.status(404).json({ error: 'Product not found.' });
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.delete('/api/admin/products/:id', verifyAdminSession, async (req, res, next) => {
  try {
    const [result] = await db.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Product not found.' });
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.post('/api/admin/login', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const hash = crypto.createHash('md5').update(password).digest('hex'); // Migrate existing passwords to bcrypt when possible.
    const [admins] = await db.query('SELECT id FROM admins WHERE username = ? AND password = ?', [username, hash]);
    if (!admins.length) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const token = crypto.randomBytes(32).toString('hex');
    activeAdminTokens.add(token);
    res.json({ success: true, token });
  } catch (error) { next(error); }
});

// Important: before marking an order PAID or dispatching it, verify txRef with Paypack server-side.
app.post('/api/checkout', async (req, res, next) => {
  const connection = await db.getConnection();
  try {
    const { fullName, email, phone, district, deliveryAddress, txRef, totalAmount, items } = req.body;
    const amount = Number(totalAmount);
    if (!String(fullName || '').trim() || !String(email || '').trim() || !Array.isArray(items) || !items.length || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Order details are incomplete.' });
    }
    await connection.beginTransaction();
    const [result] = await connection.query(
      "INSERT INTO orders (full_name, email, phone, district, delivery_address, total_amount, payment_method, transaction_reference, payment_status, products_ordered) VALUES (?, ?, ?, ?, ?, ?, 'MTN_MOMO', ?, 'PENDING', ?)",
      [fullName, email, phone || '', district || '', deliveryAddress || 'Not Provided', amount, txRef || '', items.map((item) => `${item.name} (x${item.quantity})`).join(', ')],
    );
    for (const item of items) {
      const quantity = Number(item.quantity);
      const productId = Number(item.id);
      if (!Number.isInteger(quantity) || quantity < 1 || !Number.isInteger(productId)) throw Object.assign(new Error('Invalid product quantity.'), { status: 400 });
      const [stock] = await connection.query('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?', [quantity, productId, quantity]);
      if (!stock.affectedRows) throw Object.assign(new Error('One or more products are out of stock.'), { status: 409 });
    }
    await connection.commit();
    res.status(201).json({ success: true, orderId: result.insertId });
    void sendNotificationEmail(email, 'SYSOFT Order Confirmation', `<p>Thank you, ${String(fullName)}. Your order number is #${result.insertId}.</p>`);
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

app.get('/api/admin/orders', verifyAdminSession, async (_req, res, next) => {
  try { const [orders] = await db.query('SELECT * FROM orders ORDER BY id DESC'); res.json(orders); } catch (error) { next(error); }
});

app.patch('/api/admin/orders/:id/status', verifyAdminSession, async (req, res, next) => {
  try {
    const [result] = await db.query('UPDATE orders SET payment_status = ? WHERE id = ?', [req.body.payment_status, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Order not found.' });
    res.json({ success: true });
  } catch (error) { next(error); }
});

app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
  res.status(error.status || 500).json({ success: false, error: error.message || 'Internal server error.' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
