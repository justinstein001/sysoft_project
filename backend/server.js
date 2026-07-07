const express = require('express');
const mysql = require('mysql2'); 
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const axios = require('axios'); 

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

const GATEWAY_CLIENT_ID = process.env.PAYPACK_CLIENT_ID;
const GATEWAY_CLIENT_SECRET = process.env.PAYPACK_CLIENT_SECRET;

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

pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database pool connection failure:', err.message);
    } else {
        console.log('✅ Connected to MySQL Database Pool successfully.');
        connection.release();
    }
});

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

// FIX: Updated to port 587 and use process.env for security
const emailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false
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

// ... [All other original route logic goes here] ...

// YOUR EXACT CHECKOUT ROUTE
app.post('/api/checkout', async (req, res) => {
    const { fullName, email, phone, district, deliveryAddress, txRef, totalAmount, items } = req.body;
    
    const productsSummary = Array.isArray(items) 
        ? items.map(item => `${item.name} (x${item.quantity})`).join(', ')
        : 'N/A';

    const sql = "INSERT INTO orders (full_name, email, phone, district, delivery_address, total_amount, payment_method, transaction_reference, payment_status, products_ordered) VALUES (?, ?, ?, ?, ?, ?, 'MTN_MOMO', ?, 'PENDING', ?)";
    
    try {
        const [result] = await db.query(sql, [fullName, email, phone, district, deliveryAddress || 'Not Provided', totalAmount, txRef, productsSummary]);
        const orderId = result.insertId;

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

        const adminHtml = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ccc; padding: 25px; border-radius: 8px;">
                <div style="background-color: #2c3e50; padding: 15px; text-align: center; border-radius: 6px 6px 0 0;">
                    <h2 style="color: #ffffff; margin: 0; font-size: 20px;">🚨 New Store Order #00${orderId}</h2>
                </div>
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                    <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9; width: 35%;">Client Name:</td><td style="padding: 10px; border: 1px solid #ddd;">${fullName}</td></tr>
                    <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">Location Address:</td><td style="padding: 10px; border: 1px solid #ddd;">${district}, ${deliveryAddress || ''}</td></tr>
                    <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">Products Sold:</td><td style="padding: 10px; border: 1px solid #ddd;">${productsSummary}</td></tr>
                    <tr><td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">Total Price Paid:</td><td style="padding: 10px; border: 1px solid #ddd; color: #27ae60; font-weight: bold;">${parseInt(totalAmount).toLocaleString()} RWF</td></tr>
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

// ... [Rest of your code remains unchanged]