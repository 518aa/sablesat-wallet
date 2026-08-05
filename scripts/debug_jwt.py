#!/usr/bin/env python3
import base64, json, time, sys
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.asymmetric import utils
from cryptography.hazmat.primitives.serialization import load_pem_private_key

KEY_PATH = os.environ["ASC_KEY_PATH"]        # .p8 路径，绝不入库
KEY_ID = os.environ["ASC_KEY_ID"]
ISSUER_ID = os.environ["ASC_ISSUER_ID"]

def b64url(b): return base64.urlsafe_b64encode(b).rstrip(b"=")
def der_to_raw(sig):
    r, s = decode_dss_signature(sig)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")

key = load_pem_private_key(open(KEY_PATH, "rb").read(), password=None)
print("key type:", type(key).__name__)
print("curve:", key.curve.name)

now = int(time.time())
header = {"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}
payload = {"iss": ISSUER_ID, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"}
seg1 = b64url(json.dumps(header, separators=(",", ":")).encode())
seg2 = b64url(json.dumps(payload, separators=(",", ":")).encode())
si = seg1 + b"." + seg2
sig = key.sign(si, ec.ECDSA(SHA256()))
raw = der_to_raw(sig)
print("DER sig len:", len(sig), "| raw sig len:", len(raw))
token = (si + b"." + b64url(raw)).decode()
print("\n--- HEADER ---"); print(json.dumps(header))
print("--- PAYLOAD ---"); print(json.dumps(payload))
print("--- TOKEN (first 120 chars) ---"); print(token[:120], "...")

# self-verify
pub = key.public_key()
try:
    pub.verify(raw, si, ec.ECDSA(SHA256()))
    print("\nSELF-VERIFY: OK (signature is internally valid)")
except Exception as e:
    print("\nSELF-VERIFY: FAIL", e)
