const express = require('express');
const mysql = require('mysql2'); // Keeps the base driver
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const axios = require('axios'); // Added for handling API calls to the payment gateway

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

// ⚠️ Gateway Credentials (Set these securely in your Render dashboard environment variables)
const GATEWAY_CLIENT_ID = process.env.PAYPACK_CLIENT_ID || "0c8b334a-79a1-11f1-a32b-deadd43720af";
const GATEWAY_CLIENT_SECRET = process.env.PAYPACK_CLIENT_SECRET || "9c5dd80934388233c9a7d75daa2fc46cda39a3ee5e6b4b0d3255bfef95601890afd80709";

// Serve frontend assets automatically out of a folder named 'public'
app.use(express.static(path.join(__dirname, 'public')));

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

// Create the MySQL connection pool
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

// Create a PROMISE-based wrapper to automatically manage connection lifecycles safely
const db = pool.promise();

// Test connection pool health on startup
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database pool connection failure:', err.message);
    } else {
        console.log('✅ Connected to MySQL Database Pool successfully.');
        connection.release();
    }
});

// In-memory token store matching tokens generated during admin login
const activeAdminTokens = new Set();

// Middleware to secure admin endpoints against unauthorized API queries
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

// ==========================================
// 💳 LIVE PAYMENT INTEGRATION ENDPOINT
// ==========================================
app.post('/api/initiate-payment', async (req, res) => {
    try {
        let { phone, amount } = req.body;

        if (!phone || !amount) {
            return res.status(400).json({ success: false, message: "Phone and Amount fields are mandatory." });
        }

        // 🔄 Clean up and format phone to standard Rwanda format (e.g., 078... -> 25078...)
        let cleanPhone = phone.trim().replace(/[\s-+]/g, '');
        if (cleanPhone.startsWith('0')) {
            cleanPhone = '250' + cleanPhone.substring(1);
        }
        if (!cleanPhone.startsWith('250') || cleanPhone.length !== 12) {
            return res.status(400).json({ success: false, message: "Invalid Rwanda number format. Use 078/079/072/073..." });
        }

        console.log(`[PAYMENT] Triggering MoMo/Airtel prompt for ${amount} RWF to device: ${cleanPhone}`);

        // 1. Fetch Auth Token from the aggregator platform (e.g., Paypack API format)
        const authResponse = await axios.post('https://payments.paypack.rw/api/auth/agents/authorize', {
            client_id: GATEWAY_CLIENT_ID,
            client_secret: GATEWAY_CLIENT_SECRET
        });
        
        const accessToken = authResponse.data.access;

        // 2. Dispatch Direct USSD Mobile Money Prompt (Cash-in) to user's phone
        const pushResponse = await axios.post('https://payments.paypack.rw/api/transactions/cashin', {
            amount: Number(amount),
            number: cleanPhone
        }, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        // 3. Return the real tracking reference back to your frontend checkout form
        if (pushResponse.data && pushResponse.data.ref) {
            return res.status(200).json({
                success: true,
                message: "STK PIN Prompt issued successfully.",
                txRef: pushResponse.data.ref 
            });
        } else {
            throw new Error("Invalid provider response payload format.");
        }

    } catch (error) {
        console.error("[GATEWAY FAULT]", error.response ? error.response.data : error.message);
        return res.status(500).json({
            success: false,
            message: "Failed to transmit payment payload to phone network.",
            error: error.response ? error.response.data : error.message
        });
    }
});

// GET all products
app.get('/api/products', async (req, res) => {
    const search = req.query.search || '';
    const sql = "SELECT * FROM products WHERE name LIKE ? OR description LIKE ?";
    try {
        const [results] = await db.query(sql, [`%${search}%`, `%${search}%`]);
        res.json(results || []); 
    } catch (err) {
        res.status(500).json({ error: err.message || err || "Unknown database error" });
    }
});

// POST new product (Secured)
app.post('/api/admin/products', verifyAdminSession, upload.single('productImage'), async (req, res) => {
    const { name, price, stock_quantity, description } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : '';
    
    const sql = "INSERT INTO products (name, price, stock_quantity, description, image_url) VALUES (?, ?, ?, ?, ?)";
    try {
        const [result] = await db.query(sql, [name, price, stock_quantity || 0, description, imageUrl]);
        res.json({ success: true, productId: result.insertId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT (Update) an existing product (Secured)
app.put('/api/admin/products/:id', verifyAdminSession, upload.single('productImage'), async (req, res) => {
    const { name, price, stock_quantity, description } = req.body;
    const productId = req.params.id;
    
    try {
        if (req.file) {
            const imageUrl = `/uploads/${req.file.filename}`;
            const sql = "UPDATE products SET name = ?, price = ?, stock_quantity = ?, description = ?, image_url = ? WHERE id = ?";
            await db.query(sql, [name, price, stock_quantity || 0, description, imageUrl, productId]);
            res.json({ success: true, message: "Product and image updated successfully!" });
        } else {
            const sql = "UPDATE products SET name = ?, price = ?, stock_quantity = ?, description = ? WHERE id = ?";
            await db.query(sql, [name, price, stock_quantity || 0, description, productId]);
            res.json({ success: true, message: "Product updated successfully!" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE a product from the inventory (Secured)
app.delete('/api/admin/products/:id', verifyAdminSession, async (req, res) => {
    const productId = req.params.id;
    const sql = "DELETE FROM products WHERE id = ?";
    try {
        await db.query(sql, [productId]);
        res.json({ success: true, message: "Product removed from inventory!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin Authentication Gateway
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = crypto.createHash('md5').update(password).digest('hex');

    const query = 'SELECT * FROM admins WHERE username = ? AND password = ?';
    try {
        const [results] = await db.query(query, [username, hashedPassword]);
        if (results.length > 0) {
            const tempToken = crypto.randomBytes(16).toString('hex');
            activeAdminTokens.add(tempToken);
            res.json({ success: true, token: tempToken });
        } else {
            res.json({ success: false, message: 'Invalid credentials provided!' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Checkout Route handling Stock Deduction, Tracking & Dynamic Email Render Tables
app.post('/api/checkout', async (req, res) => {
    const { fullName, email, phone, district, deliveryAddress, txRef, totalAmount, items } = req.body;
    
    const productsSummary = Array.isArray(items) 
        ? items.map(item => `${item.name} (x${item.quantity})`).join(', ')
        : 'N/A';

    const sql = "INSERT INTO orders (full_name, email, phone, district, delivery_address, total_amount, payment_method, transaction_reference, payment_status, products_ordered) VALUES (?, ?, ?, ?, ?, ?, 'MTN_MOMO', ?, 'PENDING', ?)";
    
    try {
        const [result] = await db.query(sql, [fullName, email, phone, district, deliveryAddress || 'Not Provided', totalAmount, txRef, productsSummary]);
        const orderId = result.insertId;

        // Deduct quantities from remaining inventory stock securely
        if (Array.isArray(items)) {
            for (const item of items) {
                const updateStockSql = "UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?";
                try {
                    await db.query(updateStockSql, [item.quantity, item.id]);
                } catch (stockErr) {
                    console.error(`❌ Stock deduction failed for item ID ${item.id}:`, stockErr.message);
                }
            }
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
                <p>We truly appreciate your business and are thrilled that you choose to shop with us today!</p>
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
                    <p style="margin: 5px 0;"><strong>Shipping Zone Specified:</strong> ${district}, ${deliveryAddress || ''}</p>
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
                        <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">Location Address:</td>
                        <td style="padding: 10px; border: 1px solid #ddd;">${district}, ${deliveryAddress || ''}</td>
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET Admin Orders (Secured)
app.get('/api/admin/orders', verifyAdminSession, async (req, res) => {
    const sql = "SELECT * FROM orders ORDER BY id DESC";
    try {
        const [results] = await db.query(sql);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH Order Status (Secured)
app.patch('/api/admin/orders/:id/status', verifyAdminSession, async (req, res) => {
    const { payment_status } = req.body;
    const orderId = req.params.id;
    const sql = "UPDATE orders SET payment_status = ? WHERE id = ?";
    
    try {
        await db.query(sql, [payment_status, orderId]);
        
        // Dynamic Customer Trigger Alert notification sent automatically if order is approved
        if(payment_status === 'COMPLETED') {
            try {
                const [orderRecord] = await db.query("SELECT email, full_name, district, delivery_address FROM orders WHERE id = ?", [orderId]);
                if (orderRecord && orderRecord.length > 0) {
                    const targetClient = orderRecord[0];
                    const approvedHtml = `
                        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 550px; border: 1px solid #e2e8f0; border-radius: 10px;">
                            <h2 style="color: #10b981;">Order Approved & Shipped!</h2>
                            <p>Hello <b>${targetClient.full_name}</b>,</p>
                            <p>Great news! Your package for Order <b>#00${orderId}</b> has been approved and has been assigned to our logistics dispatch rider team.</p>
                            <p>📍 <b>Delivery Zone:</b> ${targetClient.district}, ${targetClient.delivery_address || ''}</p>
                            <p>Thank you for choosing SYSOFT!</p>
                        </div>`;
                    sendNotificationEmail(targetClient.email, `📦 SYSOFT Order #00${orderId} Dispatched!`, approvedHtml);
                }
            } catch (err) {
                console.error("Failed to process approval notification pipeline.");
            }
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE an order (Secured)
app.delete('/api/admin/orders/:id', verifyAdminSession, async (req, res) => {
    const sql = "DELETE FROM orders WHERE id = ?";
    try {
        await db.query(sql, [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Express 5 compatible regex route to handle the single page application fallback
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});