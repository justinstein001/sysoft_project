const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

const GATEWAY_CLIENT_ID = process.env.PAYPACK_CLIENT_ID;
const GATEWAY_CLIENT_SECRET = process.env.PAYPACK_CLIENT_SECRET;
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.static(path.join(__dirname, 'public')));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, 'uploads/'); },
    filename: (req, file, cb) => { cb(null, Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'defaultdb',
    port: process.env.DB_PORT || 17499,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const db = pool.promise();
const activeAdminTokens = new Set();

const verifyAdminSession = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Access Denied: Missing session parameters.' });
    }
    const token = authHeader.split(' ')[1];
    if (!activeAdminTokens.has(token)) {
        return res.status(403).json({ error: 'Access Denied: Expired or unauthenticated credentials.' });
    }
    next();
};

async function sendNotificationEmail(recipient, subject, htmlContent) {
    try {
        await resend.emails.send({
            from: 'SYSOFT <onboarding@resend.dev>',
            to: recipient,
            subject: subject,
            html: htmlContent
        });
        console.log(`✅ Email sent to ${recipient}`);
    } catch (error) {
        console.error(`❌ Email API failed:`, error.message);
    }
}

app.post('/api/initiate-payment', async (req, res) => {
    try {
        let { phone, amount } = req.body;
        let cleanPhone = phone.trim().replace(/[\s-+]/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '250' + cleanPhone.substring(1);

        const authResponse = await axios.post('https://payments.paypack.rw/api/auth/agents/authorize', {
            client_id: GATEWAY_CLIENT_ID,
            client_secret: GATEWAY_CLIENT_SECRET
        });

        const pushResponse = await axios.post('https://payments.paypack.rw/api/transactions/cashin', {
            amount: Number(amount),
            number: cleanPhone
        }, { headers: { 'Authorization': `Bearer ${authResponse.data.access}` } });

        res.status(200).json({ success: true, txRef: pushResponse.data.ref });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/products', async (req, res) => {
    const search = req.query.search || '';
    const [results] = await db.query("SELECT * FROM products WHERE name LIKE ? OR description LIKE ?", [`%${search}%`, `%${search}%`]);
    res.json(results || []);
});

app.post('/api/admin/products', verifyAdminSession, upload.single('productImage'), async (req, res) => {
    const { name, price, stock_quantity, description } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : '';
    const [result] = await db.query("INSERT INTO products (name, price, stock_quantity, description, image_url) VALUES (?, ?, ?, ?, ?)", [name, price, stock_quantity || 0, description, imageUrl]);
    res.json({ success: true, productId: result.insertId });
});

app.put('/api/admin/products/:id', verifyAdminSession, upload.single('productImage'), async (req, res) => {
    const { name, price, stock_quantity, description } = req.body;
    const productId = req.params.id;
    if (req.file) {
        await db.query("UPDATE products SET name = ?, price = ?, stock_quantity = ?, description = ?, image_url = ? WHERE id = ?", [name, price, stock_quantity || 0, description, `/uploads/${req.file.filename}`, productId]);
    } else {
        await db.query("UPDATE products SET name = ?, price = ?, stock_quantity = ?, description = ? WHERE id = ?", [name, price, stock_quantity || 0, description, productId]);
    }
    res.json({ success: true });
});

app.delete('/api/admin/products/:id', verifyAdminSession, async (req, res) => {
    await db.query("DELETE FROM products WHERE id = ?", [req.params.id]);
    res.json({ success: true });
});

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = crypto.createHash('md5').update(password).digest('hex');
    const [results] = await db.query('SELECT * FROM admins WHERE username = ? AND password = ?', [username, hashedPassword]);
    if (results.length > 0) {
        const tempToken = crypto.randomBytes(16).toString('hex');
        activeAdminTokens.add(tempToken);
        res.json({ success: true, token: tempToken });
    } else {
        res.json({ success: false, message: 'Invalid credentials' });
    }
});

app.post('/api/checkout', async (req, res) => {
    const { fullName, email, phone, district, deliveryAddress, txRef, totalAmount, items } = req.body;
    const productsSummary = items.map(item => `${item.name} (x${item.quantity})`).join(', ');

    const [result] = await db.query("INSERT INTO orders (full_name, email, phone, district, delivery_address, total_amount, payment_method, transaction_reference, payment_status, products_ordered) VALUES (?, ?, ?, ?, ?, ?, 'MTN_MOMO', ?, 'PENDING', ?)", [fullName, email, phone, district, deliveryAddress || 'Not Provided', totalAmount, txRef, productsSummary]);
    const orderId = result.insertId;

    for (const item of items) {
        await db.query("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?", [item.quantity, item.id]);
    }

    const itemsHtmlRows = items.map(item => `
        <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.name}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${parseInt(item.price * item.quantity).toLocaleString()} RWF</td>
        </tr>`).join('');

    const customerHtml = `
        <div style="font-family: sans-serif; line-height: 1.6; max-width: 600px; border: 1px solid #e0e0e0; padding: 25px; border-radius: 8px;">
            <h1 style="color: #2ecc71;">Thank You, ${fullName}!</h1>
            <p>Order Summary (#00${orderId}):</p>
            <table style="width: 100%; border-collapse: collapse;">
                ${itemsHtmlRows}
            </table>
            <p><strong>Total: ${parseInt(totalAmount).toLocaleString()} RWF</strong></p>
        </div>`;

    const adminHtml = `
        <div style="font-family: sans-serif; padding: 25px; border: 1px solid #ccc;">
            <h2>🚨 New Order #00${orderId}</h2>
            <p>Client: ${fullName}</p>
            <p>Items: ${productsSummary}</p>
            <p>Total: ${parseInt(totalAmount).toLocaleString()} RWF</p>
        </div>`;

    sendNotificationEmail(email, "SYSOFT Order Confirmation", customerHtml);
    sendNotificationEmail("amahorojustin04@gmail.com", "🚨 New Order Dispatch", adminHtml);

    res.json({ success: true, orderId: orderId });
});

app.get('/api/admin/orders', verifyAdminSession, async (req, res) => {
    const [results] = await db.query("SELECT * FROM orders ORDER BY id DESC");
    res.json(results);
});

app.patch('/api/admin/orders/:id/status', verifyAdminSession, async (req, res) => {
    await db.query("UPDATE orders SET payment_status = ? WHERE id = ?", [req.body.payment_status, req.params.id]);
    res.json({ success: true });
});

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));