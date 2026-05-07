const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify([], null, 2));
    console.log('✅ Created orders.json');
}

let orders = [];
function loadOrders() {
    try {
        const data = fs.readFileSync(ORDERS_FILE, 'utf8');
        orders = JSON.parse(data);
        console.log(`📦 Loaded ${orders.length} orders`);
    } catch (err) {
        orders = [];
    }
}

function saveOrders() {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    console.log(`💾 Saved ${orders.length} orders`);
}

loadOrders();

const sessions = new Map();
const otpStore = new Map();

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ==================== AUTH ENDPOINTS ====================

app.post('/api/send-otp', (req, res) => {
    const { mobile } = req.body;
    console.log(`📱 Send OTP: ${mobile}`);
    
    if (!mobile || mobile.length !== 10) {
        return res.status(400).json({ success: false, error: 'Invalid mobile number' });
    }
    
    const otp = generateOTP();
    otpStore.set(mobile, { otp, expires: Date.now() + 300000 });
    console.log(`🔑 OTP for ${mobile}: ${otp}`);
    
    res.json({ success: true, testOtp: otp });
});

app.post('/api/verify-otp', (req, res) => {
    const { mobile, otp, userName } = req.body;
    console.log(`✅ Verify OTP: ${mobile}`);
    
    const stored = otpStore.get(mobile);
    if (!stored || stored.otp !== otp) {
        return res.status(400).json({ success: false, error: 'Invalid OTP' });
    }
    
    const userId = 'USER_' + Date.now();
    const sessionId = 'SESS_' + Date.now();
    sessions.set(sessionId, {
        userId,
        mobile,
        name: userName || `User_${mobile.slice(-4)}`
    });
    
    otpStore.delete(mobile);
    
    res.json({
        success: true,
        sessionId,
        user: { userId, mobile, name: userName || `User_${mobile.slice(-4)}` }
    });
});

app.get('/api/addresses/:sessionId', (req, res) => {
    const user = sessions.get(req.params.sessionId);
    if (!user) return res.status(401).json({ success: false });
    res.json({ success: true, addresses: [] });
});

app.post('/api/address/save', (req, res) => {
    const { sessionId, recipientName } = req.body;
    const user = sessions.get(sessionId);
    if (user && recipientName) {
        user.name = recipientName;
        sessions.set(sessionId, user);
    }
    res.json({ success: true });
});

app.get('/api/cart/:sessionId', (req, res) => {
    res.json({ success: true, cart: [], cartCount: 0 });
});

app.post('/api/cart/add', (req, res) => {
    res.json({ success: true, cartCount: 1 });
});

// ==================== ORDER ENDPOINTS ====================

app.post('/api/order/place', (req, res) => {
    console.log('\n========================================');
    console.log('🛒 ORDER PLACEMENT REQUEST');
    console.log('========================================');
    
    const { sessionId, address, deliverySlot, paymentMethod, customerName, orderDetails } = req.body;
    
    const user = sessions.get(sessionId);
    if (!user) {
        console.log('❌ ERROR: User not found for session:', sessionId);
        return res.status(401).json({ success: false, error: 'Please login first' });
    }
    
    // Use the customer name from address if provided, otherwise use session name
    const finalCustomerName = customerName || user.name;
    
    console.log(`👤 Customer: ${finalCustomerName} (${user.mobile})`);
    console.log(`📦 Items: ${orderDetails?.items?.length || 0}`);
    console.log(`💰 Amount: ${orderDetails?.total || 0}`);
    
    const orderId = 'CKW-' + Date.now();
    const now = new Date();
    const orderDate = now.toISOString().split('T')[0];
    const orderTime = now.toLocaleTimeString();
    const items = orderDetails?.items || [];
    
    let subtotal = 0;
    for (const item of items) {
        subtotal += item.price * item.quantity;
    }
    
    const gst = subtotal * 0.05;
    const deliveryFee = subtotal >= 500 ? 0 : 40;
    const grandTotal = subtotal + gst + deliveryFee;
    
    const newOrder = {
        orderId,
        orderDate,
        orderTime,
        orderStatus: 'Confirmed',
        paymentMethod,
        deliverySlot,
        customerName: finalCustomerName,
        customerMobile: user.mobile,
        orderTotal: grandTotal,
        address: address || 'No address provided',
        createdAt: now.toISOString(),
        items: items.map(item => ({
            name: item.name,
            weight: item.weight,
            quantity: item.quantity,
            price: item.price
        }))
    };
    
    orders.unshift(newOrder);
    saveOrders();
    
    console.log(`✅ ORDER SAVED: ${orderId}`);
    console.log(`📊 Total orders: ${orders.length}`);
    console.log('========================================\n');
    
    res.json({ success: true, orderId, orderTotal: grandTotal });
});

app.get('/api/order/:orderId', (req, res) => {
    const order = orders.find(o => o.orderId === req.params.orderId);
    if (!order) {
        return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, order });
});

app.get('/api/orders/:sessionId', (req, res) => {
    const user = sessions.get(req.params.sessionId);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Session expired' });
    }
    
    const userOrders = orders.filter(o => o.customerMobile === user.mobile);
    res.json({ success: true, orders: userOrders });
});

app.post('/api/order/cancel', (req, res) => {
    const { sessionId, orderId } = req.body;
    const user = sessions.get(sessionId);
    if (!user) return res.status(401).json({ success: false });
    
    const order = orders.find(o => o.orderId === orderId);
    if (!order) return res.status(404).json({ success: false });
    
    if (order.orderStatus !== 'Confirmed' && order.orderStatus !== 'Processing') {
        return res.status(400).json({ success: false, error: 'Order cannot be cancelled' });
    }
    
    order.orderStatus = 'Cancelled';
    saveOrders();
    res.json({ success: true, message: 'Order cancelled. Refund initiated.' });
});

// ==================== ADMIN ENDPOINTS ====================

app.get('/api/admin/orders', (req, res) => {
    const { adminKey } = req.query;
    
    if (adminKey !== 'chakkiwala@2024') {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    res.json({ success: true, orders });
});

app.post('/api/admin/update-order-status', (req, res) => {
    const { orderId, status, adminKey } = req.body;
    
    if (adminKey !== 'chakkiwala@2024') {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const order = orders.find(o => o.orderId === orderId);
    if (order) {
        order.orderStatus = status;
        saveOrders();
        console.log(`📦 Order ${orderId} status updated to: ${status}`);
    }
    
    res.json({ success: true });
});

app.get('/api/export/csv', (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== 'chakkiwala@2024') {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    let csvContent = 'Order ID,Date,Time,Status,Customer Name,Customer Mobile,Delivery Slot,Payment Method,Order Total,Address,Products\n';
    for (const order of orders) {
        const products = (order.items || []).map(item => `${item.name} x${item.quantity}`).join('; ');
        csvContent += `"${order.orderId}","${order.orderDate}","${order.orderTime}","${order.orderStatus}","${order.customerName}","${order.customerMobile}","${order.deliverySlot}","${order.paymentMethod}","${order.orderTotal}","${order.address}","${products}"\n`;
    }
    
    res.setHeader('Content-Disposition', 'attachment; filename="chakki_wala_orders.csv"');
    res.setHeader('Content-Type', 'text/csv');
    res.send(csvContent);
});

app.post('/api/logout', (req, res) => {
    const { sessionId } = req.body;
    sessions.delete(sessionId);
    res.json({ success: true });
});

app.get('/api/test', (req, res) => {
    res.json({ success: true, message: 'API is working!', ordersCount: orders.length });
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-panel.html'));
});

app.listen(PORT, () => {
    console.log('\n========================================');
    console.log('🚀 Chakki Wala Backend Server');
    console.log('========================================');
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`🔧 Admin Panel: http://localhost:${PORT}/admin`);
    console.log(`🔑 Admin Password: chakkiwala@2024`);
    console.log('========================================\n');
});
