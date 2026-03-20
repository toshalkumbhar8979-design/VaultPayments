# NexusPay Gateway Integration Guide

Welcome to NexusPay! This guide will show you how to accept payments in your application using the NexusPay Gateway.

## Prerequisites

1. Your friend (the NexusPay admin) must deploy the backend and provide you with the **Base API URL** (e.g., `https://api.their-nexuspay.com/api/v1`).
2. You need to create an account on their NexusPay Merchant Dashboard.
3. Once registered, grab your **Live API Key** from the `API Keys` section in the Dashboard.

## Step 1: Create a Payment

When a user on your app clicks "Checkout", your server should make an API request to NexusPay to generate a payment link.

**Required Headers:**
- `Content-Type: application/json`
- `X-NexusPay-Key: <YOUR_LIVE_API_KEY>`

**Endpoint:** `POST {BASE_URL}/payments/create`

**Request Body Example (JSON):**
```json
{
  "order_id": "YOUR_INTERNAL_ORDER_123",
  "amount": 49900, // Amount in lowest denomination (e.g., 49900 paise = ₹499.00)
  "currency": "INR",
  "customer": {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": "+919876543210"
  },
  "description": "Premium Subscription",
  "redirect_url": "https://your-website.com/payment/success"
}
```

**Response Example:**
```json
{
  "success": true,
  "data": {
    "id": "pay_xyz123",
    "gateway_url": "https://their-nexuspay.com/pay/?id=pay_xyz123",
    "qr_code": "data:image/png;base64,..."
  }
}
```

## Step 2: Display the Checkout

You have two options to display the checkout to the user:
1. **Redirect:** Redirect the user's browser directly to the `gateway_url` returned in Step 1.
2. **Custom UI:** Show the `qr_code` image directly on your own website/app and ask them to scan it.

If you choose the redirect method, NexusPay will securely handle the payment display and automatically redirect them back to your `redirect_url` once completed.

## Step 3: Verify the Payment (Webhooks)

To know when a payment actually succeeds, you should listen for Webhooks from NexusPay.

1. Go to your NexusPay Dashboard -> Settings and set your **Webhook URL** (e.g., `https://your-server.com/api/webhooks/nexuspay`).
2. Copy your **Webhook Secret** from the API Keys page.

When a payment succeeds, NexusPay will POST to your backend:
```json
{
  "event": "payment.captured",
  "payment": {
    "id": "pay_xyz123",
    "order_id": "YOUR_INTERNAL_ORDER_123",
    "amount": 49900,
    "status": "captured"
  }
}
```

### Important: Secure your Webhook Endpoint
You must verify the webhook is genuinely from NexusPay by checking the `X-NexusPay-Signature` header.
Compute an HMAC SHA256 signature of the raw request body using your **Webhook Secret**, and compare it against the header.

**Node.js Example:**
```javascript
const crypto = require('crypto');

app.post('/webhook/nexuspay', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-nexuspay-signature'];
  const expected = crypto.createHmac('sha256', 'YOUR_WEBHOOK_SECRET')
                         .update(req.body)
                         .digest('hex');

  if (signature !== expected) {
    return res.status(401).send('Invalid signature');
  }

  const payload = JSON.parse(req.body);
  if (payload.event === 'payment.captured') {
    // Fulfill the order in your database!
    completeOrder(payload.payment.order_id);
  }
  
  res.send('OK');
});
```

You are now fully integrated with NexusPay! You can find pre-built SDKs for Node, Python, and PHP inside the `/sdk/` folder of the NexusPay repository.
