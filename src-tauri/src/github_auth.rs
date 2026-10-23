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
}

pub fn start_device_flow(client_id: Option<String>) -> Result<DeviceCodeResponse, String> {
    let cid = client_id.unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());
    let url = "https://github.com/login/device/code";

    let resp = ureq::post(url)
        .set("Accept", "application/json")
        .send_form(&[
            ("client_id", cid.as_str()),
            ("scope", "repo,read:user,user:email"),
        ])
        .map_err(|e| format!("Failed to initiate GitHub device code: {}", e))?;

    let device_resp: DeviceCodeResponse = resp
        .into_json()
        .map_err(|e| format!("Invalid JSON response from GitHub: {}", e))?;

    Ok(device_resp)
}

pub fn poll_device_token(
    client_id: Option<String>,
    device_code: String,
) -> Result<DeviceTokenResponse, String> {
    let cid = client_id.unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());
    let url = "https://github.com/login/oauth/access_token";

    let resp = ureq::post(url)
        .set("Accept", "application/json")
        .send_form(&[
            ("client_id", cid.as_str()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .map_err(|e| format!("Failed to poll GitHub device token: {}", e))?;

    let v: serde_json::Value = resp
        .into_json()
        .map_err(|e| format!("Failed to parse JSON response: {}", e))?;

    if let Some(token) = v.get("access_token").and_then(|t| t.as_str()) {
        return Ok(DeviceTokenResponse {
            status: "approved".to_string(),
            access_token: Some(token.to_string()),
            token_type: v
                .get("token_type")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string()),
            scope: v
                .get("scope")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string()),
            interval: None,
            error_description: None,
        });
    }

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        let error_desc = v
            .get("error_description")
            .and_then(|e| e.as_str())
            .map(|s| s.to_string());
        let interval = v.get("interval").and_then(|i| i.as_u64());

        return match err {
            "authorization_pending" => Ok(DeviceTokenResponse {
                status: "pending".to_string(),
                access_token: None,
                token_type: None,
                scope: None,
                interval: interval.or(Some(5)),
                error_description: error_desc,
            }),
            "slow_down" => Ok(DeviceTokenResponse {
                status: "slow_down".to_string(),
                access_token: None,
                token_type: None,
                scope: None,
                interval: interval.or(Some(10)),
                error_description: error_desc,
            }),
            "expired_token" => Ok(DeviceTokenResponse {
                status: "expired".to_string(),
                access_token: None,
                token_type: None,
                scope: None,
                interval: None,
                error_description: error_desc.or(Some(
                    "Device code expired. Please restart login.".to_string(),
                )),
            }),
            "access_denied" => Ok(DeviceTokenResponse {
                status: "denied".to_string(),
                access_token: None,
                token_type: None,
                scope: None,
                interval: None,
                error_description: error_desc.or(Some(
                    "Authorization was denied by user.".to_string(),
                )),
            }),
            other => Ok(DeviceTokenResponse {
                status: "error".to_string(),
                access_token: None,
                token_type: None,
                scope: None,
                interval: None,
                error_description: error_desc.or(Some(other.to_string())),
            }),
        };
    }

    Ok(DeviceTokenResponse {
        status: "error".to_string(),
        access_token: None,
        token_type: None,
        scope: None,
        interval: None,
        error_description: Some(format!("Unexpected response: {}", v)),
    })
}
