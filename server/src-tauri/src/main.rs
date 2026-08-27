#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State, WindowEvent,
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const GATEWAY_PORT: u16 = 8321;
const MODEL_PORT: u16 = 8322;
const MAX_REQUEST_BYTES: u64 = 6_000_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerConfig {
    #[serde(default)]
    model_path: String,
    #[serde(default)]
    public_endpoint: String,
    #[serde(default)]
    cloudflare_tunnel_token: String,
    #[serde(default)]
    cloudflared_path: String,
    #[serde(default)]
    start_with_windows: bool,
    #[serde(default)]
    auto_start: bool,
    #[serde(default)]
    pairing_key_hash: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self { model_path: String::new(), public_endpoint: String::new(), cloudflare_tunnel_token: String::new(), cloudflared_path: String::new(), start_with_windows: false, auto_start: false, pairing_key_hash: String::new() }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    gateway_port: u16,
    gateway_running: bool,
    model_running: bool,
    cloudflare_running: bool,
    cloudflared_available: bool,
    pairing_configured: bool,
    status_text: String,
}

struct ManagedChild {
    child: Child,
    identity: String,
}

#[derive(Clone)]
struct ServerState {
    config_path: PathBuf,
    config: Arc<Mutex<ServerConfig>>,
    model: Arc<Mutex<Option<ManagedChild>>>,
    tunnel: Arc<Mutex<Option<ManagedChild>>>,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("server.json"))
}

fn load_config(path: &Path) -> ServerConfig {
    fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn write_config(state: &ServerState, config: &ServerConfig) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(&state.config_path, raw).map_err(|error| error.to_string())
}

fn token_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn same_token(left: &str, right: &str) -> bool {
    if left.len() != right.len() { return false; }
    left.bytes().zip(right.bytes()).fold(0_u8, |difference, (a, b)| difference | (a ^ b)) == 0
}

fn process_running(slot: &Mutex<Option<ManagedChild>>) -> bool {
    let Ok(mut guard) = slot.lock() else { return false; };
    let Some(runtime) = guard.as_mut() else { return false; };
    runtime.child.try_wait().ok().is_some_and(|result| result.is_none())
}

fn hidden_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
}

fn llama_server_path() -> Result<PathBuf, String> {
    let executable = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    if let Ok(current) = env::current_exe() {
        if let Some(directory) = current.parent() {
            let bundled = directory.join("llama").join(executable);
            if bundled.is_file() { return Ok(bundled); }
        }
    }
    Ok(PathBuf::from(executable))
}

fn cloudflared_command(config: &ServerConfig) -> Result<PathBuf, String> {
    if !config.cloudflared_path.trim().is_empty() {
        let path = PathBuf::from(config.cloudflared_path.trim());
        if path.is_file() { return Ok(path); }
        return Err("The selected cloudflared.exe file no longer exists.".into());
    }
    Ok(PathBuf::from(if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" }))
}

fn command_available(path: &Path) -> bool {
    let mut command = Command::new(path);
    command.arg("--version");
    hidden_command(&mut command);
    command.output().is_ok_and(|output| output.status.success())
}

fn local_model_ready() -> bool {
    Client::builder().timeout(Duration::from_millis(900)).build().and_then(|client| client.get(format!("http://127.0.0.1:{MODEL_PORT}/v1/models")).send()).is_ok_and(|response| response.status().is_success())
}

fn start_model(state: &ServerState, config: &ServerConfig) -> Result<(), String> {
    let model_path = PathBuf::from(config.model_path.trim());
    if !model_path.is_file() || !model_path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("gguf")) {
        return Err("Choose an existing .gguf General AI model before starting the server.".into());
    }
    let mut guard = state.model.lock().map_err(|_| "SoFlo Server could not access its model runtime.".to_string())?;
    if let Some(runtime) = guard.as_mut() {
        if runtime.identity == model_path.to_string_lossy() && runtime.child.try_wait().map_err(|error| error.to_string())?.is_none() && local_model_ready() { return Ok(()); }
        let _ = runtime.child.kill(); let _ = runtime.child.wait(); *guard = None;
    }
    let executable = llama_server_path()?;
    let mut command = Command::new(&executable);
    command.args(["-m", &model_path.to_string_lossy(), "--host", "127.0.0.1", "--port", &MODEL_PORT.to_string(), "--ctx-size", "16384", "--parallel", "2", "--gpu-layers", "auto", "--reasoning", "off", "--no-webui"]);
    hidden_command(&mut command);
    let child = command.spawn().map_err(|error| format!("SoFlo Server could not start llama.cpp ({error})."))?;
    *guard = Some(ManagedChild { child, identity: model_path.to_string_lossy().to_string() });
    drop(guard);
    for _ in 0..150 {
        if local_model_ready() { return Ok(()); }
        if !process_running(&state.model) { return Err("llama.cpp stopped while loading the selected model.".into()); }
        thread::sleep(Duration::from_millis(500));
    }
    Err("The selected model took too long to load. Try a smaller GGUF model or check GPU memory.".into())
}

fn start_cloudflare(state: &ServerState, config: &ServerConfig) -> Result<(), String> {
    if config.public_endpoint.trim().is_empty() && config.cloudflare_tunnel_token.trim().is_empty() { return Ok(()); }
    if !config.public_endpoint.trim().starts_with("https://") { return Err("Use an HTTPS Cloudflare hostname, such as https://ai.mikeymele.com.".into()); }
    if config.cloudflare_tunnel_token.trim().is_empty() { return Err("Paste the remotely-managed Cloudflare Tunnel token before starting the public server.".into()); }
    let executable = cloudflared_command(config)?;
    if !command_available(&executable) { return Err("cloudflared.exe was not found. Install it from Cloudflare or choose its executable in SoFlo Server.".into()); }
    let mut guard = state.tunnel.lock().map_err(|_| "SoFlo Server could not access Cloudflare Tunnel.".to_string())?;
    if let Some(runtime) = guard.as_mut() {
        if runtime.identity == config.cloudflare_tunnel_token && runtime.child.try_wait().map_err(|error| error.to_string())?.is_none() { return Ok(()); }
        let _ = runtime.child.kill(); let _ = runtime.child.wait(); *guard = None;
    }
    let mut command = Command::new(executable);
    command.args(["tunnel", "--no-autoupdate", "run", "--token", config.cloudflare_tunnel_token.trim()]);
    hidden_command(&mut command);
    let child = command.spawn().map_err(|error| format!("Cloudflare Tunnel could not start ({error})."))?;
    *guard = Some(ManagedChild { child, identity: config.cloudflare_tunnel_token.clone() });
    Ok(())
}

fn stop_child(slot: &Mutex<Option<ManagedChild>>) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(mut runtime) = guard.take() { let _ = runtime.child.kill(); let _ = runtime.child.wait(); }
    }
}

fn send_gateway_response(request: Request, status: u16, content_type: &str, body: Vec<u8>) {
    let mut response = Response::from_data(body).with_status_code(StatusCode(status));
    if let Ok(header) = Header::from_bytes("Content-Type", content_type) { response = response.with_header(header); }
    let _ = request.respond(response);
}

fn gateway_request(mut request: Request, state: &ServerState) {
    let path = request.url().split('?').next().unwrap_or_default().to_string();
    if request.method() == &Method::Get && path == "/health" { send_gateway_response(request, 200, "application/json", br#"{"status":"ok"}"#.to_vec()); return; }
    if !matches!((request.method(), path.as_str()), (&Method::Get, "/v1/models") | (&Method::Post, "/v1/chat/completions")) { send_gateway_response(request, 404, "application/json", br#"{"error":"not found"}"#.to_vec()); return; }
    let config = match state.config.lock() { Ok(config) => config.clone(), Err(_) => { send_gateway_response(request, 503, "application/json", br#"{"error":"server unavailable"}"#.to_vec()); return; } };
    if config.pairing_key_hash.is_empty() { send_gateway_response(request, 503, "application/json", br#"{"error":"no paired device configured"}"#.to_vec()); return; }
    let supplied = request.headers().iter().find(|header| header.field.as_str().to_string().eq_ignore_ascii_case("authorization")).and_then(|header| header.value.as_str().strip_prefix("Bearer ")).unwrap_or_default();
    if !same_token(&token_hash(supplied), &config.pairing_key_hash) { send_gateway_response(request, 401, "application/json", br#"{"error":"unauthorized"}"#.to_vec()); return; }
    if !process_running(&state.model) { send_gateway_response(request, 503, "application/json", br#"{"error":"model is not running"}"#.to_vec()); return; }
    let mut body = Vec::new();
    if request.as_reader().take(MAX_REQUEST_BYTES + 1).read_to_end(&mut body).is_err() || body.len() as u64 > MAX_REQUEST_BYTES { send_gateway_response(request, 413, "application/json", br#"{"error":"request too large"}"#.to_vec()); return; }
    let client = match Client::builder().timeout(Duration::from_secs(240)).build() { Ok(client) => client, Err(_) => { send_gateway_response(request, 503, "application/json", br#"{"error":"server unavailable"}"#.to_vec()); return; } };
    let upstream = format!("http://127.0.0.1:{MODEL_PORT}{path}");
    let response = match request.method() { &Method::Get => client.get(upstream).send(), &Method::Post => client.post(upstream).header("Content-Type", "application/json").body(body).send(), _ => unreachable!() };
    match response {
        Ok(response) => { let status = response.status().as_u16(); let content_type = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("application/json").to_string(); let bytes = response.bytes().map(|bytes| bytes.to_vec()).unwrap_or_else(|_| br#"{"error":"model response failed"}"#.to_vec()); send_gateway_response(request, status, &content_type, bytes); }
        Err(_) => send_gateway_response(request, 502, "application/json", br#"{"error":"model could not be reached"}"#.to_vec()),
    }
}

fn start_gateway(state: ServerState) -> Result<(), String> {
    let server = Server::http(("127.0.0.1", GATEWAY_PORT)).map_err(|error| format!("SoFlo Server could not reserve localhost:{GATEWAY_PORT} ({error})."))?;
    thread::Builder::new().name("soflo-server-gateway".into()).spawn(move || for request in server.incoming_requests() { gateway_request(request, &state); }).map_err(|_| "SoFlo Server could not start its local gateway.".to_string())?;
    Ok(())
}

fn set_startup(enabled: bool) -> Result<(), String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new("reg");
    if enabled { command.args(["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "SoFlo Server", "/t", "REG_SZ", "/d", &format!("\"{}\" --minimized", executable.to_string_lossy()), "/f"]); }
    else { command.args(["delete", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "SoFlo Server", "/f"]); }
    hidden_command(&mut command);
    let status = command.status().map_err(|error| error.to_string())?;
    if status.success() || !enabled { Ok(()) } else { Err("Windows could not save the SoFlo Server startup setting.".into()) }
}

#[tauri::command]
fn get_server_config(state: State<'_, ServerState>) -> Result<ServerConfig, String> { state.config.lock().map(|config| config.clone()).map_err(|_| "SoFlo Server configuration is unavailable.".into()) }

#[tauri::command]
fn save_server_config(state: State<'_, ServerState>, config: ServerConfig) -> Result<ServerConfig, String> {
    let mut clean = config; clean.public_endpoint = clean.public_endpoint.trim().trim_end_matches('/').to_string();
    set_startup(clean.start_with_windows)?;
    write_config(&state, &clean)?;
    *state.config.lock().map_err(|_| "SoFlo Server configuration is unavailable.".to_string())? = clean.clone();
    Ok(clean)
}

#[tauri::command]
fn generate_pairing_key(state: State<'_, ServerState>) -> Result<String, String> {
    let mut bytes = [0_u8; 32]; OsRng.fill_bytes(&mut bytes); let key = URL_SAFE_NO_PAD.encode(bytes);
    let mut config = state.config.lock().map_err(|_| "SoFlo Server configuration is unavailable.".to_string())?;
    config.pairing_key_hash = token_hash(&key); write_config(&state, &config)?; Ok(key)
}

#[tauri::command]
fn start_server(state: State<'_, ServerState>) -> Result<(), String> {
    let config = state.config.lock().map_err(|_| "SoFlo Server configuration is unavailable.".to_string())?.clone();
    if config.pairing_key_hash.is_empty() { return Err("Generate a device pairing key first. Without it, the public endpoint stays locked.".into()); }
    start_model(&state, &config)?; start_cloudflare(&state, &config)
}

#[tauri::command]
fn stop_server(state: State<'_, ServerState>) { stop_child(&state.tunnel); stop_child(&state.model); }

#[tauri::command]
fn get_server_status(state: State<'_, ServerState>) -> ServerStatus {
    let config = state.config.lock().ok().map(|config| config.clone()).unwrap_or_default();
    let cloudflared_available = cloudflared_command(&config).ok().is_some_and(|path| command_available(&path));
    let model_running = process_running(&state.model); let cloudflare_running = process_running(&state.tunnel);
    let status_text = if model_running && (config.cloudflare_tunnel_token.trim().is_empty() || cloudflare_running) { "Server is ready for its paired SoFlo app.".into() } else if model_running { "Model is running locally; Cloudflare Tunnel is not connected.".into() } else { "Choose a model, configure Cloudflare, then start the server.".into() };
    ServerStatus { gateway_port: GATEWAY_PORT, gateway_running: true, model_running, cloudflare_running, cloudflared_available, pairing_configured: !config.pairing_key_hash.is_empty(), status_text }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = ServerState { config_path: config_path(app.handle())?, config: Arc::new(Mutex::new(ServerConfig::default())), model: Arc::new(Mutex::new(None)), tunnel: Arc::new(Mutex::new(None)) };
            let config = load_config(&state.config_path); *state.config.lock().map_err(|_| "SoFlo Server configuration is unavailable.")? = config.clone();
            start_gateway(state.clone())?;
            app.manage(state.clone());
            let show = MenuItem::with_id(app, "show", "Show dashboard", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Stop server and exit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::with_id("soflo-server").menu(&menu).on_menu_event(|app, event| match event.id.as_ref() { "show" => { if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); } }, "quit" => { if let Some(state) = app.try_state::<ServerState>() { stop_child(&state.tunnel); stop_child(&state.model); } app.exit(0); }, _ => {} }).build(app)?;
            if env::args().any(|argument| argument == "--minimized") { if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); } }
            if config.auto_start { let state = state.clone(); thread::spawn(move || { let _ = start_model(&state, &config); let _ = start_cloudflare(&state, &config); }); }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_server_config, save_server_config, generate_pairing_key, start_server, stop_server, get_server_status])
        .on_window_event(|window, event| if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); })
        .run(tauri::generate_context!())
        .expect("SoFlo Server failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_key_hash_only_accepts_the_original_key() {
        let key = "a-long-device-key-that-never-needs-to-be-sent-to-cloudflare";
        let hash = token_hash(key);
        assert!(same_token(&token_hash(key), &hash));
        assert!(!same_token(&token_hash("a-different-device-key"), &hash));
    }

    #[test]
    fn server_config_defaults_to_local_only_and_locked() {
        let config = ServerConfig::default();
        assert!(config.public_endpoint.is_empty());
        assert!(config.cloudflare_tunnel_token.is_empty());
        assert!(config.pairing_key_hash.is_empty());
    }
}
