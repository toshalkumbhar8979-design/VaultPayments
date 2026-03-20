# Onboarding Your First Merchant to NexusPay

This guide is for **you** (the NexusPay Admin) to help your friend (the Merchant) start accepting payments.

## 1. Provide the URLs
Once you have deployed NexusPay (see `DEPLOY.md`), send these links to your friend:
- **Platform URL:** `https://your-nexuspay-frontend.pages.dev` (The landing page)
- **Signup URL:** `https://your-nexuspay-frontend.pages.dev/signup.html` (Where they create their account)

## 2. Merchant Setup (Friend's Steps)
Ask your friend to follow these steps:
1. **Sign Up:** Go to the Signup URL and create a Merchant account.
2. **Retrieve API Key:** 
   - Log in to the Dashboard.
   - Go to the **API Keys** section.
   - Copy the **Live API Key** (Format: `vp_live_...`).
3. **Set Webhook (Optional but Recommended):**
   - Go to **Settings**.
   - Enter their store's webhook URL (e.g., `https://their-store.com/api/webhooks/nexuspay`) to receive payment confirmations.

## 3. Integration Code (Friend's Store)
Your friend can use the [GATEWAY_INTEGRATION_GUIDE.md](./GATEWAY_INTEGRATION_GUIDE.md) and the pre-built SDKs in the `/sdk` folder.

### Simple Node.js Quickstart for your friend:
```bash
# They copy your sdk/node/nexuspay.js into their project
npm install node-fetch
```

```javascript
const NexusPay = require('./nexuspay');
const vp = new NexusPay('vp_live_THEIR_API_KEY', {
  baseUrl: 'https://your-nexuspay-backend.railway.app/api/v1'
});

// Create a payment
async function startPayment() {
  const payment = await vp.payments.create({
    order_id: 'ORDER_123',
    amount: 100000, // Rs. 1000.00
    currency: 'INR',
    customer: { name: 'Customer Name', email: 'cust@email.com', phone: '9999999999' }
  });
  
  console.log('Send customer here:', payment.gateway_url);
}
```

## 4. Need Help?
Check the `DEPLOY.md` for full backend setup or reach out to the developer!
