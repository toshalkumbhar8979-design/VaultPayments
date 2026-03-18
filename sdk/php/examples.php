<?php
/**
 * VaultPay PHP SDK — Usage Examples
 *
 * Run: php examples.php
 * (Requires VaultPay backend running at localhost:5000)
 */

declare(strict_types=1);

require_once __DIR__ . '/VaultPay.php';

use VaultPay\Client;
use VaultPay\VaultPayException;

$apiKey  = getenv('VAULTPAY_API_KEY') ?: 'vp_test_00000000000000000000000000000000';
$baseUrl = getenv('VAULTPAY_BASE_URL') ?: 'http://localhost:5000/api/v1';

echo "\n🔑 VaultPay PHP SDK Examples\n";
echo "   Key: " . substr($apiKey, 0, 16) . "...\n";
echo "   URL: $baseUrl\n\n";

// ── Init client ───────────────────────────────────────────────
$vp = new Client($apiKey, $baseUrl);
echo "   Mode: " . ($vp->isLiveMode() ? '🟢 LIVE' : '🟡 TEST') . "\n\n";

// ── Example 1: Create payment ─────────────────────────────────
echo "▶ Creating payment...\n";
try {
    $payment = $vp->payments->create([
        'order_id'     => 'PHP-' . time(),
        'amount'       => 49900,
        'currency'     => 'INR',
        'customer'     => [
            'name'  => 'PHP Test User',
            'email' => 'php@example.com',
            'phone' => '+919999999999',
        ],
        'description'  => 'PHP SDK Test Payment',
        'redirect_url' => 'https://yoursite.com/success',
    ]);

    echo "  ✅ Payment ID:  {$payment['payment_id']}\n";
    echo "  💰 Amount:      {$payment['amount_formatted']}\n";
    echo "  🔗 Checkout:    {$payment['gateway_url']}\n";
    echo "  📱 QR (first 60 chars): " . substr($payment['qr_code'], 0, 60) . "...\n\n";

    $paymentId = $payment['payment_id'];

    // ── Example 2: Fetch payment ──────────────────────────────
    echo "▶ Fetching payment...\n";
    $fetched = $vp->payments->fetch($paymentId);
    echo "  ✅ Status: {$fetched['status']}\n\n";

    // ── Example 3: Parse SMS ──────────────────────────────────
    echo "▶ Parsing bank SMS...\n";
    $smsResult = $vp->sms->parse(
        "Your a/c XXXX1234 is credited INR 499.00 by UPI. Ref No: 312456789012. -HDFC Bank",
        $paymentId
    );
    echo "  ✅ Parsed Amount: ₹{$smsResult['parsed']['amount']}\n";
    echo "  ✅ Bank:          {$smsResult['parsed']['bank']}\n";
    echo "  ✅ Action:        {$smsResult['action_taken']}\n\n";

    // ── Example 4: Generate QR ────────────────────────────────
    echo "▶ Generating QR code...\n";
    $qrUri = $vp->qr->generate("upi://pay?pa=test@upi&am=499&cu=INR");
    echo "  ✅ QR generated: " . strlen($qrUri) . " bytes\n\n";

    echo "✅ All PHP examples passed!\n\n";

} catch (VaultPayException $e) {
    echo "❌ Error: " . $e->getMessage() . "\n";
    echo "   Code: "   . $e->getErrorCode() . "\n";
    echo "   HTTP: "   . $e->getStatusCode() . "\n";
    exit(1);
}

// ── Example 5: Webhook signature verification ────────────────
echo "▶ Testing webhook verification...\n";
$secret  = 'test_webhook_secret';
$payload = json_encode(['event' => 'payment.captured', 'data' => ['id' => 'pay_abc']]);
$sig     = 'sha256=' . hash_hmac('sha256', $payload, $secret);

$valid = Client::verifyWebhookSignature($payload, $sig, $secret);
$invalid = Client::verifyWebhookSignature($payload, 'sha256=wrong', $secret);
echo "  ✅ Valid signature:   " . ($valid   ? 'true' : 'false') . "\n";
echo "  ✅ Invalid signature: " . ($invalid ? 'true' : 'false') . "\n\n";

// ── Webhook handler boilerplate ───────────────────────────────
echo "▶ Webhook handler template:\n\n";
echo <<<'CODE'
<?php
// webhook.php — POST endpoint for VaultPay events

require_once 'VaultPay.php';
use VaultPay\Client;

$rawBody  = file_get_contents('php://input');
$signature = $_SERVER['HTTP_X_VAULTPAY_SIGNATURE'] ?? '';
$secret   = getenv('VAULTPAY_WEBHOOK_SECRET');

// ALWAYS verify before processing
if (!Client::verifyWebhookSignature($rawBody, $signature, $secret)) {
    http_response_code(401);
    echo json_encode(['error' => 'Invalid signature']);
    exit;
}

$payload = json_decode($rawBody, true);
$event   = $payload['event'] ?? '';
$data    = $payload['data']  ?? [];

switch ($event) {
    case 'payment.captured':
        // ✅ Fulfill the order
        // updateOrderStatus($data['order_id'], 'paid');
        error_log("Payment captured: " . $data['id']);
        break;

    case 'payment.failed':
        error_log("Payment failed: " . $data['id']);
        break;

    case 'payment.refunded':
        error_log("Payment refunded: " . $data['id']);
        break;
}

http_response_code(200);
echo json_encode(['received' => true]);
CODE;
echo "\n\nDone!\n\n";
