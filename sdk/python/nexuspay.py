"""
╔══════════════════════════════════════════════════╗
║         NexusPay Python SDK v1.0                 ║
║   Secure Payment Gateway for Python Developers   ║
╚══════════════════════════════════════════════════╝

Installation:
    Copy this file to your project OR:
    pip install nexuspay   (when published)

Usage:
    from nexuspay import NexusPay

    vp = NexusPay("vp_live_YOUR_API_KEY")

    payment = vp.payments.create(
        order_id="ORD-001",
        amount=49900,
        currency="INR",
        customer={"name": "Arjun", "email": "arjun@example.com", "phone": "+919876543210"},
        description="Premium Plan"
    )
    print(payment["gateway_url"])  # Redirect customer here
"""

import hashlib
import hmac
import json
import urllib.request
import urllib.parse
import urllib.error
import re
from typing import Optional, Dict, Any, List


SDK_VERSION = "1.0.0"
DEFAULT_BASE_URL = "https://api.nexuspay.io/api/v1"
DEFAULT_TIMEOUT = 30


# ─── Exceptions ───────────────────────────────────────────────────────────────

class NexusPayError(Exception):
    """Raised when the NexusPay API returns an error."""

    def __init__(self, message: str, code: str = "API_ERROR",
                 status_code: int = 0, raw: Any = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.raw = raw

    def __repr__(self):
        return f"NexusPayError(code={self.code!r}, message={str(self)!r}, status={self.status_code})"


class NexusPayAuthError(NexusPayError):
    """Raised for authentication failures."""
    pass


class NexusPayValidationError(NexusPayError):
    """Raised for invalid request parameters."""
    pass


class NexusPayNotFoundError(NexusPayError):
    """Raised when a resource is not found."""
    pass


class NexusPayNetworkError(NexusPayError):
    """Raised for network/connection errors."""
    pass


# ─── Main Client ──────────────────────────────────────────────────────────────

class NexusPay:
    """
    NexusPay payment gateway client.

    Args:
        api_key: Your NexusPay API key (vp_live_... or vp_test_...)
        base_url: Override the API base URL (useful for self-hosted)
        timeout: Request timeout in seconds (default: 30)

    Example:
        vp = NexusPay("vp_live_abc123...")
        payment = vp.payments.create(order_id="ORD-1", amount=50000, ...)
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: int = DEFAULT_TIMEOUT,
    ):
        if not api_key or not isinstance(api_key, str):
            raise NexusPayError("api_key is required", code="MISSING_API_KEY")

        if not re.match(r"^vp_(live|test)_[a-f0-9]{32}$", api_key):
            raise NexusPayError(
                "Invalid API key format. Expected: vp_live_... or vp_test_...",
                code="INVALID_API_KEY_FORMAT",
            )

        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._is_live = api_key.startswith("vp_live_")

        # Sub-resources
        self.payments = PaymentsResource(self)
        self.qr = QRResource(self)
        self.sms = SMSResource(self)
        self.merchants = MerchantResource(self)

    @property
    def is_live_mode(self) -> bool:
        """True if using a live API key."""
        return self._is_live

    @property
    def is_test_mode(self) -> bool:
        """True if using a test API key."""
        return not self._is_live

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """
        Make an authenticated request to the NexusPay API.

        Raises NexusPayError subclasses on failure.
        Returns the parsed `data` field from the API response on success.
        """
        url = f"{self._base_url}{path}"
        payload = json.dumps(body).encode("utf-8") if body else None

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-NexusPay-Key": self._api_key,
            "X-NexusPay-SDK": f"python/{SDK_VERSION}",
            "User-Agent": f"NexusPay-SDK-Python/{SDK_VERSION}",
        }
        if payload:
            headers["Content-Length"] = str(len(payload))

        req = urllib.request.Request(
            url, data=payload, headers=headers, method=method.upper()
        )

        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                raw = resp.read().decode("utf-8")
                parsed = json.loads(raw)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8")
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                raise NexusPayNetworkError(
                    f"HTTP {exc.code}: {exc.reason}",
                    code="HTTP_ERROR",
                    status_code=exc.code,
                    raw=raw,
                )
            error = parsed.get("error", {})
            msg = error.get("message", f"HTTP {exc.code}")
            code = error.get("code", "API_ERROR")

            if exc.code == 401:
                raise NexusPayAuthError(msg, code=code, status_code=exc.code, raw=parsed)
            if exc.code == 422 or exc.code == 400:
                raise NexusPayValidationError(msg, code=code, status_code=exc.code, raw=parsed)
            if exc.code == 404:
                raise NexusPayNotFoundError(msg, code=code, status_code=exc.code, raw=parsed)

            raise NexusPayError(msg, code=code, status_code=exc.code, raw=parsed)

        except urllib.error.URLError as exc:
            raise NexusPayNetworkError(
                f"Network error: {exc.reason}", code="NETWORK_ERROR"
            )

        if not parsed.get("success"):
            error = parsed.get("error", {})
            raise NexusPayError(
                error.get("message", "Unknown error"),
                code=error.get("code", "API_ERROR"),
                raw=parsed,
            )

        return parsed.get("data", parsed)

    @staticmethod
    def verify_webhook_signature(
        raw_body: bytes,
        signature: str,
        secret: str,
    ) -> bool:
        """
        Verify a NexusPay webhook signature (HMAC-SHA256).

        ALWAYS call this before processing any webhook payload.

        Args:
            raw_body: The raw request body bytes
            signature: The X-NexusPay-Signature header value
            secret: Your webhook secret key (from merchant settings)

        Returns:
            True if signature is valid, False otherwise.

        Example (Django):
            body = request.body
            sig  = request.META.get("HTTP_X_NEXUSPAY_SIGNATURE", "")
            if not NexusPay.verify_webhook_signature(body, sig, WEBHOOK_SECRET):
                return HttpResponse(status=401)

        Example (Flask):
            body = request.get_data()
            sig  = request.headers.get("X-NexusPay-Signature", "")
            if not NexusPay.verify_webhook_signature(body, sig, WEBHOOK_SECRET):
                abort(401)
        """
        if not raw_body or not signature or not secret:
            return False

        if isinstance(raw_body, str):
            raw_body = raw_body.encode("utf-8")
        if isinstance(secret, str):
            secret = secret.encode("utf-8")

        expected = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()

        # Timing-safe comparison
        try:
            return hmac.compare_digest(signature.encode("utf-8"), expected.encode("utf-8"))
        except Exception:
            return False


# ─── Payments Resource ────────────────────────────────────────────────────────

class PaymentsResource:
    """Manage payment orders via NexusPay API."""

    def __init__(self, client: NexusPay):
        self._client = client

    def create(
        self,
        order_id: str,
        amount: int,
        customer: Dict[str, str],
        currency: str = "INR",
        description: str = "",
        payment_method: str = "qr",
        metadata: Optional[Dict] = None,
        redirect_url: Optional[str] = None,
        callback_url: Optional[str] = None,
        expires_in: int = 3600,
    ) -> Dict[str, Any]:
        """
        Create a new payment order.

        Args:
            order_id:       Your unique order identifier
            amount:         Amount in smallest currency unit (paise for INR).
                           Rs 499 = 49900 paise.
            customer:       Dict with name, email, phone keys (all required)
            currency:       Currency code: INR, USD, EUR, GBP, AED (default: INR)
            description:    Payment description shown on checkout page
            payment_method: qr | upi | card | net_banking | wallet
            metadata:       Any custom key-value pairs (up to 20 keys)
            redirect_url:   URL to redirect customer after successful payment
            callback_url:   Webhook URL for server-to-server payment events
            expires_in:     Seconds until payment link expires (default: 3600)

        Returns:
            Dict containing payment_id, qr_code (base64), gateway_url,
            amount_formatted, status, expires_at, merchant info.

        Raises:
            NexusPayValidationError: If parameters are invalid
            NexusPayAuthError: If API key is invalid

        Example:
            payment = vp.payments.create(
                order_id="ORD-001",
                amount=49900,
                customer={
                    "name": "Arjun Sharma",
                    "email": "arjun@example.com",
                    "phone": "+919876543210",
                },
                description="Premium Plan Subscription",
                redirect_url="https://yoursite.com/success",
            )
            # Redirect user:
            return redirect(payment["gateway_url"])
        """
        if not order_id:
            raise NexusPayError("order_id is required", code="MISSING_PARAM")
        if not amount or amount < 100:
            raise NexusPayError(
                "amount must be >= 100 (100 paise = Rs 1)",
                code="INVALID_AMOUNT",
            )
        if not customer or not customer.get("email"):
            raise NexusPayError("customer.email is required", code="MISSING_PARAM")

        body = {
            "order_id": order_id,
            "amount": int(amount),
            "currency": currency,
            "customer": customer,
            "description": description,
            "payment_method": payment_method,
            "expires_in": expires_in,
        }
        if metadata:
            body["metadata"] = metadata
        if redirect_url:
            body["redirect_url"] = redirect_url
        if callback_url:
            body["callback_url"] = callback_url

        return self._client._request("POST", "/payments/create", body)

    def fetch(self, payment_id: str) -> Dict[str, Any]:
        """
        Retrieve a payment by its ID.

        Args:
            payment_id: The NexusPay payment ID (pay_...)

        Returns:
            Full payment object including status, customer, qr_code, etc.
        """
        if not payment_id:
            raise NexusPayError("payment_id is required", code="MISSING_PARAM")
        return self._client._request("GET", f"/payments/{payment_id}")

    def capture(
        self, payment_id: str, amount: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Capture (confirm) a payment.

        Triggers email confirmation to the customer.

        Args:
            payment_id: The payment ID to capture
            amount:     Optional partial capture amount in paise

        Returns:
            Dict with payment_id, status='captured', captured_at
        """
        if not payment_id:
            raise NexusPayError("payment_id is required", code="MISSING_PARAM")
        body: Dict[str, Any] = {"payment_id": payment_id}
        if amount:
            body["amount"] = int(amount)
        return self._client._request("POST", f"/payments/{payment_id}/capture", body)

    def refund(self, payment_id: str) -> Dict[str, Any]:
        """
        Refund a captured payment.

        Args:
            payment_id: The payment ID to refund

        Returns:
            Dict with payment_id, status='refunded', refunded_at
        """
        if not payment_id:
            raise NexusPayError("payment_id is required", code="MISSING_PARAM")
        return self._client._request("POST", f"/payments/{payment_id}/refund")

    def list(self, limit: int = 50) -> Dict[str, Any]:
        """
        List all payments for your merchant account.

        Args:
            limit: Maximum number of payments to return (max 100)

        Returns:
            Dict with payments (list) and count
        """
        limit = min(int(limit), 100)
        return self._client._request("GET", f"/payments?limit={limit}")

    def all(self) -> List[Dict[str, Any]]:
        """Convenience: returns just the list of payments."""
        result = self.list(limit=100)
        return result.get("payments", [])


# ─── QR Resource ──────────────────────────────────────────────────────────────

class QRResource:
    """Generate QR codes via NexusPay API."""

    def __init__(self, client: NexusPay):
        self._client = client

    def generate(
        self,
        text: str,
        width: int = 256,
        dark_color: str = "#000000",
        light_color: str = "#ffffff",
    ) -> str:
        """
        Generate a QR code for any text or URL.

        Args:
            text:        Content to encode in the QR
            width:       QR image width in pixels (max 512)
            dark_color:  Dark module color (hex, default: #000000)
            light_color: Background color (hex, default: #ffffff)

        Returns:
            Base64 data URI string: 'data:image/png;base64,...'

        Example:
            qr = vp.qr.generate("upi://pay?pa=merchant@upi&am=500")
            # Save as PNG:
            import base64
            data = qr.split(",")[1]
            with open("payment.png", "wb") as f:
                f.write(base64.b64decode(data))
        """
        if not text:
            raise NexusPayError("text is required", code="MISSING_PARAM")
        result = self._client._request("POST", "/qr/generate", {
            "text": text,
            "width": min(int(width), 512),
            "dark_color": dark_color,
            "light_color": light_color,
        })
        return result.get("qr_code", "")


# ─── SMS Resource ─────────────────────────────────────────────────────────────

class SMSResource:
    """Parse bank SMS messages to acknowledge payments."""

    def __init__(self, client: NexusPay):
        self._client = client

    def parse(
        self,
        sms_text: str,
        payment_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Parse a bank SMS to detect and optionally confirm a payment.

        Supports all major Indian banks (HDFC, SBI, ICICI, Axis, Kotak...)
        and UPI apps (PhonePe, GPay, Paytm, BHIM...).

        Args:
            sms_text:   The raw SMS body text from the customer's bank
            payment_id: Optional — if provided, auto-captures the payment
                       if the parsed amount matches

        Returns:
            Dict containing:
            - parsed.type: 'credit' or 'debit'
            - parsed.amount: Detected amount in rupees
            - parsed.transaction_id: Bank reference number
            - parsed.bank: Detected bank name
            - matched_payment: Payment object if matched
            - action_taken: 'captured' | 'auto_captured' | 'amount_mismatch' | None

        Example (Django view):
            result = vp.sms.parse(
                request.POST["sms"],
                payment_id=request.POST.get("payment_id")
            )
            if result["action_taken"] == "captured":
                return JsonResponse({"success": True})
        """
        if not sms_text or len(sms_text.strip()) < 10:
            raise NexusPayError("sms_text must be at least 10 characters", code="MISSING_PARAM")

        body: Dict[str, Any] = {"sms": sms_text.strip()}
        if payment_id:
            body["payment_id"] = payment_id

        return self._client._request("POST", "/sms/parse", body)


# ─── Merchant Resource ────────────────────────────────────────────────────────

class MerchantResource:
    """Manage merchant profile and settings."""

    def __init__(self, client: NexusPay):
        self._client = client

    def get_profile(self) -> Dict[str, Any]:
        """Get the authenticated merchant's profile."""
        return self._client._request("GET", "/merchants/me")

    def get_dashboard(self) -> Dict[str, Any]:
        """Get dashboard stats (requires JWT auth, not API key)."""
        return self._client._request("GET", "/merchants/dashboard")


# ─── Convenience top-level functions ─────────────────────────────────────────

def verify_webhook(raw_body: bytes, signature: str, secret: str) -> bool:
    """
    Module-level shorthand for NexusPay.verify_webhook_signature().
    """
    return NexusPay.verify_webhook_signature(raw_body, signature, secret)


# ─── Django / Flask Integration Helpers ──────────────────────────────────────

class DjangoWebhookMixin:
    """
    Django view mixin for handling NexusPay webhooks.

    Usage:
        from nexuspay import DjangoWebhookMixin
        from django.views import View

        class NexusPayWebhook(DjangoWebhookMixin, View):
            webhook_secret = settings.NEXUSPAY_WEBHOOK_SECRET

            def on_payment_captured(self, data):
                Order.objects.filter(id=data["order_id"]).update(status="paid")

            def on_payment_failed(self, data):
                pass  # Handle failure
    """

    webhook_secret: str = ""

    def post(self, request, *args, **kwargs):
        from django.http import HttpResponse, HttpResponseForbidden

        signature = request.META.get("HTTP_X_NEXUSPAY_SIGNATURE", "")
        if not NexusPay.verify_webhook_signature(request.body, signature, self.webhook_secret):
            return HttpResponseForbidden("Invalid signature")

        try:
            payload = json.loads(request.body.decode("utf-8"))
            event = payload.get("event", "")
            data = payload.get("data", {})

            handler = {
                "payment.captured": self.on_payment_captured,
                "payment.failed": self.on_payment_failed,
                "payment.refunded": self.on_payment_refunded,
            }.get(event)

            if handler:
                handler(data)

        except Exception as exc:
            return HttpResponse(f"Error: {exc}", status=500)

        return HttpResponse(json.dumps({"received": True}), content_type="application/json")

    def on_payment_captured(self, data: Dict): pass
    def on_payment_failed(self, data: Dict): pass
    def on_payment_refunded(self, data: Dict): pass


# ─── CLI Quick Test ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import os, sys

    key = os.environ.get("NEXUSPAY_API_KEY", "")
    base_url = os.environ.get("NEXUSPAY_BASE_URL", "http://localhost:5000/api/v1")

    if not key:
        print("Set NEXUSPAY_API_KEY environment variable to test")
        print("  export NEXUSPAY_API_KEY=vp_test_your_key_here")
        print("  export NEXUSPAY_BASE_URL=http://localhost:5000/api/v1")
        sys.exit(1)

    print(f"\n🔑 Testing NexusPay Python SDK v{SDK_VERSION}")
    print(f"   Key: {key[:16]}...")
    print(f"   URL: {base_url}\n")

    vp = NexusPay(key, base_url=base_url)
    print(f"   Mode: {'🟢 LIVE' if vp.is_live_mode else '🟡 TEST'}\n")

    # Test: Create payment
    print("▶ Creating test payment...")
    try:
        payment = vp.payments.create(
            order_id=f"PY-TEST-{int(__import__('time').time())}",
            amount=49900,
            customer={
                "name": "Python Test User",
                "email": "test@python.dev",
                "phone": "+919999999999",
            },
            description="Python SDK Test Payment",
        )
        print(f"  ✅ Created: {payment['payment_id']}")
        print(f"  💰 Amount: {payment['amount_formatted']}")
        print(f"  🔗 URL: {payment['gateway_url']}")
        print(f"  📱 QR: {payment['qr_code'][:50]}...")

        # Test: Fetch payment
        print("\n▶ Fetching payment...")
        fetched = vp.payments.fetch(payment["payment_id"])
        print(f"  ✅ Status: {fetched['status']}")

        # Test: List payments
        print("\n▶ Listing payments...")
        listing = vp.payments.list(limit=5)
        count = listing.get("count", 0)
        print(f"  ✅ Found {count} payments")

        # Test: SMS parse
        print("\n▶ Testing SMS parse...")
        sms_result = vp.sms.parse(
            "Your a/c XXXX1234 is credited INR 499.00 by UPI. Ref No: 312456789012. -HDFC Bank",
            payment_id=payment["payment_id"],
        )
        print(f"  ✅ Parsed amount: ₹{sms_result['parsed']['amount']}")
        print(f"  ✅ Bank: {sms_result['parsed']['bank']}")
        print(f"  ✅ Action: {sms_result['action_taken']}")

        print("\n✅ All tests passed!\n")

    except NexusPayError as e:
        print(f"\n❌ Error: {e}")
        print(f"   Code: {e.code}")
        print(f"   Status: {e.status_code}")
        sys.exit(1)
