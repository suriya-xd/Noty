use serde::{Deserialize, Serialize};

pub const DEFAULT_CLIENT_ID: &str = "Ov23liegRfd4WTYsq3Cf";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceTokenResponse {
    pub status: String, // "approved" | "pending" | "slow_down" | "expired" | "denied" | "error"
    pub access_token: Option<String>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
    pub interval: Option<u64>,
    pub error_description: Option<String>,
    /// Present when GitHub issues expiring tokens (they last 8 hours). Exchanged for a new access
    /// token (and a new refresh token) before the old one runs out, so the user stays signed in.
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Seconds until `access_token` expires.
    #[serde(default)]
    pub expires_in: Option<u64>,
    /// Seconds until `refresh_token` expires (about six months, reset by every refresh).
    #[serde(default)]
    pub refresh_token_expires_in: Option<u64>,
}

impl DeviceTokenResponse {
    fn status(status: &str, interval: Option<u64>, error_description: Option<String>) -> Self {
        DeviceTokenResponse {
            status: status.to_string(),
            access_token: None,
            token_type: None,
            scope: None,
            interval,
            error_description,
            refresh_token: None,
            expires_in: None,
            refresh_token_expires_in: None,
        }
    }

    /// The approved answer, with everything GitHub sent about the token's lifetime.
    fn approved(v: &serde_json::Value, token: &str) -> Self {
        let text = |k: &str| v.get(k).and_then(|t| t.as_str()).map(|s| s.to_string());
        let num = |k: &str| v.get(k).and_then(|t| t.as_u64());
        DeviceTokenResponse {
            status: "approved".to_string(),
            access_token: Some(token.to_string()),
            token_type: text("token_type"),
            scope: text("scope"),
            interval: None,
            error_description: None,
            refresh_token: text("refresh_token").filter(|t| !t.is_empty()),
            expires_in: num("expires_in"),
            refresh_token_expires_in: num("refresh_token_expires_in"),
        }
    }
}

/// One HTTP agent for GitHub calls. ureq has no timeouts unless asked, so without these a dead
/// connection (common on mobile networks) would hang the sign-in forever.
fn github_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Noetic")
        .build()
}

/// POSTs a form to GitHub and returns the JSON body. GitHub reports many failures as an HTTP
/// error status *with* a JSON explanation, so the body is read for both outcomes.
fn post_form(url: &str, form: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    match github_agent().post(url).set("Accept", "application/json").send_form(form) {
        Ok(resp) => resp
            .into_json::<serde_json::Value>()
            .map_err(|e| format!("GitHub sent a response that couldn't be read: {}", e)),
        Err(ureq::Error::Status(code, resp)) => {
            let detail = resp
                .into_json::<serde_json::Value>()
                .ok()
                .and_then(|v| v.get("error_description").and_then(|d| d.as_str()).map(String::from));
            Err(format!(
                "GitHub returned HTTP {}{}",
                code,
                detail.map(|d| format!(": {}", d)).unwrap_or_default()
            ))
        }
        Err(e) => Err(format!("Couldn't connect to GitHub: {}", e)),
    }
}

pub fn start_device_flow(client_id: Option<String>) -> Result<DeviceCodeResponse, String> {
    let cid = client_id
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());

    let v = post_form(
        "https://github.com/login/device/code",
        &[("client_id", cid.as_str()), ("scope", "repo,read:user,user:email")],
    )?;

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        let desc = v.get("error_description").and_then(|d| d.as_str()).unwrap_or("");
        return Err(match err {
            "device_flow_disabled" => "Browser sign-in isn't enabled for this app's GitHub OAuth app. \
                Turn on \"Enable Device Flow\" in its GitHub settings, or sign in with a personal access token."
                .to_string(),
            "incorrect_client_credentials" => {
                "GitHub doesn't recognise this app's client ID.".to_string()
            }
            other => format!("GitHub refused the sign-in request ({}). {}", other, desc),
        });
    }

    serde_json::from_value::<DeviceCodeResponse>(v)
        .map_err(|e| format!("GitHub's sign-in response was missing something: {}", e))
}

pub fn poll_device_token(
    client_id: Option<String>,
    device_code: String,
) -> Result<DeviceTokenResponse, String> {
    let cid = client_id
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());

    let v = post_form(
        "https://github.com/login/oauth/access_token",
        &[
            ("client_id", cid.as_str()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )?;

    if let Some(token) = v.get("access_token").and_then(|t| t.as_str()) {
        return Ok(DeviceTokenResponse::approved(&v, token));
    }

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        let error_desc = v
            .get("error_description")
            .and_then(|e| e.as_str())
            .map(|s| s.to_string());
        let interval = v.get("interval").and_then(|i| i.as_u64());

        return Ok(match err {
            "authorization_pending" => DeviceTokenResponse::status("pending", interval.or(Some(5)), error_desc),
            "slow_down" => DeviceTokenResponse::status("slow_down", interval.or(Some(10)), error_desc),
            "expired_token" => DeviceTokenResponse::status(
                "expired",
                None,
                error_desc.or(Some("Device code expired. Please restart login.".to_string())),
            ),
            "access_denied" => DeviceTokenResponse::status(
                "denied",
                None,
                error_desc.or(Some("Authorization was denied by user.".to_string())),
            ),
            other => DeviceTokenResponse::status("error", None, error_desc.or(Some(other.to_string()))),
        });
    }

    Ok(DeviceTokenResponse::status("error", None, Some(format!("Unexpected response: {}", v))))
}

/// Exchanges a refresh token for a new access token and refresh token. Tokens from the device
/// flow can be refreshed without the app's client secret. Both the old access token and the old
/// refresh token stop working once this succeeds, so the caller must keep the new pair.
///
/// `Ok` with status "approved" is a new pair; "expired" means the refresh token is no longer
/// accepted (unused for six months, or revoked) and only signing in again helps. `Err` is a
/// network or server problem: the saved sign-in is still good and should be kept.
pub fn refresh_access_token(
    client_id: Option<String>,
    refresh_token: String,
) -> Result<DeviceTokenResponse, String> {
    let cid = client_id
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());

    let v = post_form(
        "https://github.com/login/oauth/access_token",
        &[
            ("client_id", cid.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.trim()),
        ],
    )?;

    if let Some(token) = v.get("access_token").and_then(|t| t.as_str()) {
        return Ok(DeviceTokenResponse::approved(&v, token));
    }
    let desc = v.get("error_description").and_then(|d| d.as_str()).map(String::from);
    match v.get("error").and_then(|e| e.as_str()) {
        Some("bad_refresh_token") | Some("unauthorized") => Ok(DeviceTokenResponse::status(
            "expired",
            None,
            desc.or(Some("Your sign-in has expired. Sign in again to continue.".to_string())),
        )),
        Some(other) => Err(format!("GitHub couldn't renew the sign-in ({}). {}", other, desc.unwrap_or_default())),
        None => Err(format!("GitHub sent an unexpected answer while renewing the sign-in: {}", v)),
    }
}
