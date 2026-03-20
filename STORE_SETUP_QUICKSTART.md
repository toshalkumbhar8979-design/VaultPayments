# 🛒 Store Integration Quickstart (For Your Friend)

Give this to your friend! It shows exactly how to add NexusPay to their online store using Node.js.

## 1. Setup
Ask your friend to copy the `sdk/node/nexuspay.js` file into their project and install `node-fetch`:
```bash
npm install node-fetch
```

## 2. Create a Payment (Server-Side)
When a customer clicks "Checkout" on their store, they should run this:

```javascript
const NexusPay = require('./nexuspay');

// Configuration
const vp = new NexusPay('vp_live_THEIR_API_KEY', {
  baseUrl: 'https://your-nexuspay-backend.railway.app/api/v1' // YOUR Railway URL
});

app.post('/checkout', async (req, res) => {
  try {
    const payment = await vp.payments.create({
      order_id: `INV-${Date.now()}`,
      amount: req.body.total * 100, // Rs. 500.50 -> 50050 paise
      currency: 'INR',
      customer: {
        name: req.body.customerName,
        email: req.body.customerEmail,
        phone: req.body.customerPhone
      },
      description: 'Order from My Awesome Store',
      redirect_url: 'https://their-store.com/order-success',
      callback_url: 'https://their-store.com/api/webhooks/nexuspay'
    });

    // Send the customer to the NexusPay checkout page
    res.redirect(payment.gateway_url);
  } catch (err) {
    console.error('NexusPay Error:', err.message);
    res.status(500).send('Payment initialization failed');
  }
});
```

## 3. Handle the Webhook (Payment Confirmation)
This is how their store knows the payment was actually paid:

```javascript
app.post('/api/webhooks/nexuspay', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-nexuspay-signature'];
  const secret = 'THEIR_WEBHOOK_SECRET'; // From their merchant settings

  // ALWAYS verify the signature first!
  const isValid = NexusPay.verifyWebhookSignature(req.body, signature, secret);

  if (!isValid) return res.status(401).send('Invalid Signature');

  const { event, data } = JSON.parse(req.body);

  if (event === 'payment.captured') {
    console.log(`✅ Payment received for Order ${data.order_id}!`);
    // Fulfill the order in their database here
  }

  res.json({ success: true });
});
```

## 4. That's it!
Your friend is now accepting payments via **NexusPay**. They can see all transactions in their dashboard at your platform URL.
