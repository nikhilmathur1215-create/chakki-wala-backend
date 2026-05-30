require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// CORS CONFIGURATION
// ============================================
app.use(cors({
    origin: [
        'http://localhost:3001',
        'http://localhost:3000',
        'http://localhost:5173',
        'https://www.chakkiwalaa.com',
        'https://chakkiwalaa.com',
        'https://chakki-wala-frontend.vercel.app'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key', 'X-Auth-Token']
}));

// Handle preflight requests for ALL routes
app.options('*', cors());

// Parse JSON body
app.use(express.json());
// ============================================
// RATE LIMITING
// ============================================
const limiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, 
    max: 500, 
    message: { error: 'Too many requests' } 
});
app.use('/api/', limiter);

const authLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, 
    max: 50 
});

// ============================================
// DATABASE CONNECTION - USING INDIVIDUAL PARAMETERS
// ============================================
const pool = new Pool({
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
    max: 10,
    connectionTimeoutMillis: 10000,
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ DB error:', err.message);
        console.log('\n📌 Please check your environment variables:');
        console.log('   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD');
    } else {
        console.log('✅ Database connected successfully');
        release();
    }
});

// ============================================
// HELPER FUNCTIONS
// ============================================
function generateToken(userId, mobile) {
    return jwt.sign({ userId, mobile }, process.env.JWT_SECRET, { expiresIn: '6h' });
}

async function verifyToken(req, res, next) {
    const token = req.headers['x-auth-token'];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

function verifyAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ============================================
// HEALTH CHECK - Used by keep-alive ping service
// ============================================
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1'); // Check DB is alive too
        res.status(200).json({ 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()) + 's'
        });
    } catch (err) {
        res.status(500).json({ status: 'db_error', error: err.message });
    }
});

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ status: 'db_error', error: err.message });
    }
});

// ============================================
// AUTH APIS - OTP VERIFICATION
// ============================================

app.post('/api/auth/send-otp', authLimiter, async (req, res) => {
    const { mobile } = req.body;
    if (!mobile || !/^\d{10}$/.test(mobile)) {
        return res.status(400).json({ error: 'Invalid mobile number' });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    console.log(`📱 OTP for ${mobile}: ${otp}`);
    
    // Store OTP in DB so it survives server restarts / cold starts
    await pool.query(
        `INSERT INTO otp_store (mobile, otp, expires_at) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (mobile) DO UPDATE SET otp = $2, expires_at = $3`,
        [mobile, otp, expiresAt]
    );
    
    res.json({ success: true, testOtp: otp });
});

app.post('/api/auth/verify-otp', authLimiter, async (req, res) => {
    const { mobile, otp } = req.body;

    // Fetch OTP from DB
    const otpResult = await pool.query(
        'SELECT * FROM otp_store WHERE mobile = $1',
        [mobile]
    );
    const storedOtp = otpResult.rows[0];
    
    if (!storedOtp || storedOtp.otp !== otp || new Date(storedOtp.expires_at) < new Date()) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
    }
    
    // Delete used OTP
    await pool.query('DELETE FROM otp_store WHERE mobile = $1', [mobile]);
    
    // Check if user exists in database
    let user = await pool.query('SELECT * FROM users WHERE mobile = $1', [mobile]);
    if (user.rows.length === 0) {
        const userId = `USR_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        await pool.query(
            'INSERT INTO users (user_id, mobile, registered_at, last_login_at) VALUES ($1, $2, NOW(), NOW())',
            [userId, mobile]
        );
        user = { rows: [{ user_id: userId, mobile, name: null, email: null, total_orders: 0 }] };
    } else {
        await pool.query('UPDATE users SET last_login_at = NOW() WHERE mobile = $1', [mobile]);
    }
    
    const token = generateToken(user.rows[0].user_id, mobile);
    res.json({ 
        success: true, 
        token, 
        user: { 
            userId: user.rows[0].user_id, 
            mobile: user.rows[0].mobile,
            name: user.rows[0].name,
            email: user.rows[0].email
        } 
    });
});

// ============================================
// PROFILE APIS
// ============================================
app.get('/api/user/profile', verifyToken, async (req, res) => {
    const user = await pool.query(
        'SELECT user_id, mobile, name, email, registered_at, last_login_at, total_orders FROM users WHERE user_id = $1',
        [req.user.userId]
    );
    res.json({ success: true, user: user.rows[0] });
});

app.put('/api/user/profile', verifyToken, async (req, res) => {
    const { name, email } = req.body;
    await pool.query('UPDATE users SET name = $1, email = $2 WHERE user_id = $3', [name || null, email || null, req.user.userId]);
    res.json({ success: true });
});

// ============================================
// ADDRESS APIS
// ============================================
app.get('/api/user/addresses', verifyToken, async (req, res) => {
    const addresses = await pool.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC', [req.user.userId]);
    res.json({ success: true, addresses: addresses.rows });
});

app.post('/api/user/addresses', verifyToken, async (req, res) => {
    const { label, recipientName, recipientMobile, addressLine1, addressLine2, city, state, pincode, landmark, isDefault } = req.body;
    const addressId = `ADR_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    
    if (isDefault) {
        await pool.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [req.user.userId]);
    }
    
    await pool.query(
        `INSERT INTO addresses (address_id, user_id, label, recipient_name, recipient_mobile, address_line1, address_line2, city, state, pincode, landmark, is_default) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [addressId, req.user.userId, label, recipientName, recipientMobile, addressLine1, addressLine2, city, state, pincode, landmark, isDefault || false]
    );
    res.json({ success: true });
});

app.delete('/api/user/addresses/:id', verifyToken, async (req, res) => {
    const address = await pool.query('SELECT is_default FROM addresses WHERE address_id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
    if (address.rows[0]?.is_default) {
        return res.status(400).json({ error: 'Cannot delete default address' });
    }
    await pool.query('DELETE FROM addresses WHERE address_id = $1 AND user_id = $2', [req.params.id, req.user.userId]);
    res.json({ success: true });
});

// ============================================
// CART APIS
// ============================================
app.get('/api/cart', verifyToken, async (req, res) => {
    const cart = await pool.query('SELECT items FROM carts WHERE user_id = $1', [req.user.userId]);
    const items = cart.rows[0]?.items || [];
    res.json({ success: true, cart: { items }, cartCount: items.reduce((s, i) => s + (i.quantity || 0), 0) });
});

app.post('/api/cart/add', verifyToken, async (req, res) => {
    const { productId, name, price, weight, quantity, image } = req.body;
    let cart = await pool.query('SELECT items FROM carts WHERE user_id = $1', [req.user.userId]);
    let items = cart.rows[0]?.items || [];
    
    const idx = items.findIndex(i => i.productId === productId && i.weight === weight);
    if (idx >= 0) {
        items[idx].quantity += quantity;
    } else {
        items.push({ productId, name, price, weight, quantity, image, addedAt: new Date().toISOString() });
    }
    
    await pool.query(
        `INSERT INTO carts (user_id, items, updated_at) VALUES ($1, $2, NOW()) 
         ON CONFLICT (user_id) DO UPDATE SET items = $2, updated_at = NOW()`,
        [req.user.userId, JSON.stringify(items)]
    );
    
    res.json({ success: true, cartCount: items.reduce((s, i) => s + i.quantity, 0) });
});

app.put('/api/cart/update', verifyToken, async (req, res) => {
    const { productId, weight, quantity } = req.body;
    let cart = await pool.query('SELECT items FROM carts WHERE user_id = $1', [req.user.userId]);
    let items = cart.rows[0]?.items || [];
    
    const idx = items.findIndex(i => i.productId === productId && i.weight === weight);
    if (idx >= 0) {
        if (quantity <= 0) {
            items.splice(idx, 1);
        } else {
            items[idx].quantity = quantity;
        }
    }
    
    await pool.query('UPDATE carts SET items = $1, updated_at = NOW() WHERE user_id = $2', [JSON.stringify(items), req.user.userId]);
    res.json({ success: true });
});

app.delete('/api/cart/remove', verifyToken, async (req, res) => {
    const { productId, weight } = req.body;
    let cart = await pool.query('SELECT items FROM carts WHERE user_id = $1', [req.user.userId]);
    let items = cart.rows[0]?.items || [];
    items = items.filter(i => !(i.productId === productId && i.weight === weight));
    await pool.query('UPDATE carts SET items = $1, updated_at = NOW() WHERE user_id = $2', [JSON.stringify(items), req.user.userId]);
    res.json({ success: true });
});

app.post('/api/cart/sync', verifyToken, async (req, res) => {
    const { guestItems } = req.body;
    if (guestItems && guestItems.length > 0) {
        let cart = await pool.query('SELECT items FROM carts WHERE user_id = $1', [req.user.userId]);
        let items = cart.rows[0]?.items || [];
        
        for (const guestItem of guestItems) {
            const idx = items.findIndex(i => i.productId === guestItem.productId && i.weight === guestItem.weight);
            if (idx >= 0) {
                items[idx].quantity += guestItem.quantity;
            } else {
                items.push(guestItem);
            }
        }
        
        await pool.query('UPDATE carts SET items = $1, updated_at = NOW() WHERE user_id = $2', [JSON.stringify(items), req.user.userId]);
    }
    res.json({ success: true });
});

// ============================================
// DELIVERY SLOTS
// ============================================
app.get('/api/delivery-slots', (req, res) => {
    const isAfter6PM = new Date().getHours() >= 18;
    res.json({
        success: true,
        slots: [
            { id: 'morning', name: 'Morning', time: '12:00 PM - 04:00 PM', isAvailable: !isAfter6PM },
            { id: 'evening', name: 'Evening', time: '04:00 PM - 08:00 PM', isAvailable: true },
            { id: 'night', name: 'Night', time: '08:00 PM - 10:00 PM', isAvailable: true }
        ],
        isAfter6PM
    });
});

// ============================================
// ORDER APIS
// ============================================
app.post('/api/order/place', verifyToken, async (req, res) => {
    try {
        const { address, deliverySlot, paymentMethod, items, subtotal, deliveryFee, gst, total } = req.body;
        
        const orderId = `CKW-${Date.now()}`;
        const now = new Date();
        const orderDate = now.toISOString().split('T')[0];
        const orderTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        
        const userResult = await pool.query('SELECT * FROM users WHERE user_id = $1', [req.user.userId]);
        const user = userResult.rows[0];
        
        let customerName = address.recipientName || address.name || user.name || 'Customer';
        let customerMobile = address.recipientMobile || address.mobile || user.mobile;
        
        let fullAddress = address.fullAddress;
        if (!fullAddress && address.addressLine1) {
            fullAddress = `${address.addressLine1}, ${address.addressLine2 || ''}, ${address.city || ''}, ${address.state || ''} - ${address.pincode || ''}`;
        }
        
        const addressObj = {
            recipientName: customerName,
            recipientMobile: customerMobile,
            fullAddress: fullAddress || 'Address not specified'
        };
        
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            await client.query(
                `INSERT INTO orders 
                 (order_id, user_id, order_date, order_time, order_status, payment_method, 
                  delivery_slot, customer_name, customer_mobile, subtotal, gst, delivery_fee, 
                  order_total, address_json, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
                [orderId, req.user.userId, orderDate, orderTime, 'Confirmed', paymentMethod,
                 deliverySlot, customerName, customerMobile, 
                 Number(subtotal) || 0, Number(gst) || 0, Number(deliveryFee) || 0, 
                 Number(total) || 0, JSON.stringify(addressObj)]
            );
            
            for (const item of items) {
                await client.query(
                    `INSERT INTO order_items (order_id, product_name, weight, quantity, price, total) 
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [orderId, item.name, item.weight, item.quantity, item.price, item.price * item.quantity]
                );
            }
            
            await client.query('UPDATE users SET total_orders = total_orders + 1 WHERE user_id = $1', [req.user.userId]);
            await client.query('UPDATE carts SET items = $1 WHERE user_id = $2', ['[]', req.user.userId]);
            
            await client.query('COMMIT');
            console.log('✅ Order success:', orderId);
            res.json({ success: true, orderId, orderTotal: total });
            
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('❌ Order error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/orders', verifyToken, async (req, res) => {
    const orders = await pool.query(
        `SELECT o.*, COALESCE(json_agg(oi.*) FILTER (WHERE oi.id IS NOT NULL), '[]') as items 
         FROM orders o 
         LEFT JOIN order_items oi ON o.order_id = oi.order_id 
         WHERE o.user_id = $1 
         GROUP BY o.order_id 
         ORDER BY o.created_at DESC`,
        [req.user.userId]
    );
    res.json({ success: true, orders: orders.rows });
});

app.post('/api/order/cancel', verifyToken, async (req, res) => {
    const { orderId } = req.body;
    const order = await pool.query('SELECT * FROM orders WHERE order_id = $1 AND user_id = $2', [orderId, req.user.userId]);
    if (order.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    
    const orderData = order.rows[0];
    const hoursSince = (Date.now() - new Date(orderData.created_at).getTime()) / (1000 * 60 * 60);
    
    if (orderData.order_status !== 'Confirmed') {
        return res.status(400).json({ error: 'Order cannot be cancelled at this stage' });
    }
    if (hoursSince > 2) {
        return res.status(400).json({ error: 'Cancellation only within 2 hours' });
    }
    
    await pool.query('UPDATE orders SET order_status = $1 WHERE order_id = $2', ['Cancelled', orderId]);
    res.json({ success: true });
});

// ============================================
// ADMIN APIS
// ============================================
app.get('/api/admin/orders', verifyAdmin, async (req, res) => {
    const orders = await pool.query(
        `SELECT o.*, COALESCE(json_agg(oi.*) FILTER (WHERE oi.id IS NOT NULL), '[]') as items 
         FROM orders o 
         LEFT JOIN order_items oi ON o.order_id = oi.order_id 
         GROUP BY o.order_id 
         ORDER BY o.created_at DESC`
    );
    res.json({ success: true, orders: orders.rows });
});

app.post('/api/admin/update-order-status', verifyAdmin, async (req, res) => {
    const { orderId, status } = req.body;
    await pool.query('UPDATE orders SET order_status = $1 WHERE order_id = $2', [status, orderId]);
    res.json({ success: true });
});

app.get('/api/admin/users', verifyAdmin, async (req, res) => {
    const users = await pool.query('SELECT * FROM users ORDER BY registered_at DESC');
    res.json({ success: true, users: users.rows });
});

app.get('/api/admin/export-users-csv', verifyAdmin, async (req, res) => {
    const users = await pool.query('SELECT * FROM users ORDER BY registered_at DESC');
    let csv = 'User ID,Mobile,Name,Email,Registered At,Last Login At,Total Orders\n';
    users.rows.forEach(u => {
        csv += `"${u.user_id}","${u.mobile}","${u.name || ''}","${u.email || ''}","${u.registered_at}","${u.last_login_at || ''}",${u.total_orders}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
    res.send(csv);
});

app.get('/api/export/csv', verifyAdmin, async (req, res) => {
    const orders = await pool.query(
        `SELECT o.*, COALESCE(json_agg(oi.*) FILTER (WHERE oi.id IS NOT NULL), '[]') as items 
         FROM orders o 
         LEFT JOIN order_items oi ON o.order_id = oi.order_id 
         GROUP BY o.order_id 
         ORDER BY o.created_at DESC`
    );
    let csv = 'Order ID,Date,Customer Name,Mobile,Status,Payment Method,Delivery Slot,Subtotal,GST,Delivery Fee,Total,Address\n';
    orders.rows.forEach(o => {
        const addr = typeof o.address_json === 'string' ? JSON.parse(o.address_json) : o.address_json;
        csv += `"${o.order_id}","${o.order_date}","${o.customer_name}","${o.customer_mobile}","${o.order_status}","${o.payment_method}","${o.delivery_slot}",${o.subtotal},${o.gst},${o.delivery_fee},${o.order_total},"${addr?.fullAddress || ''}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
    res.send(csv);
});

// ============================================
// STATIC FILES & ADMIN PANEL
// ============================================
app.use('/admin', express.static(path.join(__dirname, 'public')));
app.use('/Images', express.static(path.join(__dirname, 'public/Images')));
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log('==================================================');
    console.log('🚀 Chakki Wala Backend');
    console.log(`📡 http://localhost:${PORT}`);
    console.log(`🔧 Admin: http://localhost:${PORT}/admin`);
    console.log('==================================================');
});