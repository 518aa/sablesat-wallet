#!/usr/bin/env python3
"""
App Store Connect API helper for SableSat iOS provisioning.

Authenticates with the Dialing An App Store Connect API key (.p8) and can
create the full provisioning set (bundle id + device + dev cert + profile)
so xcodebuild can sign without Xcode's GUI Apple-ID login.

Config below is filled from the key the user provided.
"""
import base64
import os
import json
import sys
import time

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.serialization import load_pem_private_key
import requests

# ---- App Store Connect API 凭证：全部来自环境变量 ----
# 使用前先 export：
#   export ASC_KEY_PATH=/secure/path/AuthKey_XXXX.p8
#   export ASC_KEY_ID=XXXXXXXXXX
#   export ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#   export ASC_TEAM_ID=XXXXXXXXXX
# 注意：.p8 不要存放在 iCloud 同步目录（如 Notes 附件目录）。
KEY_PATH = os.environ["ASC_KEY_PATH"]        # .p8 路径，绝不入库
KEY_ID = os.environ["ASC_KEY_ID"]
ISSUER_ID = os.environ["ASC_ISSUER_ID"]
TEAM_ID = os.environ.get("ASC_TEAM_ID", "")

API = "https://api.appstoreconnect.apple.com"

BUNDLE_ID = "com.bitnest.wallet"
DEVICE_UDID = "00008120-000628293E88C01E"
DEVICE_NAME = "macdeiPhone"


def b64url(b: bytes) -> bytes:
    return base64.urlsafe_b64encode(b).rstrip(b"=")


def der_to_raw(sig_der: bytes) -> bytes:
    r, s = decode_dss_signature(sig_der)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def make_token() -> str:
    key = load_pem_private_key(open(KEY_PATH, "rb").read(), password=None)
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    now = int(time.time())
    header = {"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}
    payload = {"iss": ISSUER_ID, "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"}
    seg1 = b64url(json.dumps(header, separators=(",", ":")).encode())
    seg2 = b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = seg1 + b"." + seg2
    sig = key.sign(signing_input, ec.ECDSA(SHA256()))
    return (signing_input + b"." + b64url(der_to_raw(sig))).decode()


def api(method: str, path: str, json_body=None):
    token = make_token()
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if json_body is not None:
        headers["Content-Type"] = "application/json"
    r = requests.request(method, API + path, headers=headers, json=json_body, timeout=60)
    return r


def verify():
    """Confirm the key authenticates and show what team/bundleIds it can see."""
    r = api("GET", "/v1/bundleIds?limit=5")
    print("GET /v1/bundleIds ->", r.status_code)
    print(json.dumps(r.json(), indent=2, ensure_ascii=False)[:2000])
    return r.status_code == 200


if __name__ == "__main__":
    ok = verify()
    sys.exit(0 if ok else 1)
