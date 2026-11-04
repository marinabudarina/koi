#!/usr/bin/env python3
"""
Generate iOS distribution certificate and provisioning profiles for EAS Build.
Zero dependencies — uses only python3, openssl, and curl (pre-installed on macOS).

Cert resolution: local file → Expo servers → create new via Apple ASC API.
After creation, the cert is uploaded to Expo so it survives sandbox restarts.
If Apple's cert limit is reached, orphaned certs (on Apple but not Expo) are
revoked automatically before retrying. Revocation refuses to run when Expo
cannot be queried, so a transient outage can never revoke live certs.

Usage:
  EXPO_TOKEN=xxx EXPO_ASC_KEY_ID=xxx EXPO_ASC_ISSUER_ID=xxx \
  EXPO_ASC_API_KEY_PATH=./keys/AuthKey.p8 EXPO_APPLE_TEAM_ID=xxx \
  python3 scripts/generate_ios_certs.py
"""

import subprocess, base64, json, time, os, secrets, sys, plistlib
from datetime import datetime
from pathlib import Path

# --- Config ---
EXPO_TOKEN = os.environ.get("EXPO_TOKEN")
KEY_ID = os.environ.get("EXPO_ASC_KEY_ID")
ISSUER_ID = os.environ.get("EXPO_ASC_ISSUER_ID")
KEY_PATH = os.environ.get("EXPO_ASC_API_KEY_PATH")
TEAM_ID = os.environ.get("EXPO_APPLE_TEAM_ID")
EXPO_ACCOUNT = os.environ.get("EXPO_ACCOUNT")
BUNDLE_ID = os.environ.get("EXPO_BUNDLE_ID")
OUTPUT_DIR = "./ios/certs"
P12_FILE = f"{OUTPUT_DIR}/dist-cert.p12"
UPLOAD_PENDING = f"{OUTPUT_DIR}/.expo_upload_pending"
APPLE_API = "https://api.appstoreconnect.apple.com/v1"

_jwt_cache = {"token": None, "exp": 0}
_cert_password = ""


def die(msg):
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)


def check_env():
    required = ["EXPO_TOKEN", "EXPO_ACCOUNT", "EXPO_BUNDLE_ID", "EXPO_ASC_KEY_ID", "EXPO_ASC_ISSUER_ID", "EXPO_ASC_API_KEY_PATH", "EXPO_APPLE_TEAM_ID"]
    missing = [v for v in required if not os.environ.get(v)]
    if missing:
        die(f"Missing environment variables: {', '.join(missing)}")
    if not os.path.exists(KEY_PATH):
        die(f"ASC API key not found at {KEY_PATH}")


# ── Helpers ──

def b64url(data):
    if isinstance(data, str):
        data = data.encode()
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def der_to_jose(der_sig):
    """DER ECDSA signature -> raw R||S (64 bytes for P-256)."""
    d = der_sig
    assert d[0] == 0x30
    idx = 2 + (d[1] & 0x7F if d[1] & 0x80 else 0)
    assert d[idx] == 0x02
    r = int.from_bytes(d[idx+2:idx+2+d[idx+1]], "big")
    idx += 2 + d[idx+1]
    assert d[idx] == 0x02
    s = int.from_bytes(d[idx+2:idx+2+d[idx+1]], "big")
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def get_jwt():
    now = int(time.time())
    if _jwt_cache["token"] and now < _jwt_cache["exp"] - 60:
        return _jwt_cache["token"]

    header = b64url(json.dumps({"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}))
    exp = now + 1200
    payload = b64url(json.dumps({"iss": ISSUER_ID, "iat": now, "exp": exp, "aud": "appstoreconnect-v1"}))

    r = subprocess.run(["openssl", "dgst", "-sha256", "-sign", KEY_PATH],
                       input=f"{header}.{payload}".encode(), capture_output=True)
    if r.returncode != 0:
        die(f"JWT signing failed: {r.stderr.decode()}")

    _jwt_cache["token"] = f"{header}.{payload}.{b64url(der_to_jose(r.stdout))}"
    _jwt_cache["exp"] = exp
    return _jwt_cache["token"]


def dig(data, *keys):
    """Safe nested-dict lookup: dig(d, "a", "b") == d["a"]["b"], or None on any miss."""
    for k in keys:
        if not isinstance(data, dict):
            return None
        data = data.get(k)
    return data


def curl_call(method, url, headers, body=None, retries=2):
    """Returns (http_status, parsed_json_or_None). Dies on connection failure or non-JSON body."""
    cmd = ["curl", "-s", "-S", "-g", "-w", "\n%{http_code}", "--connect-timeout", "30",
           "--max-time", "60", "-X", method, url]
    for k, v in headers.items():
        cmd += ["-H", f"{k}: {v}"]
    if body:
        cmd += ["-d", json.dumps(body)]

    for attempt in range(retries + 1):
        r = subprocess.run(cmd, capture_output=True, text=True)
        lines = r.stdout.strip().rsplit("\n", 1)
        resp_body = lines[0] if len(lines) == 2 else ""
        status = lines[-1] if lines else "000"

        if status == "000":
            if attempt < retries:
                print(f"   Retry {attempt+1}/{retries}...")
                time.sleep(2)
                continue
            die(f"Connection failed: {method} {url}\n   curl: {r.stderr.strip()}")

        if not resp_body.strip():
            return int(status), None  # e.g. 204 No Content
        try:
            return int(status), json.loads(resp_body)
        except json.JSONDecodeError:
            die(f"Invalid JSON from {method} {url}, HTTP {status}\n   {resp_body[:300]}")


def apple_api(method, path, body=None):
    url = f"{APPLE_API}{path}" if path.startswith("/") else path
    return curl_call(method, url, {"Authorization": f"Bearer {get_jwt()}", "Content-Type": "application/json"}, body)


def expo_graphql(query, variables=None, fatal=False):
    """POST to Expo GraphQL. Returns the response's `data`, or None on any failure (dies instead when fatal=True)."""
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {EXPO_TOKEN}"}
    try:
        _, resp = curl_call("POST", "https://api.expo.dev/graphql", headers, {"query": query, "variables": variables or {}})
    except SystemExit:
        if fatal:
            raise
        return None
    resp = resp or {}
    if "errors" in resp:
        if fatal:
            die("Expo GraphQL error: " + "; ".join(e.get("message", "") for e in resp["errors"]))
        return None
    return resp.get("data")


# ── Expo Account & Team ──

def get_expo_account_id():
    query = """
    query($name: String!) {
      account { byName(accountName: $name) { id } }
    }"""
    data = expo_graphql(query, {"name": EXPO_ACCOUNT}, fatal=True)
    return dig(data, "account", "byName", "id") or die(f"Expo account '{EXPO_ACCOUNT}' not found")


def ensure_expo_apple_team(account_id):
    """Return the Expo-internal Apple Team ID, registering the team if needed."""
    query = """
    query($accountId: ID!, $identifier: String!) {
      appleTeam { byAppleTeamIdentifier(accountId: $accountId, identifier: $identifier) { id } }
    }"""
    data = expo_graphql(query, {"accountId": account_id, "identifier": TEAM_ID})
    existing_id = dig(data, "appleTeam", "byAppleTeamIdentifier", "id")
    if existing_id:
        return existing_id

    mutation = """
    mutation($input: AppleTeamInput!, $accountId: ID!) {
      appleTeam { createAppleTeam(appleTeamInput: $input, accountId: $accountId) { id } }
    }"""
    data = expo_graphql(mutation, {
        "accountId": account_id,
        "input": {"appleTeamIdentifier": TEAM_ID, "appleTeamName": TEAM_ID},
    }, fatal=True)
    return dig(data, "appleTeam", "createAppleTeam", "id") or die("Failed to register Apple Team on Expo")


# ── Certificate Resolution ──

def _expo_cert_nodes(fatal=False):
    """This team's distribution-cert records on Expo; [] if the query fails (dies instead when fatal=True)."""
    query = """
    query($name: String!, $first: Int) {
      account { byName(accountName: $name) {
        appleDistributionCertificatesPaginated(first: $first) { edges { node {
          certificateP12 certificatePassword developerPortalIdentifier
          validityNotAfter appleTeam { appleTeamIdentifier }
        }}}
      }}
    }"""
    data = expo_graphql(query, {"name": EXPO_ACCOUNT, "first": 100}, fatal=fatal)
    edges = dig(data, "account", "byName", "appleDistributionCertificatesPaginated", "edges")
    if edges is None:
        if fatal:
            die("Could not list distribution certificates on Expo")
        return []
    nodes = [e.get("node") or {} for e in edges]
    return [n for n in nodes if (dig(n, "appleTeam", "appleTeamIdentifier") or TEAM_ID) == TEAM_ID]


def fetch_from_expo():
    """Yield (p12_bytes, password, apple_cert_id) for each unexpired cert on Expo."""
    for node in _expo_cert_nodes():
        expiry = node.get("validityNotAfter", "")
        if expiry:
            try:
                if datetime.fromisoformat(expiry.replace("Z", "+00:00")).timestamp() < time.time():
                    continue
            except ValueError:
                pass
        p12, cid = node.get("certificateP12"), node.get("developerPortalIdentifier")
        if p12 and cid:
            yield base64.b64decode(p12), node.get("certificatePassword") or "", cid


def verify_cert_on_apple(cert_id):
    """True if cert_id exists on Apple, False only on a definitive 404 (revoked/deleted).
    Any other failure dies — a transient outage must not be mistaken for revocation."""
    status, resp = apple_api("GET", f"/certificates/{cert_id}")
    if status == 200 and dig(resp, "data", "id") == cert_id:
        return True
    if status == 404:
        return False
    die(f"Apple API error while verifying cert {cert_id} (HTTP {status})")


def upload_to_expo(cert_id, password):
    """Upload the local .p12 to Expo so the key survives sandbox restarts.
    Best-effort: the local cert is already usable, so failure warns and leaves
    a marker to retry on the next run instead of failing the build."""
    mutation = """
    mutation($input: AppleDistributionCertificateInput!, $accountId: ID!) {
      appleDistributionCertificate {
        createAppleDistributionCertificate(
          appleDistributionCertificateInput: $input
          accountId: $accountId
        ) { id }
      }
    }"""
    with open(P12_FILE, "rb") as f:
        p12_b64 = base64.b64encode(f.read()).decode()
    try:
        account_id = get_expo_account_id()
        data = expo_graphql(mutation, {
            "accountId": account_id,
            "input": {
                "certP12": p12_b64,
                "certPassword": password,
                "developerPortalIdentifier": cert_id,
                "appleTeamId": ensure_expo_apple_team(account_id),
            },
        }, fatal=True)
    except SystemExit:  # any failure in this block just means "not uploaded yet"
        data = None
    expo_id = dig(data, "appleDistributionCertificate", "createAppleDistributionCertificate", "id")
    if expo_id:
        print(f"   Uploaded to Expo (ID: {expo_id})")
        if os.path.exists(UPLOAD_PENDING):
            os.remove(UPLOAD_PENDING)
    else:
        print("   Warning: cert not uploaded to Expo yet — will retry on next run", file=sys.stderr)
        open(UPLOAD_PENDING, "w").close()


def revoke_orphaned_certs():
    """Revoke certs that exist on Apple but not on Expo (their private keys are lost)."""
    # Fatal on Expo failure: a failed query must never be read as "Expo has no certs".
    expo_ids = {n["developerPortalIdentifier"] for n in _expo_cert_nodes(fatal=True) if n.get("developerPortalIdentifier")}
    status, resp = apple_api("GET", "/certificates?filter[certificateType]=IOS_DISTRIBUTION")
    if status != 200:
        die(f"Could not list Apple certificates (HTTP {status})")

    orphaned = [c["id"] for c in resp.get("data", []) if c["id"] not in expo_ids]
    if not orphaned:
        print("   No orphaned certificates found")
        return 0

    revoked = 0
    for cid in orphaned:
        status, _ = apple_api("DELETE", f"/certificates/{cid}")
        if status == 204:
            print(f"   Revoked orphaned cert {cid}")
            revoked += 1
        else:
            print(f"   Warning: could not revoke {cid} (HTTP {status})", file=sys.stderr)
    print(f"   Revoked {revoked}/{len(orphaned)} orphaned certificates")
    return revoked


def create_new_cert(password):
    """Create a cert via Apple API and write it to P12_FILE, locked with password.
    Returns the cert ID, or None when Apple's cert limit is hit."""
    key_file, csr_file = f"{OUTPUT_DIR}/key.pem", f"{OUTPUT_DIR}/cert.csr"

    r = subprocess.run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", key_file, "-out", csr_file,
                        "-subj", f"/CN=iOS Distribution/O={TEAM_ID}"], capture_output=True)
    if r.returncode != 0:
        die(f"CSR generation failed: {r.stderr.decode()}")

    with open(csr_file) as f:
        csr = f.read()

    status, resp = apple_api("POST", "/certificates", {
        "data": {"type": "certificates", "attributes": {"certificateType": "IOS_DISTRIBUTION", "csrContent": csr}}
    })

    errors = (resp or {}).get("errors")
    if errors:
        for f_clean in [key_file, csr_file]:
            if os.path.exists(f_clean):
                os.remove(f_clean)
        for e in errors:
            print(f"   Apple API error (HTTP {status}): {e.get('title', '')} -- {e.get('detail', '')}", file=sys.stderr)
        # The cert limit (409 "already have a current ... certificate") is the one
        # recoverable failure: the caller revokes orphans and retries.
        if status == 409 and any("already have a current" in (e.get("detail") or "").lower() or "limit" in (e.get("detail") or "").lower() for e in errors):
            return None
        die("Certificate creation failed. Check the error above and resolve manually.")

    cert_id = resp["data"]["id"]
    print(f"   Created certificate: {cert_id}")

    der_file, pem_file = f"{OUTPUT_DIR}/{cert_id}.der", f"{OUTPUT_DIR}/{cert_id}.pem"
    with open(der_file, "wb") as f:
        f.write(base64.b64decode(resp["data"]["attributes"]["certificateContent"]))

    r = subprocess.run(["openssl", "x509", "-in", der_file, "-inform", "DER",
                        "-out", pem_file, "-outform", "PEM"], capture_output=True)
    if r.returncode != 0:
        die(f"DER to PEM conversion failed: {r.stderr.decode()}")

    r = subprocess.run(["openssl", "pkcs12", "-export", "-out", P12_FILE,
                        "-certpbe", "PBE-SHA1-3DES", "-keypbe", "PBE-SHA1-3DES", "-macalg", "sha1",
                        "-inkey", key_file, "-in", pem_file,
                        "-passout", f"pass:{password}"], capture_output=True)
    if r.returncode != 0:
        die(f"p12 creation failed: {r.stderr.decode()}")

    for f_clean in [key_file, csr_file, der_file, pem_file]:
        if os.path.exists(f_clean):
            os.remove(f_clean)

    return cert_id


# ── Certificate Resolution (orchestrator) ──

def resolve_certificate():
    """Resolve a valid distribution certificate. Returns (cert_id, password).

    Local .p12 → Expo servers → create new on Apple (revoking orphaned certs
    and retrying once if the cert limit is hit). New certs are uploaded to
    Expo so they survive sandbox restarts.
    """
    # --- Local file ---
    if os.path.exists(P12_FILE):
        cert_id, password = load_metadata()
        if cert_id and verify_cert_on_apple(cert_id):
            print(f"   Local cert {cert_id} verified on Apple")
            if os.path.exists(UPLOAD_PENDING):
                upload_to_expo(cert_id, password)
            return cert_id, password
        # Set the key aside instead of deleting it — it may be the only copy
        print(f"   Local cert {'revoked/missing on Apple' if cert_id else 'has no metadata'} — setting aside")
        os.replace(P12_FILE, P12_FILE + ".bak")

    # --- Expo servers ---
    print("   Checking Expo servers...")
    for p12_bytes, password, cert_id in fetch_from_expo():
        if not verify_cert_on_apple(cert_id):
            print(f"   Expo cert {cert_id} is revoked/missing on Apple — skipping")
            continue
        print(f"   Found on Expo (Apple ID: {cert_id}), verified on Apple")
        with open(P12_FILE, "wb") as f:
            f.write(p12_bytes)
        save_metadata(cert_id, password)
        return cert_id, password

    # --- Create new ---
    print("   Creating new certificate via Apple API...")
    password = secrets.token_urlsafe(18)
    cert_id = create_new_cert(password)
    if cert_id is None:
        print("   Certificate limit reached. Revoking orphaned certs...")
        if revoke_orphaned_certs() == 0:
            die("Apple cert limit reached and no orphaned certs to revoke. Revoke a cert manually at developer.apple.com")
        print("   Retrying certificate creation...")
        cert_id = create_new_cert(password) or die("Certificate creation still failed after revoking orphans. Check developer.apple.com")

    save_metadata(cert_id, password)
    print("   Uploading certificate to Expo...")
    upload_to_expo(cert_id, password)
    return cert_id, password


# ── Main ──

def save_metadata(cert_id, password):
    with open(f"{OUTPUT_DIR}/.cert_id", "w") as f:
        f.write(cert_id)
    with open(f"{OUTPUT_DIR}/.p12_password", "w") as f:
        f.write(password)


def load_metadata():
    cert_id, password = None, ""
    for fname, target in [(".cert_id", "id"), (".p12_password", "pw")]:
        try:
            with open(f"{OUTPUT_DIR}/{fname}") as f:
                val = f.read().strip()
                if target == "id":
                    cert_id = val
                else:
                    password = val
        except FileNotFoundError:
            pass
    return cert_id, password


def read_signing_targets():
    if list(Path("ios").glob("*.xcodeproj")):
        print("   Native Xcode project: skipping automatic capability changes. Configure each target's required capabilities in Apple Developer before publishing.", file=sys.stderr)
        return [{"bundleIdentifier": BUNDLE_ID, "entitlements": {}}]
    result = subprocess.run(["bunx", "--no-install", "expo", "config", "--type", "introspect", "--json"],
                            capture_output=True, text=True)
    if result.returncode != 0:
        die(f"Could not inspect iOS entitlements. Fix the app's Expo config before publishing.\n{result.stderr[-300:]}")
    try:
        config = json.loads(result.stdout)
    except json.JSONDecodeError:
        die("Expo config inspection did not return JSON. Fix the app's Expo config before publishing.")
    ios = dig(config, "ios")
    if not isinstance(ios, dict):
        die("Could not read resolved iOS config from Expo. Fix the app's Expo config before publishing.")
    if ios.get("bundleIdentifier") != BUNDLE_ID or ios.get("appleTeamId") != TEAM_ID:
        die("Resolved Expo bundleIdentifier or appleTeamId differs from the publish configuration. Update the app's iOS config before publishing.")
    entitlements = ios.get("entitlements", {})
    if not isinstance(entitlements, dict):
        die("Could not read resolved iOS entitlements from Expo config. Fix the app's Expo config before publishing.")
    extensions = dig(config, "extra", "eas", "build", "experimental", "ios", "appExtensions")
    if extensions is None:
        extensions = []
    if not isinstance(extensions, list):
        die("Resolved Expo appExtensions must be a list.")
    target_name = None
    if extensions:
        result = subprocess.run(["bun", "-e", "const r = require('module').createRequire(require.resolve('expo/package.json')); console.log(r('@expo/config-plugins').IOSConfig.XcodeUtils.sanitizedName(process.argv[1]));", config["name"]], capture_output=True, text=True)
        if result.returncode != 0 or not result.stdout.strip():
            die("Could not determine the main iOS target name from Expo.")
        target_name = result.stdout.strip()
    targets = [{"targetName": target_name, "bundleIdentifier": BUNDLE_ID, "entitlements": entitlements}]
    for extension in extensions:
        name = dig(extension, "targetName")
        identifier = dig(extension, "bundleIdentifier")
        if not isinstance(name, str) or not name or not isinstance(identifier, str) or not identifier.startswith(BUNDLE_ID + "."):
            die("Each iOS extension needs a targetName and a bundleIdentifier prefixed by the main app's bundle ID.")
        if any(target.get("targetName") == name or target["bundleIdentifier"] == identifier for target in targets):
            die("iOS extension target names and bundle identifiers must be unique.")
        extension_entitlements = extension.get("entitlements", {})
        if not isinstance(extension_entitlements, dict):
            die(f"Invalid entitlements for iOS extension {name}.")
        targets.append({"targetName": name, "bundleIdentifier": identifier, "entitlements": extension_entitlements})
    for target in targets:
        groups = target["entitlements"].get("com.apple.security.application-groups", [])
        if not isinstance(groups, list) or any(not isinstance(group, str) or not group.startswith("group.") for group in groups):
            die(f"Invalid App Groups for {target['bundleIdentifier']}.")
    return targets


def find_bundle_id(identifier, register=False):
    status, response = apple_api("GET", f"/bundleIds?filter[identifier]={identifier}")
    if status != 200 or not isinstance(dig(response, "data"), list):
        die(f"Could not look up bundle ID {identifier} (HTTP {status}).")
    matches = [bundle for bundle in response["data"] if dig(bundle, "attributes", "identifier") == identifier]
    if len(matches) == 1:
        return matches[0]["id"]
    if matches or dig(response, "links", "next") or not register:
        die(f"Could not uniquely find bundle ID {identifier}. Check Apple Developer before publishing.")
    status, response = apple_api("POST", "/bundleIds", {"data": {"type": "bundleIds", "attributes": {"identifier": identifier, "name": identifier.replace(".", " "), "platform": "IOS"}}})
    if status == 409:
        return find_bundle_id(identifier)
    if status != 201 or not dig(response, "data", "id"):
        die(f"Could not register extension bundle ID {identifier} (HTTP {status}).")
    return response["data"]["id"]


def enable_push_notifications(bundle_res_id):
    path = f"/bundleIds/{bundle_res_id}/bundleIdCapabilities"
    status, response = apple_api("GET", path)
    if status != 200 or not isinstance(dig(response, "data"), list) or dig(response, "links", "next"):
        die(f"Could not check Push Notifications for {BUNDLE_ID} (HTTP {status}). Check Apple API permissions and retry publishing.")
    if any(dig(capability, "attributes", "capabilityType") == "PUSH_NOTIFICATIONS" for capability in response["data"]):
        print("   Push Notifications already enabled")
        return
    status, _ = apple_api("POST", "/bundleIdCapabilities", {
        "data": {
            "type": "bundleIdCapabilities",
            "attributes": {"capabilityType": "PUSH_NOTIFICATIONS"},
            "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": bundle_res_id}}},
        }
    })
    if status not in (201, 409):
        die(f"Could not enable Push Notifications for {BUNDLE_ID} (HTTP {status}). An Apple Account Holder or Admin can enable it under Certificates, Identifiers & Profiles > Identifiers, then retry publishing.")
    status, response = apple_api("GET", path)
    if status != 200 or not any(dig(capability, "attributes", "capabilityType") == "PUSH_NOTIFICATIONS" for capability in (dig(response, "data") or [])):
        die(f"Push Notifications is not confirmed enabled for {BUNDLE_ID}. Check the capability in Apple Developer and retry publishing.")
    print("   Push Notifications enabled")


def main():
    check_env()
    targets = read_signing_targets()
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    global _cert_password

    # Step 1: Resolve certificate
    print("1/3 Resolving certificate...")
    apple_cert_id, _cert_password = resolve_certificate()
    print(f"   Certificate ready: {apple_cert_id}")

    # Step 2: Look up bundle ID
    print("2/3 Looking up bundle ID...")
    bundle_res_id = find_bundle_id(BUNDLE_ID)
    print(f"   Found: {bundle_res_id}")
    if "aps-environment" in targets[0]["entitlements"]:
        enable_push_notifications(bundle_res_id)

    # Step 3: Create provisioning profile
    print("3/3 Creating provisioning profile...")
    credentials = {}
    for index, target in enumerate(targets):
        identifier = target["bundleIdentifier"]
        target_bundle_id = bundle_res_id if index == 0 else find_bundle_id(identifier, register=True)
        if index and "aps-environment" in target["entitlements"]:
            enable_push_notifications(target_bundle_id)
        credentials[target.get("targetName")] = create_profile(target, target_bundle_id, apple_cert_id, index)
    with open("./credentials.json", "w") as f:
        json.dump({"ios": credentials if len(targets) > 1 else credentials[targets[0].get("targetName")]}, f, indent=2)
    print("\ncredentials.json written. Ready for: eas build --platform ios --profile production --non-interactive")


def create_profile(target, bundle_res_id, apple_cert_id, index):
    identifier = target["bundleIdentifier"]
    status, resp = apple_api("POST", "/profiles", {
        "data": {
            "type": "profiles",
            "attributes": {"name": f"EAS_{identifier}_{int(time.time())}", "profileType": "IOS_APP_STORE"},
            "relationships": {
                "bundleId": {"data": {"type": "bundleIds", "id": bundle_res_id}},
                "certificates": {"data": [{"type": "certificates", "id": apple_cert_id}]},
            },
        }
    })
    if status != 201 or not dig(resp, "data", "attributes", "profileContent"):
        for e in (resp or {}).get("errors", []):
            print(f"   Error: {e.get('title','')} -- {e.get('detail','')}", file=sys.stderr)
        die(f"Could not create provisioning profile for {identifier} (HTTP {status}).")

    profile_data = base64.b64decode(resp["data"]["attributes"]["profileContent"])
    decoded = subprocess.run(["openssl", "cms", "-verify", "-noverify", "-inform", "DER"], input=profile_data, capture_output=True)
    if decoded.returncode != 0:
        die(f"Could not decode provisioning profile for {identifier}.")
    profile = plistlib.loads(decoded.stdout)
    entitlements = profile.get("Entitlements", {})
    if entitlements.get("application-identifier", "").partition(".")[2] != identifier or TEAM_ID not in profile.get("TeamIdentifier", []):
        die(f"Provisioning profile does not match the configured team and bundle ID {identifier}.")
    groups = target["entitlements"].get("com.apple.security.application-groups", [])
    if not set(groups).issubset(entitlements.get("com.apple.security.application-groups", [])):
        die(f"App Groups are not configured for {identifier}. In Apple Developer, register {', '.join(groups)} and assign it to the main app and widget identifiers, then retry. Apple API keys cannot create or assign App Groups.")
    if "aps-environment" in target["entitlements"] and entitlements.get("aps-environment") != "production":
        die(f"Provisioning profile for {identifier} is missing production Push Notifications.")
    profile_file = f"{OUTPUT_DIR}/profile{'-' + str(index) if index else ''}.mobileprovision"
    with open(profile_file, "wb") as f:
        f.write(profile_data)
    print(f"   Saved: {profile_file}")

    return {
        "provisioningProfilePath": profile_file,
        "distributionCertificate": {"path": P12_FILE, "password": _cert_password},
    }


if __name__ == "__main__":
    main()
