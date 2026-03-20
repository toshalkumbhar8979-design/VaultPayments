"""
NexusPay Python SDK
"""
# Zero external dependencies — uses only Python stdlib (urllib, hashlib, hmac)
# Requires Python 3.7+

# Quick usage:
# from nexuspay import NexusPay
# vp = NexusPay("vp_live_YOUR_KEY")
# payment = vp.payments.create(order_id="ORD-1", amount=49900, currency="INR",
#     customer={"name":"Arjun","email":"a@b.com","phone":"+91..."})
