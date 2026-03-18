<?php
/**
 * ╔══════════════════════════════════════════════════╗
 * ║         VaultPay PHP SDK v1.0                    ║
 * ║   Secure Payment Gateway for PHP Developers      ║
 * ╚══════════════════════════════════════════════════╝
 *
 * Requirements: PHP 7.4+, cURL extension
 *
 * Usage:
 *   require_once 'VaultPay.php';
 *   $vp = new VaultPay\Client('vp_live_YOUR_API_KEY');
 *
 *   $payment = $vp->payments->create([
 *       'order_id'  => 'ORD-001',
 *       'amount'    => 49900,
 *       'currency'  => 'INR',
 *       'customer'  => [
 *           'name'  => 'Arjun Sharma',
 *           'email' => 'arjun@example.com',
 *           'phone' => '+919876543210',
 *       ],
 *       'description'  => 'Premium Plan',
 *       'redirect_url' => 'https://yoursite.com/success',
 *   ]);
 *   header('Location: ' . $payment['gateway_url']);
 */

declare(strict_types=1);

namespace VaultPay;

// ─── Exceptions ───────────────────────────────────────────────────────────────

class VaultPayException extends \RuntimeException
{
    private string $errorCode;
    private int    $statusCode;
    private mixed  $raw;

    public function __construct(
        string $message,
        string $errorCode = 'API_ERROR',
        int    $statusCode = 0,
        mixed  $raw = null
    ) {
        parent::__construct($message);
        $this->errorCode  = $errorCode;
        $this->statusCode = $statusCode;
        $this->raw        = $raw;
    }

    public function getErrorCode(): string { return $this->errorCode; }
    public function getStatusCode(): int   { return $this->statusCode; }
    public function getRaw(): mixed        { return $this->raw; }
}

class AuthException        extends VaultPayException {}
class ValidationException  extends VaultPayException {}
class NotFoundException    extends VaultPayException {}
class NetworkException     extends VaultPayException {}

// ─── Main Client ──────────────────────────────────────────────────────────────

class Client
{
    private const SDK_VERSION = '1.0.0';

    private string $apiKey;
    private string $baseUrl;
    private int    $timeout;
    private bool   $isLive;

    public PaymentsResource $payments;
    public QRResource       $qr;
    public SMSResource      $sms;

    /**
     * @param string $apiKey  Your VaultPay key (vp_live_... or vp_test_...)
     * @param string $baseUrl Override API base URL (optional)
     * @param int    $timeout Request timeout in seconds (default 30)
     * @throws VaultPayException
     */
    public function __construct(
        string $apiKey,
        string $baseUrl = 'https://api.vaultpay.io/api/v1',
        int    $timeout = 30
    ) {
        if (empty($apiKey)) {
            throw new VaultPayException('api_key is required', 'MISSING_API_KEY');
        }
        if (!preg_match('/^vp_(live|test)_[a-f0-9]{32}$/', $apiKey)) {
            throw new VaultPayException(
                'Invalid API key format. Expected: vp_live_... or vp_test_...',
                'INVALID_API_KEY_FORMAT'
            );
        }

        $this->apiKey  = $apiKey;
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->timeout = $timeout;
        $this->isLive  = str_starts_with($apiKey, 'vp_live_');

        $this->payments = new PaymentsResource($this);
        $this->qr       = new QRResource($this);
        $this->sms      = new SMSResource($this);
    }

    public function isLiveMode(): bool { return $this->isLive; }
    public function isTestMode(): bool { return !$this->isLive; }

    /**
     * Make an authenticated HTTP request to the VaultPay API.
     *
     * @param  string     $method  GET | POST | PUT | DELETE
     * @param  string     $path    API path, e.g. '/payments/create'
     * @param  array|null $body    Request body (will be JSON-encoded)
     * @return array               Parsed 'data' from API response
     * @throws VaultPayException
     */
    public function request(string $method, string $path, ?array $body = null): array
    {
        if (!extension_loaded('curl')) {
            throw new NetworkException('cURL PHP extension is required', 'CURL_MISSING');
        }

        $url     = $this->baseUrl . $path;
        $payload = $body !== null ? json_encode($body) : null;

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeout,
            CURLOPT_CUSTOMREQUEST  => strtoupper($method),
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'Accept: application/json',
                'X-VaultPay-Key: ' . $this->apiKey,
                'X-VaultPay-SDK: php/' . self::SDK_VERSION,
                'User-Agent: VaultPay-SDK-PHP/' . self::SDK_VERSION,
            ],
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);

        if ($payload !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
        }

        $rawResponse = curl_exec($ch);
        $httpCode    = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError   = curl_error($ch);
        curl_close($ch);

        if ($curlError) {
            throw new NetworkException("cURL error: $curlError", 'CURL_ERROR');
        }

        $parsed = json_decode($rawResponse, true);
        if ($parsed === null) {
            throw new VaultPayException(
                'Failed to parse API response',
                'PARSE_ERROR',
                $httpCode,
                $rawResponse
            );
        }

        if (!($parsed['success'] ?? false)) {
            $error  = $parsed['error'] ?? [];
            $msg    = $error['message'] ?? "HTTP $httpCode error";
            $code   = $error['code']    ?? 'API_ERROR';

            match (true) {
                $httpCode === 401                        => throw new AuthException($msg, $code, $httpCode, $parsed),
                $httpCode === 400 || $httpCode === 422   => throw new ValidationException($msg, $code, $httpCode, $parsed),
                $httpCode === 404                        => throw new NotFoundException($msg, $code, $httpCode, $parsed),
                default                                  => throw new VaultPayException($msg, $code, $httpCode, $parsed),
            };
        }

        return $parsed['data'] ?? $parsed;
    }

    /**
     * Verify a VaultPay webhook signature (HMAC-SHA256).
     *
     * ALWAYS call this before processing webhook data.
     *
     * @param  string $rawBody   Raw POST body string
     * @param  string $signature X-VaultPay-Signature header value
     * @param  string $secret    Your webhook secret key
     * @return bool
     *
     * @example
     *   $body = file_get_contents('php://input');
     *   $sig  = $_SERVER['HTTP_X_VAULTPAY_SIGNATURE'] ?? '';
     *   if (!Client::verifyWebhookSignature($body, $sig, WEBHOOK_SECRET)) {
     *       http_response_code(401); exit;
     *   }
     *   $payload = json_decode($body, true);
     */
    public static function verifyWebhookSignature(
        string $rawBody,
        string $signature,
        string $secret
    ): bool {
        if (empty($rawBody) || empty($signature) || empty($secret)) {
            return false;
        }
        $expected = 'sha256=' . hash_hmac('sha256', $rawBody, $secret);
        return hash_equals($expected, $signature);
    }
}

// ─── Payments Resource ────────────────────────────────────────────────────────

class PaymentsResource
{
    public function __construct(private Client $client) {}

    /**
     * Create a new payment order.
     *
     * @param  array $params Required: order_id, amount, customer (name, email, phone)
     * @return array         Payment data including payment_id, qr_code, gateway_url
     *
     * @example
     *   $payment = $vp->payments->create([
     *       'order_id'     => 'ORD-001',
     *       'amount'       => 49900,      // Rs 499 in paise
     *       'currency'     => 'INR',
     *       'customer'     => ['name'=>'Arjun','email'=>'a@b.com','phone'=>'+9198...'],
     *       'description'  => 'Premium Plan',
     *       'redirect_url' => 'https://yoursite.com/success',
     *   ]);
     *   header('Location: ' . $payment['gateway_url']);
     */
    public function create(array $params): array
    {
        if (empty($params['order_id'])) {
            throw new VaultPayException('order_id is required', 'MISSING_PARAM');
        }
        if (empty($params['amount']) || (int)$params['amount'] < 100) {
            throw new VaultPayException('amount must be >= 100 paise', 'INVALID_AMOUNT');
        }
        if (empty($params['customer']['email'])) {
            throw new VaultPayException('customer.email is required', 'MISSING_PARAM');
        }
        // Defaults
        $params['currency']       ??= 'INR';
        $params['payment_method'] ??= 'qr';
        $params['expires_in']     ??= 3600;
        $params['amount']           = (int)$params['amount'];

        return $this->client->request('POST', '/payments/create', $params);
    }

    /**
     * Fetch a payment by ID.
     *
     * @param  string $paymentId The payment ID (pay_...)
     * @return array  Full payment object
     */
    public function fetch(string $paymentId): array
    {
        if (empty($paymentId)) {
            throw new VaultPayException('paymentId is required', 'MISSING_PARAM');
        }
        return $this->client->request('GET', "/payments/$paymentId");
    }

    /**
     * Capture a payment (confirm it as paid).
     * Triggers email receipt to customer.
     *
     * @param  string   $paymentId
     * @param  int|null $amount Optional partial capture amount
     * @return array
     */
    public function capture(string $paymentId, ?int $amount = null): array
    {
        $body = ['payment_id' => $paymentId];
        if ($amount !== null) $body['amount'] = $amount;
        return $this->client->request('POST', "/payments/$paymentId/capture", $body);
    }

    /**
     * Refund a captured payment.
     *
     * @param  string $paymentId
     * @return array
     */
    public function refund(string $paymentId): array
    {
        return $this->client->request('POST', "/payments/$paymentId/refund");
    }

    /**
     * List all payments for this merchant account.
     *
     * @param  int   $limit Max results (default 50, max 100)
     * @return array ['payments' => [...], 'count' => N]
     */
    public function list(int $limit = 50): array
    {
        $limit = min($limit, 100);
        return $this->client->request('GET', "/payments?limit=$limit");
    }

    /** Convenience: returns just the payments array. */
    public function all(int $limit = 50): array
    {
        return $this->list($limit)['payments'] ?? [];
    }
}

// ─── QR Resource ──────────────────────────────────────────────────────────────

class QRResource
{
    public function __construct(private Client $client) {}

    /**
     * Generate a QR code for any text or URL.
     *
     * @param  string $text       Content to encode
     * @param  int    $width      Image width in pixels (max 512)
     * @param  string $darkColor  Dark module hex color
     * @return string             Base64 data URI: 'data:image/png;base64,...'
     *
     * @example
     *   $qrUri = $vp->qr->generate('upi://pay?pa=merchant@upi&am=500');
     *   // Show in HTML:
     *   echo "<img src='$qrUri' />";
     */
    public function generate(
        string $text,
        int    $width = 256,
        string $darkColor = '#000000'
    ): string {
        if (empty($text)) {
            throw new VaultPayException('text is required', 'MISSING_PARAM');
        }
        $result = $this->client->request('POST', '/qr/generate', [
            'text'       => $text,
            'width'      => min($width, 512),
            'dark_color' => $darkColor,
        ]);
        return $result['qr_code'] ?? '';
    }
}

// ─── SMS Resource ─────────────────────────────────────────────────────────────

class SMSResource
{
    public function __construct(private Client $client) {}

    /**
     * Parse a bank SMS to detect and optionally capture a payment.
     *
     * Supports all major Indian banks and UPI apps.
     *
     * @param  string      $smsText   Raw SMS body from the customer
     * @param  string|null $paymentId Optional: auto-captures if amount matches
     * @return array       ['parsed' => [...], 'action_taken' => '...']
     *
     * @example (Laravel Controller)
     *   $result = $vp->sms->parse(
     *       $request->input('sms'),
     *       $request->input('payment_id')
     *   );
     *   if ($result['action_taken'] === 'captured') {
     *       return response()->json(['success' => true]);
     *   }
     */
    public function parse(string $smsText, ?string $paymentId = null): array
    {
        if (empty(trim($smsText)) || strlen($smsText) < 10) {
            throw new VaultPayException('smsText must be at least 10 characters', 'MISSING_PARAM');
        }
        $body = ['sms' => trim($smsText)];
        if ($paymentId !== null) $body['payment_id'] = $paymentId;
        return $this->client->request('POST', '/sms/parse', $body);
    }
}


// ─── Laravel Service Provider (optional) ──────────────────────────────────────

/*
 * To use with Laravel, add to config/services.php:
 *
 *   'vaultpay' => [
 *       'key'      => env('VAULTPAY_API_KEY'),
 *       'base_url' => env('VAULTPAY_BASE_URL', 'https://api.vaultpay.io/api/v1'),
 *   ],
 *
 * Then in AppServiceProvider::register():
 *   $this->app->singleton(\VaultPay\Client::class, function ($app) {
 *       return new \VaultPay\Client(
 *           config('services.vaultpay.key'),
 *           config('services.vaultpay.base_url'),
 *       );
 *   });
 *
 * Inject in controllers:
 *   public function checkout(\VaultPay\Client $vp, Request $request) { ... }
 */
