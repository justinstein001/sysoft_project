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

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'sysoft_db'
});

db.connect(err => {
    if (err) console.error('❌ Database connection failure:', err.message);
    else console.log('✅ Connected to MySQL Database successfully.');
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
    db.query(sql, [name, price, stock_quantity, description, imageUrl], (err, result) => {
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
        db.query(sql, [name, price, stock_quantity, description, imageUrl, productId], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: "Product and image updated successfully!" });
        });
    } else {
        const sql = "UPDATE products SET name = ?, price = ?, stock_quantity = ?, description = ? WHERE id = ?";
        db.query(sql, [name, price, stock_quantity, description, productId], (err, result) => {
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

    const sql = "INSERT INTO orders (full_name, email, phone, district, delivery_address, transaction_reference, total_amount, payment_status, products_ordered) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)";
    
    db.query(sql, [fullName, email, phone, district, deliveryAddress, txRef, totalAmount, productsSummary], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const orderId = result.insertId;

        // Requirement 2: Deduct quantities from remaining inventory stock
        if (Array.isArray(items)) {
            items.forEach(item => {
                const updateStockSql = "UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?";
                db.query(updateStockSql, [item.quantity, item.id], (stockErr) => {
                    if (stockErr) console.error(`❌ Stock deduction failed for item ID ${item.id}:`, stockErr.message);
                });
            });
        }

        // Requirement 1: Build product listing matching your original structural format
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

        // Customer Email: Preserved exact style format incorporating item data table seamlessly
        const customerHtml = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; padding: 25px; border-radius: 8px;">
                <div style="text-align: center; border-bottom: 3px solid #2ecc71; padding-bottom: 15px;">
                    <h1 style="color: #2ecc71; margin: 0; font-size: 24px;">Thank You for Your Purchase!</h1>
                </div>
                
                <p style="font-size: 16px;">Dear <strong>${fullName}</strong>,</p>
                <p>We truly appreciate your business and are thrilled that you choose to shop with <strong>SYSOFT Shop</strong> today! Your order has been registered successfully.</p>
                
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
                    <p style="margin: 5px 0;"><strong>Exact Dropoff Destination:</strong> ${deliveryAddress}</p>
                </div>

                <div style="background-color: #fcf8e3; border: 1px solid #faebcc; color: #8a6d3b; padding: 15px; border-radius: 5px; margin: 25px 0; font-size: 15px;">
                    <strong>📦 Important Delivery Notice:</strong> Please note: Delivery fees are calculated based on your location and will be paid directly to the courier driver upon arrival. Please be patient while waiting for delivery, as our logistics team handles your setup safely!
                </div>

                <p>If you have any dynamic order customization requests, reply directly to this thread.</p>
                <p style="margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px;">Warm regards,<br><strong>The SYSOFT Shop Team</strong></p>
            </div>
        `;

        // Admin Email: Preserved style format incorporating the item list data table seamlessly
        const adminHtml = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ccc; padding: 25px; border-radius: 8px;">
                <div style="background-color: #2c3e50; padding: 15px; text-align: center; border-radius: 6px 6px 0 0;">
                    <h2 style="color: #ffffff; margin: 0; font-size: 20px;">🚨 New Store Order #00${orderId}</h2>
                </div>
                
                <p style="font-size: 15px; margin-top: 20px;">Hello Admin,</p>
                <p>A new purchase has been processed across the store interface. Please review the customer logs below:</p>
                
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9; width: 35%;">Client Name:</td>
                        <td style="padding: 10px; border: 1px solid #ddd;">${fullName}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">Products Sold:</td>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; color: #c0392b;">
                            <table style="width: 100%; border-collapse: collapse; font-size: 13px; font-weight: normal; color: #333;">
                                <tr style="background-color: #f2f2f2;">
                                    <th style="padding: 4px; text-align: left;">Item</th>
                                    <th style="padding: 4px; text-align: center;">Qty</th>
                                </tr>
                                ${itemsHtmlRows}
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">District Location:</td>
                        <td style="padding: 10px; border: 1px solid #ddd;">${district}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">Address Particulars:</td>
                        <td style="padding: 10px; border: 1px solid #ddd;">${deliveryAddress}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">Total Price Paid:</td>
                        <td style="padding: 10px; border: 1px solid #ddd; color: #27ae60; font-weight: bold;">${parseInt(totalAmount).toLocaleString()} RWF</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">Transaction ID Reference:</td>
                        <td style="padding: 10px; border: 1px solid #ddd; font-family: monospace;">${txRef}</td>
                    </tr>
                </table>

                <div style="margin: 25px 0; text-align: center;">
                    <p style="margin-bottom: 15px; font-weight: bold; color: #e67e22;">Action Required: Please evaluate this request to approve or reject dispatch.</p>
                    <a href="http://localhost:5000/admin.html" style="display: inline-block; padding: 12px 25px; color: #ffffff; background-color: #3498db; text-decoration: none; border-radius: 5px; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">Go to Admin Portal</a>
                </div>
                
                <p style="font-size: 11px; color: #95a5a6; border-top: 1px solid #eee; padding-top: 15px; margin-top: 20px; text-align: center;">SYSOFT Automated Dispatch Notification Protocol.</p>
            </div>
        `;

        sendNotificationEmail(email, "SYSOFT Order Confirmation", customerHtml);
        sendNotificationEmail("amahorojustin04@gmail.com", "🚨 New Order Dispatch", adminHtml);

        res.json({ success: true, orderId: orderId });
    });
});

app.get('/api/admin/orders', (req, res) => {
    const sql = "SELECT id, full_name, email, phone, district, delivery_address, transaction_reference, total_amount, payment_status, products_ordered FROM orders ORDER BY id DESC";
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

app.listen(5000, () => console.log('🚀 [SYSOFT Final Engine] Live on Port 5000'));