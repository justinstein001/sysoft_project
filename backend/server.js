const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)){
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, 'uploads/'); },
    filename: (req, file, cb) => { cb(null, Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });

// Complete database configuration block mapped securely to your cloud parameters
//  NEW WAY (Connection Pool handles reconnections automatically)
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'defaultdb', 
    port: process.env.DB_PORT || 17499,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test the pool connection instantly on startup
db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database pool connection failure:', err.message);
    } else {
        console.log('✅ Connected to MySQL Database Pool successfully.');
        connection.release(); // send it back to the pool
    }
});


const emailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, 
    auth: {
        user: 'amahorojustin04@gmail.com',
        pass: 'gtycgwpgogopsmch'
    }
});

async function sendNotificationEmail(recipient, subject, htmlContent) {
    try {
        await emailTransporter.sendMail({
            from: '"SYSOFT Smart Shop" <amahorojustin04@gmail.com>',
            to: recipient,
            subject: subject,
            html: htmlContent
        });
    } catch (error) {
        console.error(`❌ Email failed to direct to ${recipient}:`, error.message);
    }
}

// GET all products
app.get('/api/products', (req, res) => {
    const search = req.query.search || '';
    const sql = "SELECT * FROM products WHERE name LIKE ? OR description LIKE ?";
    db.query(sql, [`%${search}%`, `%${search}%`], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// POST new product
app.post('/api/admin/products', upload.single('productImage'), (req, res) => {
    const { name, price, stock_quantity, description } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : '';
    
    const sql = "INSERT INTO products (name, price, stock_quantity, description, image_url) VALUES (?, ?, ?, ?, ?)";
    db.query(sql, [name, price, stock_quantity || 0, description, imageUrl], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, productId: result.insertId });
    });
});

// PUT (Update) an existing product
app.put('/api/admin/products/:id', upload.single('productImage'), (req, res) => {
    const { name, price, stock_quantity, description } = req.body;
    const productId = req.params.id;
    
    if (req.file) {
        const imageUrl = `/uploads/${req.file.filename}`;
        const sql = "UPDATE products SET name = ?, price = ?, stock_quantity = ?, description = ?, image_url = ? WHERE id = ?";
        db.query(sql, [name, price, stock_quantity || 0, description, imageUrl, productId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: "Product and image updated successfully!" });
        });
    } else {
        const sql = "UPDATE products SET name = ?, price = ?, stock_quantity = ?, description = ? WHERE id = ?";
        db.query(sql, [name, price, stock_quantity || 0, description, productId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: "Product updated successfully!" });
        });
    }
});

// DELETE a product from the inventory
app.delete('/api/admin/products/:id', (req, res) => {
    const productId = req.params.id;
    const sql = "DELETE FROM products WHERE id = ?";
    db.query(sql, [productId], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: "Product removed from inventory!" });
    });
});

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = crypto.createHash('md5').update(password).digest('hex');

    const query = 'SELECT * FROM admins WHERE username = ? AND password = ?';
    db.query(query, [username, hashedPassword], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error' });
        
        if (results.length > 0) {
            const tempToken = crypto.randomBytes(16).toString('hex');
            res.json({ success: true, token: tempToken });
        } else {
            res.json({ success: false, message: 'Invalid credentials provided!' });
        }
    });
});

// Checkout Route handling Stock Deduction, Tracking & Dynamic Email Render Tables
app.post('/api/checkout', (req, res) => {
    const { fullName, email, phone, district, deliveryAddress, txRef, totalAmount, items } = req.body;
    
    const productsSummary = Array.isArray(items) 
        ? items.map(item => `${item.name} (x${item.quantity})`).join(', ')
        : 'N/A';

    const sql = "INSERT INTO orders (full_name, email, phone, district, total_amount, payment_method, transaction_reference, payment_status, products_ordered) VALUES (?, ?, ?, ?, ?, 'MTN_MOMO', ?, 'PENDING', ?)";
    
    db.query(sql, [fullName, email, phone, district, totalAmount, txRef, productsSummary], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const orderId = result.insertId;

        // Deduct quantities from remaining inventory stock
        if (Array.isArray(items)) {
            items.forEach(item => {
                const updateStockSql = "UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?";
                db.query(updateStockSql, [item.quantity, item.id], (stockErr) => {
                    if (stockErr) console.error(`❌ Stock deduction failed for item ID ${item.id}:`, stockErr.message);
                });
            });
        }

        let itemsHtmlRows = '';
        if (Array.isArray(items)) {
            itemsHtmlRows = items.map(item => `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.name}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${parseInt(item.price * item.quantity).toLocaleString()} RWF</td>
                </tr>
            `).join('');
        } else {
            itemsHtmlRows = `<tr><td colspan="3" style="padding: 8px; text-align: center;">No structured item elements detected.</td></tr>`;
        }

        // Customer Email Style
        const customerHtml = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; padding: 25px; border-radius: 8px;">
                <div style="text-align: center; border-bottom: 3px solid #2ecc71; padding-bottom: 15px;">
                    <h1 style="color: #2ecc71; margin: 0; font-size: 24px;">Thank You for Your Purchase!</h1>
                </div>
                <p style="font-size: 16px;">Dear <strong>${fullName}</strong>,</p>
                <p>We truly appreciate your business and are thrilled that you choose to shop with <strong>...</strong> today!</p>
                <div style="background-color: #f9f9f9; border-left: 4px solid #2ecc71; padding: 15px; margin: 20px 0;">
                    <h3 style="margin-top: 0; color: #2c3e50;">Order Summary (#00${orderId}):</h3>
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px; font-size: 14px;">
                        <thead>
                            <tr style="background-color: #eee;">
                                <th style="padding: 8px; text-align: left;">Product Item</th>
                                <th style="padding: 8px; text-align: center;">Qty</th>
                                <th style="padding: 8px; text-align: right;">Price</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${itemsHtmlRows}
                        </tbody>
                    </table>
                    <p style="margin: 5px 0;"><strong>Total Items Amount:</strong> <span style="color: #2ecc71; font-weight: bold;">${parseInt(totalAmount).toLocaleString()} RWF</span></p>
                    <p style="margin: 5px 0;"><strong>Shipping Zone Specified:</strong> ${district}</p>
                </div>
                <p style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px;">Warm regards,<br><strong>The SYSOFT Shop Team</strong></p>
            </div>
        `;

        // Admin Notification Email
        const adminHtml = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ccc; padding: 25px; border-radius: 8px;">
                <div style="background-color: #2c3e50; padding: 15px; text-align: center; border-radius: 6px 6px 0 0;">
                    <h2 style="color: #ffffff; margin: 0; font-size: 20px;">🚨 New Store Order #00${orderId}</h2>
                </div>
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9; width: 35%;">Client Name:</td>
                        <td style="padding: 10px; border: 1px solid #ddd;">${fullName}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">Products Sold:</td>
                        <td style="padding: 10px; border: 1px solid #ddd;">${productsSummary}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">Total Price Paid:</td>
                        <td style="padding: 10px; border: 1px solid #ddd; color: #27ae60; font-weight: bold;">${parseInt(totalAmount).toLocaleString()} RWF</td>
                    </tr>
                </table>
            </div>
        `;

        sendNotificationEmail(email, "SYSOFT Order Confirmation", customerHtml);
        sendNotificationEmail("amahorojustin04@gmail.com", "🚨 New Order Dispatch", adminHtml);

        res.json({ success: true, orderId: orderId });
    });
});

app.get('/api/admin/orders', (req, res) => {
    const sql = "SELECT * FROM orders ORDER BY id DESC";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.patch('/api/admin/orders/:id/status', (req, res) => {
    const { payment_status } = req.body;
    const sql = "UPDATE orders SET payment_status = ? WHERE id = ?";
    db.query(sql, [payment_status, req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.delete('/api/admin/orders/:id', (req, res) => {
    const sql = "DELETE FROM orders WHERE id = ?";
    db.query(sql, [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});