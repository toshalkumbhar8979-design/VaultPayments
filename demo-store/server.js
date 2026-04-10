'use strict';
/**
 * merchant-demo-server.js
 * A minimal Express server showing how to integrate NexusPay.
 * 
 * Usage:
 *   1. Copy sdk/node/nexuspay.js to this folder.
 *   2. npm install express
 *   3. node merchant-demo-server.js
 */

const express = require('express');
const path = require('path');
const NexusPay = require('../sdk/node/nexuspay'); // Pointing to the local SDK

const app = express();
const PORT = 3000;

// 1. Initialize NexusPay SDK with your Merchant API Key
// Replace with your real test/live key from the NexusPay dashboard.
const NEXUSPAY_KEY = 'vp_live_d2bf45f41e9c2b6bf270e1bb5d319b7c';
const vp = new NexusPay(NEXUSPAY_KEY, {
    baseUrl: 'http://localhost:5000/api/v1' // Pointing to our local running instance
});

app.use(express.json());
app.use(express.static(__dirname));

// 2. The Checkout Endpoint (Called from frontend)
app.post('/checkout', async (req, res) => {
    try {
        const { total, customerName, customerEmail, customerPhone } = req.body;

        // Create a payment order on NexusPay
        const payment = await vp.payments.create({
            order_id: `DEMO-${Date.now()}`,
            amount: 100, // Hardcoded Rs 1 for testing (100 paise)
            currency: 'INR',
            customer: {
                name: customerName,
                email: customerEmail,
                phone: customerPhone
            },
            description: 'Nexus One Headset — Demo Purchase',
            redirect_url: `http://localhost:${PORT}/success.html`,
            callback_url: `http://localhost:${PORT}/webhook`, // Webhook for real-time order fulfillment
        });

        // Send the gateway URL back to the frontend to redirect the customer
        console.log(`✅ Payment Created: ${payment.id}`);
        res.json({ gateway_url: payment.gateway_url });
    } catch (err) {
        console.error('❌ NexusPay API Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 3. The Webhook Handler (Called by NexusPay)
// This is how your store knows the payment was actually successful.
app.post('/webhook', (req, res) => {
    const signature = req.headers['x-nexuspay-signature'];
    const secret = 'f1e2d3c4b5a697887766554433221100'; // Your Webhook Secret from Settings

    // ALWAYS verify the signature to prevent fraudulent requests
    const isValid = NexusPay.verifyWebhookSignature(JSON.stringify(req.body), signature, secret);

    if (!isValid) {
        console.warn('⚠️ Invalid Webhook Signature received!');
        return res.status(401).send('Unauthorized');
    }

    const { event, data } = req.body;

    if (event === 'payment.captured') {
        console.log(`💰 [WEBHOOK] Payment Captured for Order ${data.order_id}!`);
        console.log(`   Amount: ₹${data.amount / 100} | Payment ID: ${data.id}`);
        // FULFILL YOUR ORDER HERE (e.g. Update DB, send email, ship product)
    }

    res.json({ received: true });
});

app.listen(PORT, () => {
    console.log(`🛒 Demo Store running at http://localhost:${PORT}`);
    console.log(`   Using NexusPay API at: ${vp._base}`);
});
