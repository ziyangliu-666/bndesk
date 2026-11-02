//! What the desk needs from an exchange, whichever it is.

/// An exchange refused a request.
#[derive(Debug, thiserror::Error)]
#[error("HTTP {status}: {}", body.chars().take(200).collect::<String>())]
pub struct RestError {
    pub status: u16,
    pub body: String,
}
