//! Ed25519 and HMAC request signing.
use std::path::Path;

use base64::Engine as _;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use ed25519_dalek::Signer as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Python's `urllib.parse.quote(s, safe=safe)`: unreserved characters and `safe` stay, the rest is %XX.
pub fn quote(s: &str, safe: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"_.-~".contains(&b) || (b.is_ascii() && safe.as_bytes().contains(&b)) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Query string as sent and signed; '@' stays unencoded (Binance verifies emails that way).
pub fn query<K: AsRef<str>, V: AsRef<str>>(params: &[(K, V)]) -> String {
    let mut out = String::new();
    for (i, (k, v)) in params.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(k.as_ref());
        out.push('=');
        out.push_str(&quote(v.as_ref(), "@"));
    }
    out
}

pub enum Signer {
    Ed25519(SigningKey),
    Hmac(Vec<u8>),
}

impl Signer {
    pub fn kind(&self) -> &'static str {
        match self {
            Signer::Ed25519(_) => "ed25519",
            Signer::Hmac(_) => "hmac",
        }
    }

    pub fn ed25519_from_pem(pem: &str) -> Result<Signer, String> {
        SigningKey::from_pkcs8_pem(pem).map(Signer::Ed25519).map_err(|e| format!("not an Ed25519 private key: {e}"))
    }

    pub fn hmac(secret: &str) -> Signer {
        Signer::Hmac(secret.as_bytes().to_vec())
    }

    /// Ed25519: base64 signature; HMAC-SHA256: hex digest.
    pub fn sign(&self, payload: &str) -> String {
        match self {
            Signer::Ed25519(k) => base64::engine::general_purpose::STANDARD.encode(k.sign(payload.as_bytes()).to_bytes()),
            Signer::Hmac(secret) => {
                let mut m = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC takes any key length");
                m.update(payload.as_bytes());
                hex::encode(m.finalize().into_bytes())
            }
        }
    }
}

pub struct Credentials {
    pub api_key: String,
    pub signer: Signer,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

/// Resolve keys from the environment; on failure the reason.
pub fn credentials(api_key_env: &str, private_key_env: &str, secret_env: &str) -> Result<Credentials, String> {
    let Some(api_key) = (!api_key_env.is_empty()).then(|| env(api_key_env)).flatten() else {
        let name = if api_key_env.is_empty() { "(api_key_env unset)" } else { api_key_env };
        return Err(format!("no API key: env {name} is empty"));
    };
    if let Some(pk) = (!private_key_env.is_empty()).then(|| env(private_key_env)).flatten() {
        let pem = if pk.trim_start().starts_with("-----BEGIN") {
            Ok(pk)
        } else {
            let p = crate::config::expanduser(&pk);
            std::fs::read_to_string(Path::new(&p)).map_err(|e| e.to_string())
        };
        return pem
            .and_then(|pem| Signer::ed25519_from_pem(&pem))
            .map(|signer| Credentials { api_key, signer })
            .map_err(|e| format!("bad Ed25519 key in {private_key_env}: {e}"));
    }
    if let Some(secret) = (!secret_env.is_empty()).then(|| env(secret_env)).flatten() {
        return Ok(Credentials { api_key, signer: Signer::hmac(&secret) });
    }
    let name = [private_key_env, secret_env].into_iter().find(|s| !s.is_empty()).unwrap_or("private_key_env");
    Err(format!("no secret: set {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::pkcs8::EncodePrivateKey;
    use ed25519_dalek::{Signature, Verifier};

    fn pem(k: &SigningKey) -> String {
        k.to_pkcs8_pem(Default::default()).unwrap().to_string()
    }

    fn b64(s: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode(s).unwrap()
    }

    #[test]
    fn query_keeps_at_sign_unencoded() {
        let q = query(&[("fromEmail", "a.b+c@example.com"), ("startTime", "1"), ("note", "x y/z")]);
        assert_eq!(q, "fromEmail=a.b%2Bc@example.com&startTime=1&note=x%20y%2Fz");
    }

    #[test]
    fn ed25519_signs_query_with_raw_at() {
        let key = SigningKey::from_bytes(&rand::random::<[u8; 32]>());
        let s = Signer::ed25519_from_pem(&pem(&key)).unwrap();
        let payload = query(&[("email", "sub@example.com"), ("timestamp", "1700000000000")]);
        assert_eq!(payload, "email=sub@example.com&timestamp=1700000000000");
        let sig = Signature::from_slice(&b64(&s.sign(&payload))).unwrap();
        key.verifying_key().verify(b"email=sub@example.com&timestamp=1700000000000", &sig).unwrap();
    }

    #[test]
    fn ed25519_is_deterministic_and_base64() {
        let bytes: [u8; 32] = std::array::from_fn(|i| i as u8);
        let s = Signer::Ed25519(SigningKey::from_bytes(&bytes));
        let (a, b) = (s.sign("x=1"), s.sign("x=1"));
        assert!(a == b && b64(&a).len() == 64);
    }

    #[test]
    fn hmac_hex() {
        // HMAC-SHA256("secret", "a=1")
        let mut m = Hmac::<Sha256>::new_from_slice(b"secret").unwrap();
        m.update(b"a=1");
        assert_eq!(Signer::hmac("secret").sign("a=1"), hex::encode(m.finalize().into_bytes()));
        assert_eq!(Signer::hmac("secret").kind(), "hmac");
    }

    #[test]
    fn credentials_missing_and_pem_path() {
        let r = credentials("DESK_T_KEY", "DESK_T_PK", "");
        assert!(matches!(&r, Err(reason) if reason.contains("DESK_T_KEY")));
        let key = SigningKey::from_bytes(&rand::random::<[u8; 32]>());
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("k.pem");
        std::fs::write(&p, pem(&key)).unwrap();
        // SAFETY: test-only variables no other test reads.
        unsafe {
            std::env::set_var("DESK_T_KEY", "abc");
            std::env::set_var("DESK_T_PK", &p);
        }
        let c = credentials("DESK_T_KEY", "DESK_T_PK", "").unwrap();
        assert!(c.signer.kind() == "ed25519" && c.api_key == "abc");
    }
}
