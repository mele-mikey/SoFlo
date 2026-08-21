use std::{
    collections::{HashMap, HashSet},
    env,
    fs,
    io::{Cursor, Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection, OptionalExtension, Row};
use symphonia::{
    core::{
        codecs::audio::AudioDecoderOptions,
        errors::Error as SymphoniaError,
        formats::{probe::Hint, FormatOptions, TrackType},
        io::MediaSourceStream,
        meta::MetadataOptions,
    },
    default::{get_codecs, get_probe},
};
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

use crate::{database::Database, models::*};

type CommandResult<T> = Result<T, String>;

/// `pdf-extract`'s stock text writer is intentionally conservative when it
/// decides that a gap is a word space. Some Google Docs PDFs position glyphs
/// individually, which made words such as "your" arrive as "y ou". This writer
/// uses the PDF's word boundaries first and a less eager spatial fallback.
#[derive(Default)]
struct FlowTextOutput {
    text: String,
    last_end: f64,
    last_y: f64,
    first_character_in_word: bool,
    has_character: bool,
    preserve_vertical_gaps: bool,
}

impl pdf_extract::OutputDev for FlowTextOutput {
    fn begin_page(
        &mut self,
        _page_num: u32,
        _media_box: &pdf_extract::MediaBox,
        _art_box: Option<(f64, f64, f64, f64)>,
    ) -> Result<(), pdf_extract::OutputError> {
        if self.has_character && !self.text.ends_with('\u{000c}') {
            self.text.push('\u{000c}');
        }
        self.last_end = f64::MAX;
        self.last_y = 0.0;
        self.first_character_in_word = false;
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), pdf_extract::OutputError> {
        Ok(())
    }

    fn output_character(
        &mut self,
        trm: &pdf_extract::Transform,
        width: f64,
        _spacing: f64,
        font_size: f64,
        character: &str,
    ) -> Result<(), pdf_extract::OutputError> {
        let x = trm.m31;
        let y = trm.m32;
        // PDF text matrices may scale or rotate the font. Using the unscaled
        // font size here makes ordinary glyph advances look like word gaps.
        let horizontal_scale = (trm.m11.powi(2) + trm.m12.powi(2)).sqrt();
        let vertical_scale = (trm.m21.powi(2) + trm.m22.powi(2)).sqrt();
        let size = (font_size.abs() * horizontal_scale.max(vertical_scale)).max(1.0);
        if self.has_character && self.first_character_in_word {
            let vertical_change = (y - self.last_y).abs();
            if vertical_change > size * 0.45 || (x < self.last_end && vertical_change > size * 0.2)
            {
                if self.preserve_vertical_gaps && vertical_change > size * 1.35 {
                    if !self.text.ends_with("\n\n") {
                        if !self.text.ends_with('\n') {
                            self.text.push('\n');
                        }
                        self.text.push('\n');
                    }
                } else if !self.text.ends_with('\n') {
                    self.text.push('\n');
                }
            } else if x > self.last_end + size * 0.22
                && !matches!(self.text.chars().last(), Some(' ' | '\n' | '\u{000c}'))
            {
                self.text.push(' ');
            }
        }
        self.text.push_str(character);
        self.has_character = true;
        self.first_character_in_word = false;
        self.last_y = y;
        self.last_end = x + width * font_size.abs() * horizontal_scale;
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), pdf_extract::OutputError> {
        self.first_character_in_word = true;
        Ok(())
    }

    fn end_word(&mut self) -> Result<(), pdf_extract::OutputError> {
        Ok(())
    }

    fn end_line(&mut self) -> Result<(), pdf_extract::OutputError> {
        Ok(())
    }
}

fn extract_pdf_text(bytes: &[u8]) -> CommandResult<String> {
    let document = pdf_extract::Document::load_mem(bytes)
        .map_err(|_| "SoFlo could not extract editable text from that PDF.".to_string())?;
    let mut output = FlowTextOutput::default();
    pdf_extract::output_doc(&document, &mut output)
        .map_err(|_| "SoFlo could not extract editable text from that PDF.".to_string())?;
    Ok(output.text)
}

/// Syllabi are read-only, so their import can retain the PDF's vertical gaps
/// for the local model to reason about. Paper and lecture imports keep the
/// existing compact extraction path unchanged.
fn extract_syllabus_pdf_text(bytes: &[u8]) -> CommandResult<String> {
    let document = pdf_extract::Document::load_mem(bytes)
        .map_err(|_| "SoFlo could not extract editable text from that PDF.".to_string())?;
    let mut output = FlowTextOutput {
        preserve_vertical_gaps: true,
        ..Default::default()
    };
    pdf_extract::output_doc(&document, &mut output)
        .map_err(|_| "SoFlo could not extract editable text from that PDF.".to_string())?;
    Ok(output.text)
}

fn purge_expired_trash(connection: &Connection) -> CommandResult<()> {
    connection.execute("DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', '-30 days')", []).map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM flashcard_sets WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', '-30 days')", []).map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM study_webs WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', '-30 days')", []).map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM flashcard_sets WHERE is_study_web_private=1 AND id NOT IN (SELECT flashcard_set_id FROM study_web_sources)", []).map_err(|error| error.to_string())?;
    Ok(())
}

const AI_WARM_WINDOW: Duration = Duration::from_secs(30);
// Flashcard creation needs room for both source material and a JSON answer.
// 8k leaves too little input room once a 100-card response is requested.
const AI_CONTEXT_SIZE: &str = "16384";
// Flashcard generation is deliberately split into compact source batches. An
// 8k context leaves room for the densest math batch and its closed JSON answer
// while avoiding a 32k KV cache that can push a 4B model out of an integrated
// GPU's shared memory and make every section dramatically slower.
const FLASHCARD_AI_CONTEXT_SIZE: &str = "8192";
const STUDY_WEB_AI_CONTEXT_SIZE: &str = "12288";
const WORD_AI_CONTEXT_SIZE: &str = "4096";
// Use llama.cpp's documented GPU profiles. `all` is the fast path, `auto`
// fits what it can, and CPU remains the final compatibility fallback.
const AI_GPU_LAYERS: &str = "all";
const AI_PARALLEL_REQUESTS: &str = "1";
const AI_SOURCE_CHUNK_CHARS: usize = 12_000;
const FLASHCARD_SOURCE_CHUNK_CHARS: usize = 6_000;
const FLASHCARD_BATCH_CARD_LIMIT: usize = 8;
const FLASHCARD_BATCH_MAX_TOKENS: u16 = 1_400;
const FLASHCARD_TOTAL_SOURCE_CHARS: usize = 100_000;
const DEFAULT_AI_MODEL_NAME: &str = "Qwen3-4B-Q4_K_M.gguf";
const DEFAULT_AI_MODEL_MINIMUM_BYTES: u64 = 2_000_000_000;
const WORD_AI_MODEL_NAME: &str = "Qwen3-1.7B-Q4_K_M.gguf";
const WORD_AI_MINIMUM_BYTES: u64 = 1_000_000_000;
const LEGACY_DEFAULT_AI_MODEL_NAME: &str = "qwen2.5-3b-instruct-q4_k_m.gguf";
const GENERAL_LOW_MODEL_NAME: &str = "Qwen3-1.7B-Q4_K_M.gguf";
const GENERAL_HIGH_MODEL_NAME: &str = "Qwen3-8B-Q4_K_M.gguf";
const WRITING_LOW_MODEL_NAME: &str = "Qwen3-0.6B-Q4_K_M.gguf";
const WRITING_HIGH_MODEL_NAME: &str = "Qwen3-4B-Q4_K_M.gguf";
const VOICE_LOW_MODEL_NAME: &str = "ggml-base.en.bin";
const VOICE_MEDIUM_MODEL_NAME: &str = "ggml-small.en.bin";
const VOICE_HIGH_MODEL_NAME: &str = "ggml-medium.en.bin";
const VOICE_SAMPLE_RATE: i64 = 16_000;
const VOICE_CHUNK_TARGET_MS: i64 = 20_000;

#[derive(Clone, Copy)]
struct ManagedAiModel {
    filename: &'static str,
    url: &'static str,
    minimum_bytes: Option<u64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAiModelPaths {
    general_path: String,
    writing_path: String,
    voice_path: String,
}

fn managed_ai_model(role: &str, tier: &str) -> CommandResult<ManagedAiModel> {
    match (role, tier) {
        ("general", "low") => Ok(ManagedAiModel { filename: GENERAL_LOW_MODEL_NAME, url: "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf?download=true", minimum_bytes: Some(1_000_000_000) }),
        ("general", "medium") => Ok(ManagedAiModel { filename: DEFAULT_AI_MODEL_NAME, url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true", minimum_bytes: Some(2_000_000_000) }),
        ("general", "high") => Ok(ManagedAiModel { filename: GENERAL_HIGH_MODEL_NAME, url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf?download=true", minimum_bytes: Some(4_000_000_000) }),
        ("writing", "low") => Ok(ManagedAiModel { filename: WRITING_LOW_MODEL_NAME, url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf?download=true", minimum_bytes: Some(350_000_000) }),
        ("writing", "medium") => Ok(ManagedAiModel { filename: WORD_AI_MODEL_NAME, url: "https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf?download=true", minimum_bytes: Some(1_000_000_000) }),
        ("writing", "high") => Ok(ManagedAiModel { filename: WRITING_HIGH_MODEL_NAME, url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true", minimum_bytes: Some(2_000_000_000) }),
        ("voice", "low") => Ok(ManagedAiModel { filename: VOICE_LOW_MODEL_NAME, url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true", minimum_bytes: Some(100_000_000) }),
        ("voice", "medium") => Ok(ManagedAiModel { filename: VOICE_MEDIUM_MODEL_NAME, url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin?download=true", minimum_bytes: Some(350_000_000) }),
        ("voice", "high") => Ok(ManagedAiModel { filename: VOICE_HIGH_MODEL_NAME, url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin?download=true", minimum_bytes: Some(900_000_000) }),
        _ => Err("Choose a Low, Medium, or High SoFlo AI model.".into()),
    }
}

fn managed_models_dir(app: &tauri::AppHandle) -> CommandResult<std::path::PathBuf> {
    Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("models"))
}

fn general_model_minimum_bytes(path: &Path) -> u64 {
    match path.file_name().and_then(|name| name.to_str()) {
        Some(name) if name.eq_ignore_ascii_case(GENERAL_HIGH_MODEL_NAME) => 4_000_000_000,
        Some(name) if name.eq_ignore_ascii_case(DEFAULT_AI_MODEL_NAME) => {
            DEFAULT_AI_MODEL_MINIMUM_BYTES
        }
        _ => 1_000_000_000,
    }
}

fn is_complete_general_ai_model(path: &Path) -> bool {
    path.is_file()
        && fs::metadata(path).is_ok_and(|metadata| metadata.len() >= general_model_minimum_bytes(path))
}

/// Desktop shortcuts do not always inherit the updated user PATH after llama.cpp
/// is installed with WinGet. Resolve its normal locations explicitly so an
/// installed SoFlo app has the same runtime access as a developer terminal.
fn llama_server_executable() -> PathBuf {
    let executable = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    if let Ok(current_exe) = env::current_exe() {
        if let Some(install_directory) = current_exe.parent() {
            let bundled = install_directory.join("llama").join(executable);
            if bundled.is_file() {
                return bundled;
            }
        }
    }
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            let candidate = directory.join(executable);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(local_data) = env::var_os("LOCALAPPDATA") {
            let winget = PathBuf::from(&local_data).join("Microsoft").join("WinGet");
            let link = winget.join("Links").join(executable);
            if link.is_file() {
                return link;
            }
            if let Ok(entries) = fs::read_dir(winget.join("Packages")) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    if name.to_string_lossy().to_ascii_lowercase().starts_with("ggml.llamacpp_") {
                        let candidate = entry.path().join(executable);
                        if candidate.is_file() {
                            return candidate;
                        }
                    }
                }
            }
        }
    }
    PathBuf::from(executable)
}

/// Ask the bundled llama.cpp runtime which accelerator it can actually use.
/// Radeon drivers alone are not enough; this only returns a device when the
/// shipped llama-server has a compatible Vulkan/CUDA/Metal backend too.
fn llama_acceleration_device() -> Option<String> {
    let mut command = Command::new(llama_server_executable());
    command.arg("--list-devices");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let devices = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    devices
        .lines()
        .filter_map(|line| line.trim().split_once(':').map(|(device, _)| device.trim()))
        .find(|device| {
            let lower = device.to_ascii_lowercase();
            lower.starts_with("vulkan") || lower.starts_with("cuda") || lower.starts_with("metal")
        })
        .map(str::to_owned)
}
struct AiServer {
    child: Child,
    model_path: String,
    context_size: String,
    reasoning: String,
    port: u16,
    last_used: Instant,
}
static AI_SERVER: OnceLock<Mutex<Option<AiServer>>> = OnceLock::new();
static WORD_AI_SERVER: OnceLock<Mutex<Option<AiServer>>> = OnceLock::new();
static AI_SERVER_SESSION_PINNED: AtomicBool = AtomicBool::new(false);
static WORD_AI_SERVER_SESSION_PINNED: AtomicBool = AtomicBool::new(false);

fn resolve_ai_model_path(app: &tauri::AppHandle, requested_path: &str) -> CommandResult<String> {
    let requested = Path::new(requested_path.trim());
    let default_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("models")
        .join(DEFAULT_AI_MODEL_NAME);
    let requested_is_legacy_default = requested
        .file_name()
        .and_then(|file| file.to_str())
        .is_some_and(|file| file.eq_ignore_ascii_case(LEGACY_DEFAULT_AI_MODEL_NAME));
    let model = if requested
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"))
        && requested.is_file()
        && !requested_is_legacy_default
    {
        requested.to_path_buf()
    } else if default_path.is_file() {
        default_path
    } else {
        return Err("SoFlo could not find the current local AI model. Download the 4B model in Settings, then try again.".into());
    };
    let size = fs::metadata(&model)
        .map_err(|_| "SoFlo could not read the local AI model.".to_string())?
        .len();
    if size < general_model_minimum_bytes(&model) {
        return Err("SoFlo's General AI model is incomplete. Download or update your models in Settings, then try again.".into());
    }
    if size > 8_000_000_000 {
        return Err("Choose a compact local model (8B parameters or less).".into());
    }
    Ok(model.to_string_lossy().to_string())
}

fn resolve_word_ai_model_path(app: &tauri::AppHandle, requested_path: &str) -> CommandResult<String> {
    let requested = Path::new(requested_path.trim());
    let default = managed_models_dir(app)?.join(WORD_AI_MODEL_NAME);
    let model = if requested.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("gguf")) && requested.is_file() { requested.to_path_buf() } else { default };
    if !is_complete_word_ai_model(&model) {
        return Err("SoFlo's fast word-reference model is not downloaded yet. Download the AI model package in Settings, then try again.".into());
    }
    Ok(model.to_string_lossy().to_string())
}

fn is_complete_word_ai_model(path: &Path) -> bool {
    path.is_file()
        && fs::metadata(path).is_ok_and(|metadata| metadata.len() >= WORD_AI_MINIMUM_BYTES)
}

fn resolve_voice_model_path(app: &tauri::AppHandle, requested_path: &str) -> CommandResult<String> {
    let requested = Path::new(requested_path.trim());
    let fallback = managed_models_dir(app)?.join(VOICE_MEDIUM_MODEL_NAME);
    let model = if requested.is_file() && requested.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("bin")) {
        requested.to_path_buf()
    } else {
        fallback
    };
    if !is_complete_voice_model(&model) {
        return Err("SoFlo's local transcription model is not downloaded yet. Download the AI model package in Settings, then try again.".into());
    }
    Ok(model.to_string_lossy().to_string())
}

fn is_complete_voice_model(path: &Path) -> bool {
    path.is_file() && fs::metadata(path).is_ok_and(|metadata| metadata.len() >= 100_000_000)
}

#[tauri::command]
pub fn word_ai_model_ready(app: tauri::AppHandle, database: State<'_, Database>) -> CommandResult<bool> {
    let settings = get_settings(&database.open()?, None)?;
    let configured = Path::new(&settings.ai_writing_model_path);
    let default = managed_models_dir(&app)?.join(WORD_AI_MODEL_NAME);
    let model = if is_complete_word_ai_model(configured) {
        configured.to_path_buf()
    } else {
        default
    };
    Ok(is_complete_word_ai_model(&model))
}

#[tauri::command]
pub fn general_ai_model_ready(app: tauri::AppHandle, database: State<'_, Database>) -> CommandResult<bool> {
    let settings = get_settings(&database.open()?, None)?;
    let configured = Path::new(&settings.ai_model_path);
    let default = managed_models_dir(&app)?.join(DEFAULT_AI_MODEL_NAME);
    let model = if is_complete_general_ai_model(configured) {
        configured.to_path_buf()
    } else {
        default
    };
    Ok(is_complete_general_ai_model(&model))
}

#[tauri::command]
pub fn voice_ai_model_ready(app: tauri::AppHandle, database: State<'_, Database>) -> CommandResult<bool> {
    let settings = get_settings(&database.open()?, None)?;
    let configured = Path::new(&settings.ai_voice_model_path).to_path_buf();
    let default = managed_models_dir(&app)?.join(VOICE_MEDIUM_MODEL_NAME);
    Ok(is_complete_voice_model(&configured) || is_complete_voice_model(&default))
}

#[tauri::command]
pub fn start_window_dragging(window: tauri::Window) -> CommandResult<()> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn minimize_window(window: tauri::Window) -> CommandResult<()> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn toggle_maximize_window(window: tauri::Window) -> CommandResult<()> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn close_window(window: tauri::Window) -> CommandResult<()> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn force_close_window(window: tauri::Window) -> CommandResult<()> {
    AI_SERVER_SESSION_PINNED.store(false, Ordering::Relaxed);
    WORD_AI_SERVER_SESSION_PINNED.store(false, Ordering::Relaxed);
    stop_model_server(&AI_SERVER);
    stop_model_server(&WORD_AI_SERVER);
    window.destroy().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn is_installer_launch() -> bool {
    std::env::args().any(|argument| argument == "--installer")
}

#[tauri::command]
pub fn is_uninstaller_launch() -> bool {
    std::env::args().any(|argument| argument == "--uninstaller")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerVersionInfo {
    pub current_version: String,
    pub target_version: String,
}

#[tauri::command]
pub fn installer_version_info() -> InstallerVersionInfo {
    let argument_value = |prefix: &str| {
        std::env::args()
            .find_map(|argument| argument.strip_prefix(prefix).map(str::to_string))
            .unwrap_or_default()
    };
    InstallerVersionInfo {
        current_version: argument_value("--current-version="),
        target_version: argument_value("--target-version="),
    }
}

fn setup_executable_argument() -> CommandResult<PathBuf> {
    let path = std::env::args()
        .find_map(|argument| argument.strip_prefix("--setup-exe=").map(PathBuf::from))
        .ok_or_else(|| "SoFlo setup could not find its installation worker.".to_string())?;
    if !path.is_file() {
        return Err("SoFlo setup could not find its installation worker.".into());
    }
    Ok(path)
}

fn uninstaller_executable_argument() -> CommandResult<PathBuf> {
    let path = std::env::args()
        .find_map(|argument| argument.strip_prefix("--uninstall-exe=").map(PathBuf::from))
        .ok_or_else(|| "SoFlo could not find its uninstall worker.".to_string())?;
    if !path.is_file() {
        return Err("SoFlo could not find its uninstall worker.".into());
    }
    Ok(path)
}

#[tauri::command]
pub fn run_installer_worker() -> CommandResult<()> {
    let setup = setup_executable_argument()?;
    // The branded setup UI is a separate executable, so it can close the
    // installed app before NSIS replaces it. Without this, Windows leaves the
    // old executable locked while the installer still updates its registry
    // version, creating a false successful update.
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill.exe")
            .args(["/IM", "SoFlo.exe", "/T", "/F"])
            .status();
        thread::sleep(Duration::from_millis(700));
    }
    let status = Command::new(setup)
        .arg("--perform-silent-install=1")
        .status()
        .map_err(|_| "SoFlo setup could not begin the installation.".to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("SoFlo could not finish installing. Please try again.".into())
    }
}

#[tauri::command]
pub fn run_uninstaller_worker(erase_data: bool) -> CommandResult<()> {
    let uninstaller = uninstaller_executable_argument()?;
    let mut command = Command::new(uninstaller);
    command.arg("--perform-silent-uninstall=1");
    if erase_data { command.arg("--erase-data=1"); }
    let status = command
        .status()
        .map_err(|_| "SoFlo could not begin uninstalling.".to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("SoFlo could not finish uninstalling. Please try again.".into())
    }
}

#[tauri::command]
pub fn launch_installed_soflo_and_close(app: tauri::AppHandle) -> CommandResult<()> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "Windows could not find the local application folder.".to_string())?;
    let installed_app = local_app_data
        .join("Programs")
        .join("SoFlo")
        .join("SoFlo.exe");
    if !installed_app.is_file() {
        return Err("SoFlo was installed, but its app file could not be found.".into());
    }
    Command::new(installed_app)
        .spawn()
        .map_err(|_| "SoFlo could not open after installation.".to_string())?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn launch_uninstaller_and_close(app: tauri::AppHandle) -> CommandResult<()> {
    let current = std::env::current_exe().map_err(|_| "SoFlo could not locate its installation.".to_string())?;
    let uninstaller = current.parent()
        .map(|directory| directory.join("uninstall.exe"))
        .filter(|path| path.is_file())
        .ok_or_else(|| "SoFlo's uninstaller is unavailable. Reinstall SoFlo to restore it.".to_string())?;
    Command::new(uninstaller)
        .spawn()
        .map_err(|_| "SoFlo could not open its uninstaller.".to_string())?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn import_pdf_text(path: String) -> CommandResult<String> {
    let bytes = fs::read(path).map_err(|_| "SoFlo could not read that PDF file.".to_string())?;
    let text = extract_pdf_text(&bytes)?;
    if text.trim().is_empty() {
        return Err("That PDF has no selectable text. Scanned PDFs need OCR before they can be imported as editable notes.".into());
    }
    Ok(text)
}

#[tauri::command]
pub fn import_syllabus_pdf_text(path: String) -> CommandResult<String> {
    let bytes = fs::read(path).map_err(|_| "SoFlo could not read that PDF file.".to_string())?;
    let text = extract_syllabus_pdf_text(&bytes)?;
    if text.trim().is_empty() {
        return Err("That PDF has no selectable text. Scanned PDFs need OCR before they can be imported as an editable syllabus.".into());
    }
    Ok(text)
}

#[tauri::command]
pub fn import_word_text(path: String) -> CommandResult<String> {
    let file =
        fs::File::open(path).map_err(|_| "SoFlo could not read that Word document.".to_string())?;
    word_document_to_markdown(file)
}

#[tauri::command]
pub fn import_powerpoint_text(path: String) -> CommandResult<String> {
    let source = PathBuf::from(path);
    if !source.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("pptx")) {
        return Err("Choose a .pptx PowerPoint presentation. Legacy .ppt files need to be saved as .pptx first.".into());
    }
    let file = fs::File::open(&source).map_err(|_| "SoFlo could not read that PowerPoint presentation.".to_string())?;
    powerpoint_to_markdown(file)
}

#[tauri::command]
pub fn import_google_doc(url: String) -> CommandResult<String> {
    let document_id = google_document_id(&url)?;
    let export_url = format!("https://docs.google.com/document/d/{document_id}/export?format=docx");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("SoFlo/1.1 (Google Docs import)")
        .build()
        .map_err(|_| "SoFlo could not prepare the Google Docs import.".to_string())?;
    let response = client.get(export_url).send().map_err(|_| "SoFlo could not reach Google Docs. Check your connection and try again.".to_string())?;
    if !response.status().is_success() {
        return Err("Google Docs could not download that document. Make sure the link allows viewing and downloading, or download it as a .docx first.".into());
    }
    let bytes = response.bytes().map_err(|_| "SoFlo could not download that Google Doc.".to_string())?;
    word_document_to_markdown(Cursor::new(bytes))
        .map_err(|_| "Google Docs did not return a downloadable .docx file. Make sure the document allows downloading, or download it as a .docx first.".to_string())
}

fn google_document_id(url: &str) -> CommandResult<String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://docs.google.com/") {
        return Err("Paste a Google Docs link that starts with https://docs.google.com/.".into());
    }
    let marker = "/document/d/";
    let tail = trimmed.find(marker).map(|index| &trimmed[index + marker.len()..]).ok_or_else(|| "That is not a Google Docs document link.".to_string())?;
    let id = tail.split(['/', '?', '#']).next().unwrap_or_default();
    if id.len() < 12 || !id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_') {
        return Err("That Google Docs link does not contain a valid document ID.".into());
    }
    Ok(id.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub version: String,
    pub download_url: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u8>,
    attempt: u8,
    message: String,
}

#[derive(serde::Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubReleaseAsset>,
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    let parse = |value: &str| value.trim_start_matches('v').split('.').map(|part| part.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>();
    let candidate = parse(candidate);
    let current = parse(current);
    for index in 0..candidate.len().max(current.len()) {
        let left = *candidate.get(index).unwrap_or(&0);
        let right = *current.get(index).unwrap_or(&0);
        if left != right { return left > right; }
    }
    false
}

#[tauri::command]
pub async fn check_for_app_update() -> CommandResult<Option<AppUpdateInfo>> {
    tauri::async_runtime::spawn_blocking(|| {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("SoFlo update check")
            .build()
            .map_err(|_| "SoFlo could not prepare its update check.".to_string())?;
        let response = client.get("https://api.github.com/repos/mele-mikey/SoFlo/releases/latest")
            .header("Accept", "application/vnd.github+json")
            .send()
            .map_err(|_| "SoFlo could not check GitHub Releases right now.".to_string())?;
        if !response.status().is_success() { return Ok(None); }
        let release: GithubRelease = response.json().map_err(|_| "GitHub Releases returned an unreadable update response.".to_string())?;
        let current = env!("CARGO_PKG_VERSION");
        if !version_is_newer(&release.tag_name, current) { return Ok(None); }
        let mut assets = release.assets.into_iter();
        let asset = assets.find(|asset| {
            let name = asset.name.to_ascii_lowercase();
            name.ends_with(".exe") && name.contains("setup")
        }).or_else(|| assets.find(|asset| asset.name.to_ascii_lowercase().ends_with(".msi")));
        Ok(asset.map(|asset| AppUpdateInfo { version: release.tag_name.trim_start_matches('v').to_string(), download_url: asset.browser_download_url }))
    }).await.map_err(|_| "SoFlo's update check stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn download_and_launch_app_update(app: tauri::AppHandle, version: String, download_url: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if !download_url.starts_with("https://github.com/mele-mikey/SoFlo/releases/download/") {
            return Err("SoFlo only installs updates downloaded from its official GitHub Releases page.".into());
        }
        if version.is_empty() || !version.chars().all(|character| character.is_ascii_digit() || character == '.') {
            return Err("That update version is invalid.".into());
        }
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(45))
            // A release download should survive slow but active Wi-Fi. This is
            // deliberately much longer than the lightweight update check.
            .timeout(Duration::from_secs(60 * 60))
            .user_agent("SoFlo updater")
            .build()
            .map_err(|_| "SoFlo could not prepare the update download.".to_string())?;
        let is_msi = download_url.to_ascii_lowercase().ends_with(".msi");
        let destination = std::env::temp_dir().join(format!("SoFlo-Setup-{}.{}", version, if is_msi { "msi" } else { "exe" }));
        let partial = destination.with_extension(format!("{}.partial", if is_msi { "msi" } else { "exe" }));
        let mut final_error = None;
        for attempt in 1..=3u8 {
            let existing = fs::metadata(&partial).map(|metadata| metadata.len()).unwrap_or(0);
            let _ = app.emit("app-update-download-progress", AppUpdateDownloadProgress { downloaded_bytes: existing, total_bytes: None, percent: None, attempt, message: if existing > 0 { "Resuming update download…".into() } else { "Starting update download…".into() } });
            let mut request = client.get(&download_url);
            if existing > 0 { request = request.header(reqwest::header::RANGE, format!("bytes={existing}-")); }
            let result = (|| -> CommandResult<()> {
                let mut response = request.send().map_err(|_| "The update download was interrupted.".to_string())?;
                if !(response.status().is_success() || response.status() == reqwest::StatusCode::PARTIAL_CONTENT) { return Err("GitHub Releases could not provide that update.".into()); }
                let append = existing > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
                let offset = if append { existing } else { 0 };
                let total = response.content_length().map(|length| length.saturating_add(offset));
                let mut output = if append { fs::OpenOptions::new().create(true).append(true).open(&partial) } else { fs::File::create(&partial) }.map_err(|_| "SoFlo could not save the update installer.".to_string())?;
                let mut downloaded = offset;
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    let count = response.read(&mut buffer).map_err(|_| "The update download was interrupted.".to_string())?;
                    if count == 0 { break; }
                    output.write_all(&buffer[..count]).map_err(|_| "SoFlo could not save the update installer.".to_string())?;
                    downloaded = downloaded.saturating_add(count as u64);
                    let percent = total.filter(|size| *size > 0).map(|size| ((downloaded.saturating_mul(100) / size).min(100)) as u8);
                    let _ = app.emit("app-update-download-progress", AppUpdateDownloadProgress { downloaded_bytes: downloaded, total_bytes: total, percent, attempt, message: "Downloading update…".into() });
                }
                output.flush().map_err(|_| "SoFlo could not save the update installer.".to_string())?;
                if let Some(total) = total { if downloaded < total { return Err("The update download ended before the complete installer arrived.".into()); } }
                Ok(())
            })();
            match result { Ok(()) => { final_error = None; break; }, Err(error) => { final_error = Some(error); if attempt < 3 { thread::sleep(Duration::from_secs(u64::from(attempt) * 2)); } } }
        }
        if let Some(error) = final_error { return Err(format!("{error} Your partial download was kept so SoFlo can resume it when you try again.")); }
        let bytes = fs::read(&partial).map_err(|_| "SoFlo could not verify the downloaded installer.".to_string())?;
        let valid = if is_msi { bytes.get(0..4) == Some(&[0xD0, 0xCF, 0x11, 0xE0]) } else { bytes.get(0..2) == Some(b"MZ") };
        if bytes.len() < 1024 || !valid { return Err("The downloaded update is not a valid Windows installer. Please try again.".into()); }
        let _ = fs::remove_file(&destination);
        fs::rename(&partial, &destination).map_err(|_| "SoFlo could not finalize the downloaded installer.".to_string())?;
        let _ = app.emit("app-update-download-progress", AppUpdateDownloadProgress { downloaded_bytes: bytes.len() as u64, total_bytes: Some(bytes.len() as u64), percent: Some(100), attempt: 1, message: "Opening the installer…".into() });
        if is_msi { Command::new("msiexec.exe").arg("/i").arg(&destination).spawn() } else { Command::new(&destination).spawn() }
            .map_err(|_| "SoFlo could not start the downloaded update installer.".to_string())?;
        app.exit(0);
        Ok(())
    }).await.map_err(|_| "SoFlo's update download stopped unexpectedly.".to_string())?
}

fn word_document_to_markdown<R: Read + Seek>(file: R) -> CommandResult<String> {
    let mut bytes = Vec::new();
    let mut file = file;
    file.read_to_end(&mut bytes)
        .map_err(|_| "SoFlo could not read that Word document.".to_string())?;
    let text = rwml::Document::open(&bytes)
        .map_err(|_| "That file is not a supported .doc or .docx Word document.".to_string())?
        .to_markdown();
    if text.trim().is_empty() {
        return Err("That Word document has no readable text to import.".into());
    }
    Ok(text)
}

fn powerpoint_to_markdown<R: Read + Seek>(file: R) -> CommandResult<String> {
    let mut archive = zip::ZipArchive::new(file).map_err(|_| "That file is not a supported .pptx PowerPoint presentation.".to_string())?;
    let mut slides = (0..archive.len()).filter_map(|index| archive.by_index(index).ok().and_then(|entry| {
        let name = entry.name().replace('\\', "/");
        let stem = name.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?;
        let number = stem.parse::<usize>().ok()?;
        Some((number, name))
    })).collect::<Vec<_>>();
    slides.sort_by_key(|(number, _)| *number);
    let mut markdown = Vec::new();
    for (number, name) in slides {
        let mut xml = String::new();
        archive.by_name(&name).map_err(|_| "SoFlo could not read a slide in that PowerPoint presentation.".to_string())?.read_to_string(&mut xml).map_err(|_| "SoFlo could not read a slide in that PowerPoint presentation.".to_string())?;
        let text = powerpoint_slide_text(&xml);
        if !text.is_empty() { markdown.push(format!("## Slide {number}\n\n{text}")); }
    }
    if markdown.is_empty() { return Err("That PowerPoint presentation has no readable slide text to import.".into()); }
    Ok(markdown.join("\n\n---\n\n"))
}

fn powerpoint_slide_text(xml: &str) -> String {
    let mut text = String::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<a:t") {
        let Some(tag_end) = rest[start..].find('>') else { break; };
        let after_tag = &rest[start + tag_end + 1..];
        let Some(end) = after_tag.find("</a:t>") else { break; };
        text.push_str(&decode_presentation_xml(&after_tag[..end]));
        rest = &after_tag[end + "</a:t>".len()..];
        let next_paragraph = rest.find("</a:p>");
        let next_text = rest.find("<a:t");
        if next_paragraph.is_some_and(|paragraph| next_text.map_or(true, |next| paragraph < next)) {
            text.push('\n');
        }
    }
    text.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n")
}

fn decode_presentation_xml(value: &str) -> String {
    value.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
}

#[tauri::command]
pub async fn refine_document_text(
    app: tauri::AppHandle,
    model_path: String,
    text: String,
    document_kind: String,
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        refine_document_text_blocking(app, model_path, text, document_kind)
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

fn refine_document_text_blocking(
    app: tauri::AppHandle,
    model_path: String,
    text: String,
    document_kind: String,
) -> CommandResult<String> {
    let model_path = resolve_ai_model_path(&app, &model_path)?;
    let source_text = text;
    let source_chunks = split_source_for_ai(&source_text, AI_SOURCE_CHUNK_CHARS);
    let is_syllabus = document_kind.eq_ignore_ascii_case("syllabus");
    let system = if is_syllabus {
        "You are SoFlo's meticulous local syllabus formatter. Think through the source layout silently, then return only clean Markdown—never code fences, commentary, or an explanation. Preserve every source fact exactly and never invent, summarize away, reorder, correct, or omit material. This is a formatting task, not a rewriting task. Keep every policy, deadline, contact detail, grading rule, assignment, reading, schedule item, URL, percentage, and warning. The extracted source preserves vertical spacing: one newline usually means a visual wrap inside the same block, while a blank line signals a real paragraph or section gap. Use that layout evidence. Join ordinary visual wraps into one complete paragraph, but always put a blank Markdown line between distinct paragraphs, list blocks, tables, and sections so they never run together. Use two trailing spaces only for intentional same-block line breaks such as compact contact details, poetry, or a source line that genuinely stays together. Repair only obvious PDF extraction artifacts such as a word split by a stray space (for example, 'y ou' becomes 'you'); never replace a real word. Use # only for the document title; use ## and ### only for genuine section headings; use bullets for true lists; use a table only when the source is genuinely tabular. Keep prose in complete paragraphs. Use **bold** sparingly for labels, dates, percentages, and warnings. Never use more than ###."
    } else {
        "You are SoFlo's meticulous local paper formatter. Think through the source layout silently before answering, then return only clean Markdown—never code fences, commentary, or a layout explanation. Preserve every source word, number, punctuation mark, date, URL, citation, and paragraph boundary: do not rewrite, proofread, summarize, reorder, or invent anything. This is a formatting task only. Repair only obvious PDF extraction artifacts such as a word split by a stray space (for example, 'y ou' becomes 'you'); never replace a real word. Do not assume an MLA template. Only retain a four-line MLA heading when the source genuinely contains one; otherwise do not manufacture a heading block, title, author, or date. Treat a date as ordinary text unless the source clearly uses it as metadata. Identify headings, lists, tables, quotations, and verse from the source's actual cues, never from a line's position alone. Join ordinary visual line wraps into complete paragraphs instead of echoing each PDF line. Keep intentional verse or quotations line by line using two trailing spaces for each intentional break. Use # for one actual document title only when one is evident, ## and ### only for genuine section headings, Markdown lists only for true lists, and tables only for genuinely tabular material. Preserve citations exactly, including Works Cited entries; never turn a name, date, citation, or ordinary sentence into a heading. Use **bold** or *italics* only when the source clearly indicates emphasis."
    };
    emit_ai_progress(&app, 6, "Starting your private local model");
    let ai_port = ensure_ai_server(&model_path, &app)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    let source_kind = if is_syllabus { "syllabus" } else { "paper" };
    let mut formatted_chunks = Vec::with_capacity(source_chunks.len());
    for (index, source) in source_chunks.iter().enumerate() {
        let progress = 42 + ((index as u8).saturating_mul(42) / source_chunks.len().max(1) as u8);
        emit_ai_progress(
            &app,
            progress,
            &format!(
                "Formatting section {} of {}",
                index + 1,
                source_chunks.len()
            ),
        );
        let request = format!(
            "Format section {} of {} from this extracted {} without changing its content:\n\n{}",
            index + 1,
            source_chunks.len(),
            source_kind,
            source
        );
        let request = if has_fragmented_pdf_spacing(source) {
            format!(
                "The source below has widespread PDF spacing damage: normal words were split into one-to-three-letter alphabetical pieces. Reconstruct those full words from context before applying Markdown. An answer that keeps that fragmented spacing is invalid.\n\n{}",
                request
            )
        } else {
            request
        };
        let mut formatted = request_document_format(&client, ai_port, system, &request)
            .map_err(|error| format!("{} for section {}.", error, index + 1))?;
        if is_visual_line_echo(source, &formatted) {
            emit_ai_progress(
                &app,
                progress.saturating_add(4),
                "Rebuilding the document structure",
            );
            let retry = format!(
                "The previous response was rejected because it merely echoed visual PDF lines. Format section {} of {} again as a complete Markdown {}. Preserve every word, number, date, URL, warning, and paragraph boundary. Join ordinary visual line wraps into logical paragraphs. Use headings only for genuine headings, Markdown lists only for genuine lists, and Markdown tables only for real tables. Keep intentional poetry, quotations, or verse line by line using two trailing spaces for each intentional line break. Return Markdown only, with no code fences or explanation.\n\nSOURCE:\n{}",
                index + 1,
                source_chunks.len(),
                source_kind,
                source,
            );
            formatted = request_document_format(&client, ai_port, system, &retry)
                .map_err(|error| format!("{} while rebuilding section {}.", error, index + 1))?;
        }
        if formatted.is_empty() {
            return Err(format!(
                "The local AI model returned no formatted text for section {}.",
                index + 1
            ));
        }
        formatted_chunks.push(formatted);
    }
    emit_ai_progress(&app, 86, "Turning the result into your editable paper");
    let formatted = formatted_chunks.join("\n\n");
    touch_ai_server();
    emit_ai_progress(&app, 100, "Finishing up");
    Ok(formatted)
}

fn request_document_format(
    client: &reqwest::blocking::Client,
    port: u16,
    system: &str,
    request: &str,
) -> CommandResult<String> {
    let response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", port))
        .json(&serde_json::json!({
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": request }
            ],
            "max_tokens": 4096,
            "temperature": 0.1
        }))
        .send()
        .map_err(|error| format!("SoFlo's local AI model did not respond: {}", error))?
        .error_for_status()
        .map_err(|error| {
            format!(
                "SoFlo's local AI model could not finish this import: {}",
                error
            )
        })?;
    let body: serde_json::Value = response
        .json()
        .map_err(|_| "SoFlo could not read the local AI response.".to_string())?;
    Ok(body
        .get("choices")
        .and_then(|value| value.get(0))
        .and_then(|value| value.get("message"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string())
}

fn is_visual_line_echo(source: &str, formatted: &str) -> bool {
    let source_lines = source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let formatted_lines = formatted
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if source_lines.len() < 12 || formatted_lines.len() * 100 < source_lines.len() * 80 {
        return false;
    }
    let has_markdown_structure = formatted_lines.iter().any(|line| {
        line.starts_with('#')
            || line.starts_with("- ")
            || line.starts_with("* ")
            || line.starts_with("+ ")
            || line.starts_with('|')
            || line
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
                && line.contains(". ")
    });
    let matching_lines = formatted_lines
        .iter()
        .filter(|line| source_lines.iter().any(|source_line| source_line == *line))
        .count();
    !has_markdown_structure && matching_lines * 100 >= formatted_lines.len() * 75
}

#[tauri::command]
pub async fn generate_flashcards_text(
    app: tauri::AppHandle,
    model_path: String,
    materials: String,
    guidance: String,
    syllabus_context: String,
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        generate_flashcards_text_blocking(
            app,
            model_path,
            materials,
            guidance,
            syllabus_context,
        )
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn generate_teach_it_back_question(
    app: tauri::AppHandle,
    model_path: String,
    front: String,
    back: String,
    shown_side: String,
    difficulty: String,
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let front = front.trim();
        let back = back.trim();
        if front.is_empty() || back.is_empty() {
            return Err("This card needs both a term and definition before Teach It Back can use it.".into());
        }
        let shown_side = if shown_side.eq_ignore_ascii_case("back") { "back" } else { "front" };
        let difficulty = if difficulty.eq_ignore_ascii_case("easy") { "easy" } else { "hard" };
        let resolved = resolve_ai_model_path(&app, &model_path)?;
        emit_ai_progress(&app, 12, "Preparing a teach-back question");
        let port = ensure_ai_server(&resolved, &app)?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
        let system = "You create one focused teach-back question from a two-sided flashcard. The front is normally the term or prompt and the back is normally its meaning or explanation. Use both sides as private context, but build the question around the side the student is shown. Do not reveal the hidden answer. EASY asks only for the core meaning or general definition. HARD asks for the meaning plus an important implication, connection, mechanism, example, or extra step supported by the card; never demand facts absent from the card. Return only one valid JSON object with exactly these string keys: question, target, hint. target is a short private description of what a strong answer should cover. hint is one short optional nudge that does not give away the answer.";
        let prompt = format!("FLASHCARD FRONT:\n{}\n\nFLASHCARD BACK:\n{}\n\nSIDE SHOWN TO STUDENT: {}\nDIFFICULTY: {}\nCreate the question now.", front, back, shown_side, difficulty);
        let output = local_chat_text(&client, port, system, &prompt, 520)?;
        touch_ai_server();
        if let Some(object) = json_object_from_response(&output) {
            return Ok(object);
        }
        let retry = local_chat_text(&client, port, "Return JSON only. Create one teach-back question using the supplied flashcard. Use exactly: {\"question\":\"...\",\"target\":\"...\",\"hint\":\"...\"}.", &prompt, 620)?;
        touch_ai_server();
        json_object_from_response(&retry)
            .ok_or_else(|| "SoFlo could not prepare this teach-back question.".into())
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn grade_teach_it_back_answer(
    app: tauri::AppHandle,
    model_path: String,
    front: String,
    back: String,
    question: String,
    target: String,
    answer: String,
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        if answer.trim().is_empty() {
            return Err("Write what you understand before asking SoFlo to review it.".into());
        }
        let resolved = resolve_ai_model_path(&app, &model_path)?;
        emit_ai_progress(&app, 18, "Listening to your explanation");
        let port = ensure_ai_server(&resolved, &app)?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(65))
            .build()
            .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
        let system = "You grade a student's teach-back explanation against a flashcard. Reward correct meaning expressed in the student's own words; do not demand exact wording. Be encouraging and specific. A mostly correct answer scores 60 or above. A vague, materially incorrect, or empty answer scores below 60. Return only one valid JSON object with exactly these keys: score (integer 0-100), verdict (one of strong, good, developing, review), feedback (two concise sentences), understood (array of up to 3 short strings), missed (array of up to 3 short strings).";
        let prompt = format!("FLASHCARD FRONT:\n{}\n\nFLASHCARD BACK:\n{}\n\nQUESTION:\n{}\n\nSTRONG ANSWER TARGET:\n{}\n\nSTUDENT EXPLANATION:\n{}\n\nGrade the explanation for meaning and understanding.", front.trim(), back.trim(), question.trim(), target.trim(), answer.trim());
        let output = local_chat_text(&client, port, system, &prompt, 720)?;
        touch_ai_server();
        if let Some(object) = json_object_from_response(&output) {
            return Ok(object);
        }
        let retry = local_chat_text(&client, port, "Return JSON only using exactly: {\"score\":0,\"verdict\":\"review\",\"feedback\":\"...\",\"understood\":[],\"missed\":[]}.", &prompt, 820)?;
        touch_ai_server();
        json_object_from_response(&retry)
            .ok_or_else(|| "SoFlo could not finish grading this explanation.".into())
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn review_grammar_text(
    app: tauri::AppHandle,
    model_path: String,
    text: String,
    quick: bool,
    paper_context: String,
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        review_grammar_text_blocking(app, model_path, text, quick, paper_context)
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

fn quick_mechanics_prepass(source: &str) -> Vec<serde_json::Value> {
    // These are broad, unambiguous English mechanics corrections. They run
    // before the small local model so passive checks do not miss obvious
    // apostrophes and everyday misspellings when the model focuses elsewhere.
    const CORRECTIONS: &[(&str, &str, &str, &str)] = &[
        ("alot", "a lot", "Spelling", "This is written as two words."),
        ("dont", "don't", "Apostrophe", "This contraction needs an apostrophe."),
        ("doesnt", "doesn't", "Apostrophe", "This contraction needs an apostrophe."),
        ("didnt", "didn't", "Apostrophe", "This contraction needs an apostrophe."),
        ("isnt", "isn't", "Apostrophe", "This contraction needs an apostrophe."),
        ("arent", "aren't", "Apostrophe", "This contraction needs an apostrophe."),
        ("wasnt", "wasn't", "Apostrophe", "This contraction needs an apostrophe."),
        ("werent", "weren't", "Apostrophe", "This contraction needs an apostrophe."),
        ("cant", "can't", "Apostrophe", "This contraction needs an apostrophe."),
        ("couldnt", "couldn't", "Apostrophe", "This contraction needs an apostrophe."),
        ("shouldnt", "shouldn't", "Apostrophe", "This contraction needs an apostrophe."),
        ("wouldnt", "wouldn't", "Apostrophe", "This contraction needs an apostrophe."),
        ("hasnt", "hasn't", "Apostrophe", "This contraction needs an apostrophe."),
        ("havent", "haven't", "Apostrophe", "This contraction needs an apostrophe."),
        ("hadnt", "hadn't", "Apostrophe", "This contraction needs an apostrophe."),
        ("wont", "won't", "Apostrophe", "This contraction needs an apostrophe."),
        ("wouldve", "would've", "Apostrophe", "This contraction needs an apostrophe."),
        ("couldve", "could've", "Apostrophe", "This contraction needs an apostrophe."),
        ("shouldve", "should've", "Apostrophe", "This contraction needs an apostrophe."),
        ("theyre", "they're", "Apostrophe", "This contraction needs an apostrophe."),
        ("youre", "you're", "Apostrophe", "This contraction needs an apostrophe."),
        ("weve", "we've", "Apostrophe", "This contraction needs an apostrophe."),
        ("theyve", "they've", "Apostrophe", "This contraction needs an apostrophe."),
        ("definately", "definitely", "Spelling", "This word is commonly misspelled."),
        ("seperate", "separate", "Spelling", "This word is commonly misspelled."),
        ("seperated", "separated", "Spelling", "This word is commonly misspelled."),
        ("recieve", "receive", "Spelling", "This word is commonly misspelled."),
        ("occured", "occurred", "Spelling", "This word is commonly misspelled."),
        ("untill", "until", "Spelling", "This word is commonly misspelled."),
        ("wich", "which", "Spelling", "This word is commonly misspelled."),
        ("thier", "their", "Spelling", "This word is commonly misspelled."),
        ("wierd", "weird", "Spelling", "This word is commonly misspelled."),
        ("becuase", "because", "Spelling", "This word is commonly misspelled."),
        ("lett", "let", "Spelling", "This word is commonly misspelled."),
    ];
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    let mut word = String::new();
    let mut inspect = |word: &str| {
        if word.is_empty() || issues.len() >= 12 { return; }
        let normalized = word.to_lowercase();
        let correction = if normalized == "i" { Some(("I", "Capitalization", "The English first-person pronoun is capitalized.")) } else {
            CORRECTIONS.iter().find(|(original, _, _, _)| *original == normalized).map(|(_, replacement, category, reason)| (*replacement, *category, *reason))
        };
        if let Some((replacement, category, reason)) = correction {
            let replacement = if word.chars().all(|character| !character.is_alphabetic() || character.is_uppercase()) { replacement.to_uppercase() } else if word.chars().next().is_some_and(|character| character.is_uppercase()) {
                let mut characters = replacement.chars();
                characters.next().map(|character| character.to_uppercase().collect::<String>() + characters.as_str()).unwrap_or_else(|| replacement.to_string())
            } else { replacement.to_string() };
            let key = format!("{}\u{0}{}", word.to_lowercase(), replacement.to_lowercase());
            if seen.insert(key) { issues.push(serde_json::json!({ "kind": "mechanic", "original": word, "replacement": replacement, "reason": reason, "category": category, "alternatives": [] })); }
        }
    };
    for character in source.chars() {
        if character.is_alphabetic() { word.push(character); } else { inspect(&word); word.clear(); }
    }
    inspect(&word);
    drop(inspect);

    // Agreement and comparison errors are also safe to catch without waiting
    // for the local model. Keep the original two-word phrase so the editor
    // marks the right occurrence rather than the first matching verb on a page.
    let words = source
        .split_whitespace()
        .map(|token| token.trim_matches(|character: char| !character.is_alphabetic() && character != '\''))
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    let mut add_context_issue = |original: String, replacement: String, category: &str, reason: &str| {
        if issues.len() >= 12 { return; }
        let key = format!("{}\u{0}{}", original.to_lowercase(), replacement.to_lowercase());
        if seen.insert(key) {
            issues.push(serde_json::json!({ "kind": "mechanic", "original": original, "replacement": replacement, "reason": reason, "category": category, "alternatives": [] }));
        }
    };
    for pair in words.windows(2) {
        let subject = pair[0];
        let verb = pair[1];
        let normalized_subject = subject.to_lowercase();
        let normalized_verb = verb.to_lowercase();
        if normalized_verb == "was" && (matches!(normalized_subject.as_str(), "they" | "we" | "you") || likely_plural_subject(&normalized_subject)) {
            add_context_issue(
                format!("{subject} {verb}"),
                format!("{subject} were"),
                "Subject–verb agreement",
                "A plural subject takes “were,” not “was.”",
            );
        } else if normalized_verb == "has" && (matches!(normalized_subject.as_str(), "they" | "we" | "you") || likely_plural_subject(&normalized_subject)) {
            add_context_issue(
                format!("{subject} {verb}"),
                format!("{subject} have"),
                "Subject–verb agreement",
                "A plural subject takes “have,” not “has.”",
            );
        } else if normalized_subject == "more" && (normalized_verb == "better" || normalized_verb == "worse" || normalized_verb.ends_with("er")) {
            add_context_issue(
                format!("{subject} {verb}"),
                verb.to_string(),
                "Comparative form",
                "Use one comparative form instead of “more” plus a comparative adjective.",
            );
        }
    }
    issues
}

fn likely_plural_subject(word: &str) -> bool {
    if matches!(word, "people" | "children" | "men" | "women" | "police" | "cattle") {
        return true;
    }
    word.len() > 3
        && (word.ends_with("ies") || word.ends_with('s'))
        && !word.ends_with("ss")
        && !word.ends_with("us")
        && !word.ends_with("is")
        && !word.ends_with("ics")
        && !matches!(word, "this" | "news" | "series" | "means")
}

fn review_grammar_text_blocking(
    app: tauri::AppHandle,
    model_path: String,
    text: String,
    quick: bool,
    paper_context: String,
) -> CommandResult<String> {
    // The editor sends exactly the complete US-Letter page currently in view.
    // Do not trim it here: reviewing page three must never silently become a
    // review of the beginning of the document.
    let source = text.trim().to_string();
    if source.trim().len() < 3 {
        return Ok("[]".into());
    }
    let paper_context = normalized_paper_context(&paper_context);
    emit_ai_progress(&app, 12, "Reading your writing");
    let general_model_path = resolve_ai_model_path(&app, &model_path)?;
    let server_port = ensure_ai_server(&general_model_path, &app)?;
    emit_ai_progress(&app, 45, "Checking spelling and grammar");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(if quick { 24 } else { 70 }))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    // The deterministic mechanics pass belongs in both modes. A manual review
    // is deeper, but it must not drop clear grammar warnings just because the
    // generative model chooses to focus on style.
    let mut suggestions = quick_mechanics_prepass(&source);
    let mut model_suggestion_count = 0usize;
    if quick {
        let system = "You are SoFlo's fast, context-aware English mechanics checker. The supplied text is one complete page currently visible to the writer. Proofread that entire page from its first sentence through its final sentence before responding. Return only one complete valid JSON array: no Markdown, code fences, or commentary. Return up to 12 clear errors. Find misspellings, capitalization, apostrophes, duplicated spaces, repeated words, obvious punctuation, unambiguous wrong-word or homophone mistakes, and clear subject-verb agreement errors. Every object must have exactly these six keys: kind, original, replacement, reason, category, alternatives. kind must be mechanic. Copy original exactly from the input and make replacement the smallest correction. alternatives must be an empty JSON array. Use surrounding meaning and the document context to judge punctuation. Do not report style, proper names, or text that is already correct. Return [] only after checking the whole page and finding no clear mechanics errors.";
        let request = format!("DOCUMENT GOAL AND VOICE:\n{}\n\nProofread this complete visible page. Return JSON only.\n\n{}", paper_context, source);
        let output = local_chat_text(&client, server_port, system, &request, 1_150)?;
        if let Some(array) = json_array_from_response(&output) {
            if let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(&array) {
                suggestions.extend(items.into_iter().take(12));
            }
        }
    } else {
        emit_ai_progress(&app, 45, "Auditing grammar across this page");
        let mechanics_system = "You are SoFlo's rigorous copy editor. The supplied text is one complete page currently visible to the writer. Inspect every sentence, including the middle and end of the page. Return only one complete valid JSON array: no Markdown, code fences, or commentary. Find 8 to 12 distinct, unambiguous mechanics improvements when the page has that many; return fewer only when the writing is genuinely clean. Check spelling, capitalization, apostrophes, agreement, tense consistency, homophones, word forms, hyphenation, repeated words, duplicated spaces, comma use, sentence boundaries, fragments, run-ons, and contextually correct punctuation. Every object must use ONLY these five keys: kind, original, replacement, reason, alternatives. kind must be mechanic. original must be copied exactly from the input. replacement must be the smallest exact correction, usually 1 to 6 words. reason must explain the specific grammar rule or contextual error. alternatives must be an empty JSON array. Never invent facts, change citations, flag proper names merely for being unfamiliar, or report text that is already correct.";
        let mechanics_prompt = format!("DOCUMENT GOAL AND VOICE:\n{}\n\nAudit this complete visible page for mechanics. Return JSON only.\n\n{}", paper_context, source);
        let mechanics_output = local_chat_text(&client, server_port, mechanics_system, &mechanics_prompt, 1_650)?;
        if let Some(array) = json_array_from_response(&mechanics_output) {
            if let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(&array) {
                let accepted = items.into_iter().take(12).collect::<Vec<_>>();
                model_suggestion_count += accepted.len();
                suggestions.extend(accepted);
            }
        }

        emit_ai_progress(&app, 67, "Finding stronger writing choices");
        let style_system = "You are SoFlo's senior college-writing editor. The supplied text is one complete page currently visible to the writer. Read the entire page before responding, then return only one complete valid JSON array: no Markdown, code fences, or commentary. Find 6 to 10 concrete, meaningful writing improvements when the page has that many. Focus on vague or conversational language, weak verbs, repetitive sentence starters, imprecise claims, choppy transitions, redundant phrasing, weak topic or closing phrases, unclear logic, and opportunities for a more formal, precise voice that still matches the stated document goal. Every object must use ONLY these five keys: kind, original, replacement, reason, alternatives. kind must be style. original must be copied exactly from the input. replacement must preserve the writer's meaning. For each suggestion, target a focused 1 to 9 word phrase; never rewrite a whole sentence. reason must explain specifically why the replacement is clearer, more formal, more precise, or improves flow. alternatives must contain zero to two short optional replacements. Do not invent facts, alter quotations or citations, make empty thesaurus substitutions, or praise text instead of offering a real improvement.";
        let style_prompt = format!("DOCUMENT GOAL AND VOICE:\n{}\n\nReview this complete visible page for focused writing improvements. Return JSON only.\n\n{}", paper_context, source);
        let style_output = local_chat_text(&client, server_port, style_system, &style_prompt, 1_700)?;
        if let Some(array) = json_array_from_response(&style_output) {
            if let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(&array) {
                let accepted = items.into_iter().take(10).collect::<Vec<_>>();
                model_suggestion_count += accepted.len();
                suggestions.extend(accepted);
            }
        }
    }
    // Local models can occasionally stop after only a couple broad comments.
    // A deliberate AI Review earns a second focused mechanics audit in that case.
    if !quick && model_suggestion_count < 8 {
        emit_ai_progress(&app, 78, "Double-checking grammar and punctuation");
        let audit_prompt = format!(
            "DOCUMENT GOAL AND VOICE:\n{}\n\nReview this same paper again. Find 6 to 8 additional, distinct grammar or punctuation issues. Return JSON only.\n\n{}",
            paper_context,
            source
        );
        let audit_system = "You are the second-pass grammar quality check for a college paper. Return only a valid JSON array with exactly these five keys per object: kind, original, replacement, reason, alternatives. kind must be mechanic. Find clear, specific grammar, spelling, agreement, capitalization, apostrophe, homophone, or punctuation problems that a first pass may have missed. Copy original exactly from the paper. Keep each correction focused on 1 to 6 words. Do not return style-only advice, commentary, Markdown, or an empty array when clear mechanics errors exist.";
        let audit_output = local_chat_text(&client, server_port, audit_system, &audit_prompt, 1_300)?;
        if let Some(array) = json_array_from_response(&audit_output) {
            if let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(&array) {
                suggestions.extend(items.into_iter().take(8));
            }
        }
    }
    touch_ai_server();
    emit_ai_progress(&app, 90, "Preparing suggestions");
    let output = serde_json::to_string(&suggestions).unwrap_or_else(|_| "[]".into());
    emit_ai_progress(&app, 100, "Grammar review ready");
    Ok(output)
}

#[tauri::command]
pub async fn research_and_grade_text(
    app: tauri::AppHandle,
    model_path: String,
    text: String,
    paper_context: String,
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        research_and_grade_text_blocking(app, model_path, text, paper_context)
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

fn local_chat_text(
    client: &reqwest::blocking::Client,
    port: u16,
    system: &str,
    prompt: &str,
    max_tokens: u16,
) -> CommandResult<String> {
    let response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", port))
        .json(&serde_json::json!({
            "messages": [{"role":"system","content":system},{"role":"user","content":prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.1,
            "stream": false
        }))
        .send()
        .map_err(|error| format!("SoFlo's local AI model did not respond: {}", error))?
        .error_for_status()
        .map_err(|error| {
            format!(
                "SoFlo's local AI model could not complete this review: {}",
                error
            )
        })?;
    let body: serde_json::Value = response
        .json()
        .map_err(|_| "SoFlo could not read the local AI response.".to_string())?;
    Ok(body
        .get("choices")
        .and_then(|value| value.get(0))
        .and_then(|value| value.get("message"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string())
}

fn normalized_paper_context(context: &str) -> String {
    let value = context
        .split_whitespace()
        .take(180)
        .collect::<Vec<_>>()
        .join(" ");
    if value.is_empty() {
        "A college-level formal paper using precise, polished, sophisticated language and standard academic grammar.".into()
    } else {
        value
    }
}

fn fallback_research_query(text: &str) -> String {
    text.split_whitespace()
        .map(|word| word.trim_matches(|character: char| !character.is_alphanumeric()))
        .filter(|word| word.chars().count() >= 4)
        .take(12)
        .collect::<Vec<_>>()
        .join(" ")
}

fn academic_research_leads(query: &str, perspective: &str) -> Vec<serde_json::Value> {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(18))
        .user_agent("SoFlo/1.0 (local academic research helper)")
        .build()
    {
        Ok(client) => client,
        Err(_) => return Vec::new(),
    };
    let response = match client
        .get("https://api.crossref.org/works")
        .query(&[("query.bibliographic", query), ("rows", "8")])
        .send()
        .and_then(|response| response.error_for_status())
    {
        Ok(response) => response,
        Err(_) => return Vec::new(),
    };
    let payload: serde_json::Value = match response.json() {
        Ok(payload) => payload,
        Err(_) => return Vec::new(),
    };
    payload
        .pointer("/message/items")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let source_type = item.get("type").and_then(|value| value.as_str()).unwrap_or_default();
            if !matches!(source_type, "journal-article" | "proceedings-article" | "book-chapter" | "reference-book") {
                return None;
            }
            let title = item.get("title").and_then(|value| value.as_array()).and_then(|titles| titles.first()).and_then(|value| value.as_str())?.trim();
            let doi = item.get("DOI").and_then(|value| value.as_str())?.trim();
            if title.is_empty() || doi.is_empty() {
                return None;
            }
            let publication = item.get("container-title").and_then(|value| value.as_array()).and_then(|titles| titles.first()).and_then(|value| value.as_str()).unwrap_or_default().trim();
            let year = item.pointer("/published-print/date-parts/0/0")
                .or_else(|| item.pointer("/published-online/date-parts/0/0"))
                .and_then(|value| value.as_i64())
                .map(|value| value.to_string())
                .unwrap_or_default();
            Some(serde_json::json!({
                "title": title,
                "publication": publication,
                "year": year,
                "type": source_type,
                "perspective": perspective,
                "citations": item.get("is-referenced-by-count").and_then(|value| value.as_i64()).unwrap_or(0),
                "url": format!("https://doi.org/{}", doi),
            }))
        })
        .take(5)
        .collect()
}

fn research_and_grade_text_blocking(
    app: tauri::AppHandle,
    model_path: String,
    text: String,
    paper_context: String,
) -> CommandResult<String> {
    let source = text.chars().take(18_000).collect::<String>();
    if source.trim().chars().count() < 80 {
        return Err(
            "Write a little more before asking SoFlo to research and grade this paper.".into(),
        );
    }
    let paper_context = normalized_paper_context(&paper_context);
    let model_path = resolve_ai_model_path(&app, &model_path)?;
    emit_ai_progress(&app, 8, "Reading your paper locally");
    let ai_port = ensure_ai_server(&model_path, &app)?;
    let local_client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    emit_ai_progress(&app, 25, "Identifying a focused research topic");
    let query_output = local_chat_text(
        &local_client,
        ai_port,
        "You turn a student's paper into concise academic database searches. Return only a JSON object with topicQuery and counterQuery. Each query must be 5 to 14 keywords. topicQuery should preserve the paper's topic and central claim. counterQuery should seek a relevant alternate perspective, limitation, or counterargument; if the paper is not making an argument, use a complementary scholarly perspective instead. Do not include personal names unless essential.",
        &format!("DOCUMENT GOAL AND VOICE:\n{}\n\nCreate two research queries for this paper:\n\n{}", paper_context, source.chars().take(7_000).collect::<String>()),
        120,
    )?;
    let query_object = json_object_from_response(&query_output)
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
    let research_query = query_object
        .as_ref()
        .and_then(|value| value.get("topicQuery").or_else(|| value.get("query")))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| fallback_research_query(&source));
    let counter_query = query_object
        .as_ref()
        .and_then(|value| value.get("counterQuery"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|query| !query.is_empty() && *query != research_query)
        .map(str::to_string);
    if research_query.is_empty() {
        return Err("SoFlo could not identify a topic to research from this paper.".into());
    }
    emit_ai_progress(&app, 45, "Checking scholarly research leads online");
    let mut sources = academic_research_leads(&research_query, "Related scholarship");
    if let Some(query) = counter_query.as_deref() {
        sources.extend(academic_research_leads(query, "Alternate perspective"));
    }
    sources.sort_by(|left, right| {
        left.get("url")
            .and_then(|value| value.as_str())
            .cmp(&right.get("url").and_then(|value| value.as_str()))
    });
    sources.dedup_by(|left, right| {
        left.get("url").and_then(|value| value.as_str())
            == right.get("url").and_then(|value| value.as_str())
    });
    sources.truncate(6);
    for source in &mut sources {
        let perspective = source
            .get("perspective")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let publication = source
            .get("publication")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if !perspective.is_empty() {
            let label = if publication.is_empty() {
                perspective.to_string()
            } else {
                format!("{} - {}", perspective, publication)
            };
            if let Some(object) = source.as_object_mut() {
                object.insert("publication".into(), serde_json::Value::String(label));
            }
        }
    }
    emit_ai_progress(&app, 64, "Comparing evidence and reasoning");
    let source_context = if sources.is_empty() {
        "No scholarly metadata was returned. Grade the paper without outside leads and explain what evidence would strengthen it.".to_string()
    } else {
        sources
            .iter()
            .enumerate()
            .map(|(index, source)| {
                format!(
                    "{}. {} — {} ({})",
                    index + 1,
                    source
                        .get("title")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default(),
                    source
                        .get("publication")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default(),
                    source
                        .get("year")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let grade_output = local_chat_text(
        &local_client,
        ai_port,
        "You are a constructive writing instructor. Grade a student's document approximately, not officially, against its stated goal and voice. Use the supplied scholarly research leads only as leads: never claim a source proves something unless its metadata makes that clear. Return only a JSON object with keys grade, overview, strengths, improvements, evidence, reasoning, writingCraft, and researchAdvice. strengths, improvements, and researchAdvice must be arrays of 2 to 5 short strings. writingCraft must be an object with sentenceOpeners, topicSentences, organization, creativity, and length; each is a concise sentence. Clearly discuss the document's purpose, evidence where applicable, reasoning, context-appropriate punctuation and grammar, counterarguments or missing perspectives where relevant, and practical ways to improve it. Do not force academic conventions when they conflict with the stated goal. Do not write the document for the student.",
        &format!("DOCUMENT GOAL AND VOICE:\n{}\n\nPAPER:\n{}\n\nSCHOLARLY RESEARCH LEADS (metadata only):\n{}", paper_context, source, source_context),
        1800,
    )?;
    touch_ai_server();
    emit_ai_progress(&app, 91, "Preparing your research and grade report");
    let mut report = json_object_from_response(&grade_output)
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({
            "grade": "—",
            "overview": grade_output,
            "strengths": [],
            "improvements": [],
            "evidence": "The local model returned an unstructured review. Use the research leads below to strengthen your evidence.",
            "reasoning": "Review the paper's claim and support before treating this as a final grade.",
            "writingCraft": {},
            "researchAdvice": []
        }));
    if let Some(object) = report.as_object_mut() {
        object.insert(
            "researchQuery".into(),
            serde_json::Value::String(research_query),
        );
        object.insert("sources".into(), serde_json::Value::Array(sources));
        object.insert("sourceNote".into(), serde_json::Value::String("Research leads come from Crossref metadata, including related and alternate-perspective searches. Open each DOI and evaluate the full source before citing it.".into()));
    }
    emit_ai_progress(&app, 100, "Research and grade report ready");
    Ok(report.to_string())
}

#[tauri::command]
pub async fn define_word(
    app: tauri::AppHandle,
    model_path: String,
    word: String,
    paper_context: String,
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        define_word_blocking(app, model_path, word, paper_context)
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

fn define_word_blocking(
    app: tauri::AppHandle,
    model_path: String,
    word: String,
    paper_context: String,
) -> CommandResult<String> {
    let word = word.trim();
    if word.is_empty() || word.chars().count() > 80 {
        return Err("Select one ordinary word to look it up.".into());
    }
    let paper_context = normalized_paper_context(&paper_context);
    let general_model_path = resolve_ai_model_path(&app, &model_path)?;
    let word_ai_port = ensure_ai_server(&general_model_path, &app)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    let response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", word_ai_port))
        .json(&serde_json::json!({
            "messages": [
                {"role":"system","content":"You are a concise, reliable English dictionary for a writing app. Return only one complete valid JSON object with keys word, pronunciation, senses, and synonyms. senses must be an array of one to three objects, each with string keys partOfSpeech, definition, and example. Give distinct common meanings, numbered by array order, with clear precise definitions and a short natural example where useful. synonyms must be an array of 5 to 10 single-word or hyphenated precise related alternatives suited to the stated document goal; do not include the queried word itself, duplicate words, or phrases. Do not use Markdown, commentary, or code fences."},
                {"role":"user","content":format!("DOCUMENT GOAL AND VOICE:\n{}\n\nDefine this one word: {}", paper_context, word)}
            ],
            "max_tokens": 900,
            "temperature": 0.1,
            "stream": false
        }))
        .send()
        .map_err(|error| format!("SoFlo's local AI model did not respond: {}", error))?
        .error_for_status()
        .map_err(|error| format!("SoFlo's local AI model could not look up that word: {}", error))?;
    let body: serde_json::Value = response
        .json()
        .map_err(|_| "SoFlo could not read the local AI response.".to_string())?;
    let output = body
        .get("choices")
        .and_then(|value| value.get(0))
        .and_then(|value| value.get("message"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    touch_ai_server();
    json_object_from_response(output)
        .ok_or_else(|| "SoFlo could not prepare a word reference.".into())
}

#[tauri::command]
pub async fn ai_thesaurus(
    app: tauri::AppHandle,
    model_path: String,
    word: String,
    paper_context: String,
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        ai_thesaurus_blocking(app, model_path, word, paper_context)
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

fn ai_thesaurus_blocking(
    app: tauri::AppHandle,
    model_path: String,
    word: String,
    paper_context: String,
) -> CommandResult<String> {
    let query = word.trim();
    if query.is_empty() || query.chars().count() > 120 {
        return Err("Enter a word or short phrase to explore.".into());
    }
    let paper_context = normalized_paper_context(&paper_context);
    let general_model_path = resolve_ai_model_path(&app, &model_path)?;
    let word_ai_port = ensure_ai_server(&general_model_path, &app)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    let request = |instruction: &str, max_tokens: u16| -> CommandResult<String> {
        let response = client
            .post(format!(
                "http://127.0.0.1:{}/v1/chat/completions",
                word_ai_port
            ))
            .json(&serde_json::json!({
                "messages": [
                    {"role":"system","content":instruction},
                    {"role":"user","content":format!("DOCUMENT GOAL AND VOICE:\n{}\n\nFind grouped alternatives for: {}", paper_context, query)}
                ],
                "max_tokens": max_tokens,
                "temperature": 0.1,
                "stream": false
            }))
            .send()
            .map_err(|error| format!("SoFlo's local AI model did not respond: {}", error))?
            .error_for_status()
            .map_err(|error| {
                format!(
                    "SoFlo's local AI model could not find related words: {}",
                    error
                )
            })?;
        let body: serde_json::Value = response
            .json()
            .map_err(|_| "SoFlo could not read the local AI response.".to_string())?;
        Ok(body
            .get("choices")
            .and_then(|value| value.get(0))
            .and_then(|value| value.get("message"))
            .and_then(|value| value.get("content"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string())
    };
    let instruction = "You are a precise English thesaurus for college writing. Return only one complete valid JSON object with exactly these keys: query, close, related, broad. Each value must be an array of 3 to 6 concise alternatives. close means nearly interchangeable in the same context; related means useful formal or academic alternatives with a slightly different shade; broad means more distant but relevant words or phrases. Preserve the part of speech and meaning of the query. Use single words or short phrases, never definitions, commentary, Markdown, duplicates, or the queried term itself. Do not invent unusual words.";
    let output = request(instruction, 700)?;
    touch_ai_server();
    if let Some(object) = thesaurus_json_from_response(&output, query) {
        return Ok(object);
    }
    let retry = request("Return only valid compact JSON in this exact shape: {\"query\":\"input\",\"close\":[\"word\"],\"related\":[\"word\"],\"broad\":[\"word\"]}. Replace input and each word with useful alternatives. No Markdown, explanation, or extra keys.", 1100)?;
    if let Some(object) = thesaurus_json_from_response(&retry, query) {
        return Ok(object);
    }
    let final_retry = request("Give thesaurus alternatives as three plain lines only. Use exactly: CLOSE: word, word, word; RELATED: word, word, word; BROAD: word, word, word. No definitions or commentary.", 700)?;
    thesaurus_json_from_response(&final_retry, query)
        .ok_or_else(|| "SoFlo could not prepare grouped thesaurus suggestions.".into())
}

fn thesaurus_json_from_response(output: &str, query: &str) -> Option<String> {
    let unique_words = |values: Vec<String>| {
        let mut result = Vec::<String>::new();
        for value in values {
            let word = value
                .trim()
                .trim_matches(|character: char| {
                    matches!(
                        character,
                        '"' | '\'' | '`' | '[' | ']' | '(' | ')' | '.' | ':'
                    )
                })
                .trim()
                .to_string();
            if word.is_empty()
                || word.eq_ignore_ascii_case(query)
                || word.split_whitespace().count() > 5
                || result
                    .iter()
                    .any(|existing| existing.eq_ignore_ascii_case(&word))
            {
                continue;
            }
            result.push(word);
            if result.len() == 6 {
                break;
            }
        }
        result
    };
    if let Some(object) = json_object_from_response(output) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&object) {
            let list = |keys: &[&str]| -> Vec<String> {
                keys.iter()
                    .find_map(|key| value.get(*key).and_then(|entry| entry.as_array()))
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| item.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let close = unique_words(list(&["close", "closest", "synonyms"]));
            let related = unique_words(list(&["related", "formal", "academic"]));
            let broad = unique_words(list(&["broad", "broader", "distant"]));
            if !close.is_empty() || !related.is_empty() || !broad.is_empty() {
                return serde_json::to_string(&serde_json::json!({ "query": query, "close": close, "related": related, "broad": broad })).ok();
            }
        }
    }
    let mut close = Vec::new();
    let mut related = Vec::new();
    let mut broad = Vec::new();
    let mut unlabeled = Vec::new();
    let mut current = "";
    for raw_line in output.lines() {
        let mut line = raw_line.trim().trim_matches('`').trim();
        let lower = line.to_ascii_lowercase();
        if lower.contains("close") || lower.contains("closest") {
            current = "close";
        } else if lower.contains("related")
            || lower.contains("formal")
            || lower.contains("academic")
        {
            current = "related";
        } else if lower.contains("broad") || lower.contains("distant") {
            current = "broad";
        }
        if let Some((label, rest)) = line.split_once(':') {
            let label = label.to_ascii_lowercase();
            if label.contains("close") {
                current = "close";
                line = rest;
            } else if label.contains("related") || label.contains("formal") {
                current = "related";
                line = rest;
            } else if label.contains("broad") {
                current = "broad";
                line = rest;
            }
        }
        let values = line
            .split([',', ';', '|'])
            .map(|item| {
                item.trim_start_matches(|character: char| {
                    character.is_ascii_digit() || matches!(character, '-' | '*' | '.' | ')' | ' ')
                })
                .to_string()
            })
            .filter(|item| !item.trim().is_empty())
            .collect::<Vec<_>>();
        match current {
            "close" => close.extend(values),
            "related" => related.extend(values),
            "broad" => broad.extend(values),
            _ => {
                let trimmed = raw_line.trim_start();
                let looks_like_list = trimmed.starts_with(['-', '*'])
                    || trimmed
                        .chars()
                        .next()
                        .is_some_and(|character| character.is_ascii_digit())
                    || raw_line.contains([',', ';', '|']);
                if looks_like_list
                    && !lower.contains("suggestion")
                    && !lower.contains("alternative")
                {
                    unlabeled.extend(values);
                }
            }
        }
    }
    let mut close = unique_words(close);
    let mut related = unique_words(related);
    let mut broad = unique_words(broad);
    if close.is_empty() && related.is_empty() && broad.is_empty() {
        for (index, word) in unique_words(unlabeled).into_iter().enumerate() {
            match index % 3 {
                0 => close.push(word),
                1 => related.push(word),
                _ => broad.push(word),
            }
        }
    }
    if close.is_empty() && related.is_empty() && broad.is_empty() {
        return None;
    }
    serde_json::to_string(
        &serde_json::json!({ "query": query, "close": close, "related": related, "broad": broad }),
    )
    .ok()
}

fn generate_flashcards_text_blocking(
    app: tauri::AppHandle,
    model_path: String,
    materials: String,
    guidance: String,
    syllabus_context: String,
) -> CommandResult<String> {
    let model_path = resolve_ai_model_path(&app, &model_path)?;
    emit_ai_progress(&app, 6, "Starting your private local model");
    let mut ai_port = ensure_flashcard_ai_server(&model_path, &app)?;
    emit_ai_progress(&app, 42, "Reading your study materials");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    // A long math PDF is much more token-dense than its character count makes
    // it look. Ask for small, complete JSON batches instead of one 100-card
    // answer that can reach finish_reason=length halfway through an array.
    let source = materials
        .chars()
        .take(FLASHCARD_TOTAL_SOURCE_CHARS)
        .collect::<String>();
    let syllabus = syllabus_context.chars().take(1_500).collect::<String>();
    if source.trim().is_empty() {
        return Err(
            "Add a topic, pasted study text, or an uploaded document before creating flashcards."
                .into(),
        );
    }
    let source_kind = if materials.contains("UPLOADED MATERIAL") {
        "source-material"
    } else if materials.trim_start().starts_with("TOPIC OR PROMPT:") {
        "topic"
    } else if materials.trim_start().starts_with("TEXT OR TOPIC:") {
        "text-or-topic"
    } else {
        "source-material"
    };
    eprintln!(
        "[SoFlo AI] flashcard generation source={} characters={}",
        source_kind,
        source.chars().count()
    );
    let request_instruction = if source_kind == "topic" {
        "No source document was supplied. Use your general academic knowledge to make accurate flashcards directly about this topic or instruction."
    } else if source_kind == "text-or-topic" {
        "No source document was supplied. The input may be pasted study text or a study topic. Use details in the input whenever they are present; when it is a topic request, use accurate general academic knowledge."
    } else {
        "Use the supplied source material as the primary factual basis for the flashcards."
    };
    let math_mode = looks_like_math_material(&source);
    let system = flashcard_system_instruction(math_mode);
    let chunks = split_source_for_ai(&source, FLASHCARD_SOURCE_CHUNK_CHARS);
    let total_chunks = chunks.len().max(1);
    let card_budget = 100;
    let mut cards = Vec::<serde_json::Value>::new();
    let mut seen = HashSet::<String>::new();
    let mut cpu_retry_used = false;
    for (index, chunk) in chunks.iter().enumerate() {
        if cards.len() >= card_budget {
            break;
        }
        let progress = 42u8.saturating_add(((index * 40 / total_chunks) as u8).min(40));
        emit_ai_progress(
            &app,
            progress,
            &format!("Making flashcards from section {} of {}", index + 1, total_chunks),
        );
        let card_limit = FLASHCARD_BATCH_CARD_LIMIT.min(card_budget - cards.len());
        let prompt = flashcard_generation_prompt(
            request_instruction,
            &guidance,
            chunk,
            &syllabus,
            card_limit,
        );
        let batch = match flashcard_batch_completion(&client, ai_port, system, &prompt, card_limit) {
            Ok(batch) => batch,
            Err(error) if !cpu_retry_used && should_retry_flashcard_batch_on_cpu(&error) => {
                // A GPU can pass the startup probe yet fail on a larger real
                // request. Retry that one section once on CPU. Invalid JSON
                // and client-side request errors stay on the current server;
                // changing hardware cannot repair either of those.
                eprintln!("[SoFlo AI] flashcard GPU batch failed: {error}");
                emit_ai_progress(&app, 68, "Trying a compatible local AI mode");
                stop_model_server(&AI_SERVER);
                ai_port = ensure_flashcard_cpu_ai_server(&model_path, &app)?;
                cpu_retry_used = true;
                match flashcard_batch_completion(&client, ai_port, system, &prompt, card_limit) {
                    Ok(batch) => batch,
                    Err(cpu_error) => {
                        eprintln!("[SoFlo AI] flashcard CPU batch failed: {cpu_error}");
                        continue;
                    }
                }
            }
            Err(error) => {
                eprintln!("[SoFlo AI] skipped incomplete flashcard section {}: {error}", index + 1);
                continue;
            }
        };
        for card in batch {
            if cards.len() >= card_budget {
                break;
            }
            let key = flashcard_card_key(&card);
            if seen.insert(key) {
                cards.push(card);
            }
        }
    }
    emit_ai_progress(&app, 86, "Checking the generated flashcards");
    touch_ai_server();
    if cards.is_empty() {
        return Err("SoFlo could not make a complete flashcard batch from this document. The local model was tried in its compatible modes; try the file again after reopening SoFlo.".into());
    }
    emit_ai_progress(&app, 100, "Finishing your flashcard set");
    serde_json::to_string(&cards).map_err(|_| "SoFlo could not save the generated flashcards.".into())
}

fn flashcard_generation_prompt(
    request_instruction: &str,
    guidance: &str,
    source: &str,
    syllabus: &str,
    card_limit: usize,
) -> String {
    let syllabus_section = if syllabus.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nCLASS SYLLABUS (supporting context only; use it to align scope and terminology, never invent answers or turn schedules and policies into cards unless the study material asks for them):\n{syllabus}")
    };
    format!("{request_instruction} This is one section of a larger document. Create at most {card_limit} complete, non-duplicate flashcards from this section only. Other sections are handled separately, so do not try to cover the entire document in one answer. Extra study guidance: {guidance}\n\nINPUT:\n{source}{syllabus_section}")
}

fn flashcard_batch_completion(
    client: &reqwest::blocking::Client,
    port: u16,
    system: &str,
    prompt: &str,
    card_limit: usize,
) -> CommandResult<Vec<serde_json::Value>> {
    let max_tokens = if card_limit <= FLASHCARD_BATCH_CARD_LIMIT {
        FLASHCARD_BATCH_MAX_TOKENS
    } else {
        2_200
    };
    let output = flashcard_completion(client, port, system, prompt, max_tokens)?;
    let cards = flashcard_cards_from_response(&output);
    if cards.is_empty() {
        return Err("the local model returned incomplete flashcard JSON".into());
    }
    Ok(cards.into_iter().take(card_limit).collect())
}

fn flashcard_cards_from_response(output: &str) -> Vec<serde_json::Value> {
    let Some(array) = json_array_from_response(output) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<serde_json::Value>>(&array)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|card| {
            let front = card.get("front")?.as_str()?.trim();
            let back = card.get("back")?.as_str()?.trim();
            (!front.is_empty() && !back.is_empty()).then(|| {
                serde_json::json!({ "front": front, "back": back })
            })
        })
        .collect()
}

fn flashcard_card_key(card: &serde_json::Value) -> String {
    ["front", "back"]
        .iter()
        .filter_map(|field| card.get(*field).and_then(|value| value.as_str()))
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("\u{0}")
}

fn should_retry_flashcard_batch_on_cpu(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("did not respond")
        || error.contains("connection")
        || error.contains("could not read the local ai response")
        || error.contains("http 5")
}

fn flashcard_completion(
    client: &reqwest::blocking::Client,
    port: u16,
    system: &str,
    prompt: &str,
    max_tokens: u16,
) -> CommandResult<String> {
    let payload = serde_json::json!({
        "messages": [
            {"role":"system","content": system},
            {"role":"user","content": prompt}
        ],
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "stream": false
    });
    let response = client
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&payload)
        .send()
        .map_err(|error| format!("SoFlo's local AI model did not respond: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|_| "SoFlo could not read the local AI response.".to_string())?;
    if !status.is_success() {
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.get("error").cloned().or_else(|| value.get("message").cloned()))
            .and_then(|value| value.get("message").cloned().or(Some(value)))
            .map(|value| value.as_str().map(str::to_owned).unwrap_or_else(|| value.to_string()))
            .unwrap_or(body)
            .split_whitespace()
            .take(30)
            .collect::<Vec<_>>()
            .join(" ");
        let mut detail = detail.chars().take(320).collect::<String>();
        if detail.is_empty() {
            detail = "no error details were returned".into();
        }
        return Err(format!("local model returned HTTP {status}: {detail}"));
    }
    let body: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "SoFlo could not read the local AI response.".to_string())?;
    let choice = body
        .get("choices")
        .and_then(|value| value.get(0));
    let content = choice
        .and_then(|value| value.get("message"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if content.is_empty() {
        let finish_reason = choice
            .and_then(|value| value.get("finish_reason"))
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let used_reasoning = choice
            .and_then(|value| value.get("message"))
            .and_then(|value| value.get("reasoning_content"))
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.trim().is_empty());
        return Err(format!(
            "local model returned no usable content (finish reason: {finish_reason}; reasoning output: {used_reasoning})"
        ));
    }
    Ok(content)
}

fn looks_like_math_material(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    let keyword_match = [
        "equation", "inequality", "solve", "simplify", "evaluate", "factor", "quadratic",
        "derivative", "integral", "function", "matrix", "polynomial", "logarithm", "geometry",
        "trigonometry", "probability", "calculus", "algebra", "slope", "graph",
    ]
    .iter()
    .any(|keyword| lower.contains(keyword));
    let symbol_count = source
        .chars()
        .filter(|character| matches!(character, '=' | '+' | '-' | '*' | '/' | '^' | '√' | '∫' | '∑' | 'π' | '≤' | '≥' | '≠' | '×' | '÷'))
        .count();
    let digit_count = source.chars().filter(|character| character.is_ascii_digit()).count();
    keyword_match || (symbol_count >= 4 && digit_count >= 2)
}

fn flashcard_system_instruction(math_mode: bool) -> &'static str {
    if math_mode {
        "You create concise college math flashcards. Return only one complete valid JSON array of objects with non-empty string fields front and back. The user request gives the maximum number of cards; never exceed it, pad it, or begin another array. Preserve each supplied problem's variables, values, signs, exponents, units, and answer exactly. Make problem-first cards: the front is one specific question or expression, and the back begins with its direct answer followed by one to four concise work steps only when the source provides or clearly supports them. When an answer key gives only an answer, do not invent work. Keep equations readable with plain Unicode notation such as x², √, π, ≤, ≥, ≠, →, ×, ÷, and a/b. Never use Markdown, LaTex delimiters, code fences, or commentary. Do not collapse many distinct practice questions into one generic rule card. Include useful concept and rule cards too, but retain the individual practice problems and their answers."
    } else {
        "You create concise college flashcards. Return only one complete valid JSON array of objects with non-empty string fields front and back. The user request gives the maximum number of cards; never exceed it, pad it, or begin another array. The front must be a precise question or term under 16 words. The back must be a direct answer under 36 words; use short phrases or compact bullet-like clauses, never a paragraph. Focus on definitions, claims, events, formulas, and distinctions in the supplied materials. If the user supplies only a topic or instruction, use accurate general academic knowledge and make the cards directly about that request. Do not use Markdown or commentary."
    }
}

fn json_array_from_response(output: &str) -> Option<String> {
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in output.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '[' if start.is_none() => {
                start = Some(index);
                depth = 1;
            }
            '[' if start.is_some() => depth += 1,
            ']' if start.is_some() => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let candidate = &output[start?..=index];
                    if serde_json::from_str::<serde_json::Value>(candidate)
                        .is_ok_and(|value| value.is_array())
                    {
                        return Some(candidate.to_string());
                    }
                    start = None;
                }
            }
            _ => {}
        }
    }
    None
}

fn json_object_from_response(output: &str) -> Option<String> {
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in output.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' if start.is_none() => {
                start = Some(index);
                depth = 1;
            }
            '{' if start.is_some() => depth += 1,
            '}' if start.is_some() => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let candidate = &output[start?..=index];
                    if serde_json::from_str::<serde_json::Value>(candidate)
                        .is_ok_and(|value| value.is_object())
                    {
                        return Some(candidate.to_string());
                    }
                    start = None;
                }
            }
            _ => {}
        }
    }
    None
}

fn emit_ai_progress(app: &tauri::AppHandle, progress: u8, message: &str) {
    let _ = app.emit(
        "ai-generation-progress",
        serde_json::json!({ "progress": progress, "message": message }),
    );
}

fn split_source_for_ai(text: &str, max_chars: usize) -> Vec<String> {
    let normalized = text.replace('\r', "");
    let mut chunks = Vec::new();
    let mut current = String::new();
    for block in normalized
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
    {
        let candidate = if current.is_empty() {
            block.trim().to_string()
        } else {
            format!("{}\n\n{}", current, block.trim())
        };
        if candidate.chars().count() <= max_chars {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            chunks.push(current);
        }
        let mut remainder = block.trim();
        while remainder.chars().count() > max_chars {
            let byte_limit = remainder
                .char_indices()
                .nth(max_chars)
                .map(|(index, _)| index)
                .unwrap_or(remainder.len());
            let split_at = remainder[..byte_limit]
                .rfind(char::is_whitespace)
                .filter(|index| *index > byte_limit / 2)
                .unwrap_or(byte_limit);
            chunks.push(remainder[..split_at].trim().to_string());
            remainder = remainder[split_at..].trim_start();
        }
        current = remainder.to_string();
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

fn ensure_ai_server(model_path: &str, app: &tauri::AppHandle) -> CommandResult<u16> {
    if let Some(port) = shared_model_server_port(&WORD_AI_SERVER, model_path) { return Ok(port); }
    // Qwen 3 can spend a completion entirely in its reasoning channel, which
    // leaves message.content empty for JSON- and text-based SoFlo features.
    // Keep reasoning disabled at the server level so every general AI action
    // returns usable content while the prompt still guides its analysis.
    ensure_model_server(&AI_SERVER, model_path, app, AI_CONTEXT_SIZE, "off")
}

fn ensure_flashcard_ai_server(model_path: &str, app: &tauri::AppHandle) -> CommandResult<u16> {
    ensure_model_server(
        &AI_SERVER,
        model_path,
        app,
        FLASHCARD_AI_CONTEXT_SIZE,
        "off",
    )
}

fn ensure_flashcard_cpu_ai_server(model_path: &str, app: &tauri::AppHandle) -> CommandResult<u16> {
    ensure_model_server_with_profiles(
        &AI_SERVER,
        model_path,
        app,
        FLASHCARD_AI_CONTEXT_SIZE,
        "off",
        true,
    )
}

fn ensure_study_web_ai_server(model_path: &str, app: &tauri::AppHandle) -> CommandResult<u16> {
    ensure_model_server(&AI_SERVER, model_path, app, STUDY_WEB_AI_CONTEXT_SIZE, "off")
}

fn ensure_word_ai_server(model_path: &str, app: &tauri::AppHandle) -> CommandResult<u16> {
    if let Some(port) = shared_model_server_port(&AI_SERVER, model_path) { return Ok(port); }
    ensure_model_server(
        &WORD_AI_SERVER,
        model_path,
        app,
        WORD_AI_CONTEXT_SIZE,
        "off",
    )
}

// General and Writing can intentionally point at the exact same GGUF (for
// example General Medium and Writing High). Keep one llama.cpp process in
// that case: these are two logical features, not two model instances.
fn shared_model_server_port(server_state: &'static OnceLock<Mutex<Option<AiServer>>>, model_path: &str) -> Option<u16> {
    let state = server_state.get()?;
    let mut guard = state.lock().ok()?;
    let server = guard.as_mut()?;
    if server.model_path != model_path || server.child.try_wait().ok()?.is_some() || !ai_server_ready(server.port) { return None; }
    server.last_used = Instant::now();
    Some(server.port)
}

fn start_llama_server(
    model_path: &str,
    port: u16,
    context_size: &str,
    reasoning: &str,
    gpu_layers: &str,
    gpu_device: Option<&str>,
) -> CommandResult<Child> {
    let port = port.to_string();
    let mut command = Command::new(llama_server_executable());
    command.args([
        "-m",
        model_path,
        "--host",
        "127.0.0.1",
        "--port",
        &port,
        "--ctx-size",
        context_size,
        "--parallel",
        AI_PARALLEL_REQUESTS,
        "--gpu-layers",
        gpu_layers,
    ]);
    if let Some(device) = gpu_device {
        command.args(["--device", device]);
    }
    // This must be present even for "off". Omitting it makes Qwen3 fall back
    // to its default thinking mode, which can spend the whole completion in
    // reasoning_content and leave message.content empty.
    command.args(["--reasoning", reasoning]);
    command.arg("--no-webui");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|error| {
        format!(
            "SoFlo could not start llama.cpp ({error}). Install or update llama.cpp, then try again."
        )
    })
}

fn wait_for_model_server_start(
    child: &mut Child,
    port: u16,
    app: &tauri::AppHandle,
) -> CommandResult<()> {
    let address: SocketAddr = format!("127.0.0.1:{}", port)
        .parse()
        .map_err(|_| "SoFlo could not start the local AI connection.".to_string())?;
    let startup_started = Instant::now();
    let startup_deadline = startup_started + Duration::from_secs(75);
    while Instant::now() < startup_deadline {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err("SoFlo's local AI helper stopped while loading.".into());
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
            && ai_server_ready(port)
        {
            emit_ai_progress(app, 32, "Your local model is ready");
            return Ok(());
        }
        if startup_started.elapsed() >= Duration::from_secs(30) {
            emit_ai_progress(app, 28, "Still loading your private local model");
        }
        thread::sleep(Duration::from_millis(400));
    }
    Err("The local AI model took too long to start.".into())
}

fn ensure_model_server(
    server_state: &'static OnceLock<Mutex<Option<AiServer>>>,
    model_path: &str,
    app: &tauri::AppHandle,
    context_size: &str,
    reasoning: &str,
) -> CommandResult<u16> {
    ensure_model_server_with_profiles(server_state, model_path, app, context_size, reasoning, false)
}

fn ensure_model_server_with_profiles(
    server_state: &'static OnceLock<Mutex<Option<AiServer>>>,
    model_path: &str,
    app: &tauri::AppHandle,
    context_size: &str,
    reasoning: &str,
    force_cpu: bool,
) -> CommandResult<u16> {
    let state = server_state.get_or_init(|| Mutex::new(None));
    let mut guard = state
        .lock()
        .map_err(|_| "SoFlo's local AI state is unavailable.".to_string())?;
    if let Some(server) = guard.as_mut() {
        if server.model_path == model_path
            && server.context_size == context_size
            && server.reasoning == reasoning
            && (server.last_used.elapsed() < AI_WARM_WINDOW || model_server_session_pinned(server_state))
            && server
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            && ai_server_ready(server.port)
        {
            server.last_used = Instant::now();
            emit_ai_progress(app, 32, "Your local model is ready");
            return Ok(server.port);
        }
        let _ = server.child.kill();
        let _ = server.child.wait();
        *guard = None;
    }
    emit_ai_progress(app, 22, "Loading your private local model");
    let gpu_device = if force_cpu { None } else { llama_acceleration_device() };
    let profiles: &[&str] = if force_cpu || gpu_device.is_none() {
        &["0"]
    } else {
        &[AI_GPU_LAYERS, "auto", "0"]
    };
    let mut last_error = "SoFlo's local AI helper stopped while loading.".to_string();
    for gpu_layers in profiles {
        let port = available_loopback_port()?;
        let mut child = match start_llama_server(
            model_path,
            port,
            context_size,
            reasoning,
            gpu_layers,
            if *gpu_layers == "0" { None } else { gpu_device.as_deref() },
        ) {
            Ok(child) => child,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        match wait_for_model_server_start(&mut child, port, app) {
            Ok(()) => {
                // `/v1/models` only proves the process loaded. A tiny request
                // verifies that the selected Vulkan/CUDA device can actually
                // run inference before SoFlo keeps that GPU profile.
                if *gpu_layers != "0" && !ai_server_inference_ready(port) {
                    last_error = "The selected GPU could not complete an AI request.".into();
                    let _ = child.kill();
                    let _ = child.wait();
                    continue;
                }
                *guard = Some(AiServer {
                    child,
                    model_path: model_path.to_string(),
                    context_size: context_size.to_string(),
                    reasoning: reasoning.to_string(),
                    port,
                    last_used: Instant::now(),
                });
                return Ok(port);
            }
            Err(error) => {
                last_error = error;
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    *guard = None;
    Err(format!(
        "{last_error} SoFlo retried with compatibility and CPU modes. Restart SoFlo, then check Manage models."
    ))
}

fn available_loopback_port() -> CommandResult<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "SoFlo could not reserve a private local AI connection.".to_string())?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|_| "SoFlo could not read its private local AI connection.".to_string())
}

fn ai_server_ready(port: u16) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(900))
        .build()
        .and_then(|client| {
            client
                .get(format!("http://127.0.0.1:{}/v1/models", port))
                .send()
        })
        .is_ok_and(|response| response.status().is_success())
}

fn ai_server_inference_ready(port: u16) -> bool {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
    else {
        return false;
    };
    let Ok(response) = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", port))
        .json(&serde_json::json!({
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "max_tokens": 8,
            "temperature": 0.2,
            "stream": false
        }))
        .send()
    else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .json::<serde_json::Value>()
        .ok()
        .is_some_and(|body| {
            body.get("choices")
                .and_then(|value| value.get(0))
                .and_then(|value| value.get("message"))
                .and_then(|value| value.get("content"))
                .and_then(|value| value.as_str())
                .is_some_and(|content| !content.trim().is_empty())
        })
}

fn touch_ai_server() {
    touch_model_server(&AI_SERVER);
    touch_model_server(&WORD_AI_SERVER)
}

fn touch_word_ai_server() {
    touch_model_server(&WORD_AI_SERVER);
    touch_model_server(&AI_SERVER)
}

fn model_server_session_pinned(server_state: &'static OnceLock<Mutex<Option<AiServer>>>) -> bool {
    if std::ptr::eq(server_state, &AI_SERVER) {
        AI_SERVER_SESSION_PINNED.load(Ordering::Relaxed)
    } else {
        WORD_AI_SERVER_SESSION_PINNED.load(Ordering::Relaxed)
    }
}

fn touch_model_server(server_state: &'static OnceLock<Mutex<Option<AiServer>>>) {
    if let Some(state) = server_state.get() {
        if let Ok(mut guard) = state.lock() {
            if let Some(server) = guard.as_mut() {
                server.last_used = Instant::now();
            }
        }
    }
    thread::spawn(move || {
        thread::sleep(AI_WARM_WINDOW);
        if let Some(state) = server_state.get() {
            if let Ok(mut guard) = state.lock() {
                if !model_server_session_pinned(server_state) && guard
                    .as_ref()
                    .is_some_and(|server| server.last_used.elapsed() >= AI_WARM_WINDOW)
                {
                    if let Some(mut server) = guard.take() {
                        let _ = server.child.kill();
                        let _ = server.child.wait();
                    }
                }
            }
        }
    });
}

fn stop_model_server(server_state: &'static OnceLock<Mutex<Option<AiServer>>>) {
    if let Some(state) = server_state.get() {
        if let Ok(mut guard) = state.lock() {
            if let Some(mut server) = guard.take() {
                let _ = server.child.kill();
                let _ = server.child.wait();
            }
        }
    }
}

#[tauri::command]
pub fn stop_ai_server() -> CommandResult<()> {
    if !AI_SERVER_SESSION_PINNED.load(Ordering::Relaxed) {
        stop_model_server(&AI_SERVER);
    }
    if !WORD_AI_SERVER_SESSION_PINNED.load(Ordering::Relaxed) {
        stop_model_server(&WORD_AI_SERVER);
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_ai_for_session(
    app: tauri::AppHandle,
    general_model_path: String,
    voice_model_path: String,
    mode: String,
) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let mode = mode.trim().to_ascii_lowercase();
        if mode != "writing" && mode != "study" {
            return Err("Choose writing or study AI for this session.".into());
        }

        AI_SERVER_SESSION_PINNED.store(true, Ordering::Relaxed);
        let general_model = match resolve_ai_model_path(&app, &general_model_path) {
            Ok(path) => path,
            Err(error) => {
                AI_SERVER_SESSION_PINNED.store(false, Ordering::Relaxed);
                return Err(error);
            }
        };
        emit_ai_progress(&app, if mode == "writing" { 48 } else { 8 }, "Preparing your local AI");
        if let Err(error) = ensure_ai_server(&general_model, &app) {
            AI_SERVER_SESSION_PINNED.store(false, Ordering::Relaxed);
            return Err(error);
        }

        if mode == "study" {
            emit_ai_progress(&app, 82, "Checking your lecture transcription model");
            if let Err(error) = resolve_voice_model_path(&app, &voice_model_path) {
                AI_SERVER_SESSION_PINNED.store(false, Ordering::Relaxed);
                return Err(error);
            }
        }

        emit_ai_progress(&app, 100, "Your AI is ready for this session");
        Ok(())
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

fn download_ai_model_file(
    app: &tauri::AppHandle,
    url: &str,
    destination: &Path,
    progress_start: u8,
    progress_end: u8,
    minimum_size: Option<u64>,
) -> CommandResult<()> {
    if destination.is_file() {
        if minimum_size.map_or(true, |minimum| {
            fs::metadata(destination).is_ok_and(|metadata| metadata.len() >= minimum)
        }) {
            return Ok(());
        }
        fs::remove_file(destination).map_err(|error| error.to_string())?;
    }
    let directory = destination
        .parent()
        .ok_or_else(|| "SoFlo could not determine the local AI model folder.".to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let filename = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("model.gguf");
    let temporary = directory.join(format!("{}.download", filename));
    let mut response = reqwest::blocking::get(url)
        .map_err(|_| "SoFlo could not start the local AI model download.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "SoFlo could not download the local AI model (server returned {}).",
            response.status()
        ));
    }
    // Some CDN responses stream correctly but omit Content-Length. The model
    // is still safe to download; we simply show indeterminate progress until
    // the final integrity-size check below.
    let total = response.content_length();
    let mut output = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    let mut downloaded = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|_| "The local AI model download was interrupted.".to_string())?;
        if count == 0 {
            break;
        }
        use std::io::Write;
        output
            .write_all(&buffer[..count])
            .map_err(|error| error.to_string())?;
        downloaded += count as u64;
        if let Some(total) = total.filter(|total| *total > 0) {
            let span = u64::from(progress_end.saturating_sub(progress_start));
            let progress = u64::from(progress_start) + downloaded.saturating_mul(span) / total;
            let _ = app.emit("ai-download-progress", progress.min(100) as u8);
        }
    }
    drop(output);
    if let Some(minimum) = minimum_size {
        if downloaded < minimum {
            let _ = fs::remove_file(&temporary);
            return Err("The local AI model download ended before the complete file arrived. Please try again.".into());
        }
    }
    fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn download_default_ai_model(
    app: tauri::AppHandle,
    database: State<'_, Database>,
) -> CommandResult<DefaultAiModelPaths> {
    let configured_model_path = get_settings(&database.open()?, None)?.ai_model_path;
    let download_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> CommandResult<DefaultAiModelPaths> {
        const MAIN_MODEL_URL: &str = "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true";
        let configured = Path::new(configured_model_path.trim());
        let configured_is_legacy_default = configured
            .file_name()
            .and_then(|file| file.to_str())
            .is_some_and(|file| file.eq_ignore_ascii_case(LEGACY_DEFAULT_AI_MODEL_NAME));
        let use_existing_custom_model = configured.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"))
            && configured.is_file()
            && !configured_is_legacy_default;
        let destination = if configured_model_path.trim().is_empty() || configured_is_legacy_default {
            download_app.path().app_data_dir().map_err(|error| error.to_string())?.join("models").join(DEFAULT_AI_MODEL_NAME)
        } else {
            if configured.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("gguf")) {
                configured.to_path_buf()
            } else {
                configured.join(DEFAULT_AI_MODEL_NAME)
            }
        };
        let voice_destination = download_app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("models")
            .join(VOICE_MEDIUM_MODEL_NAME);
        let voice = managed_ai_model("voice", "medium")?;
        if !(use_existing_custom_model || destination.is_file()) {
            download_ai_model_file(&download_app, MAIN_MODEL_URL, &destination, 0, 70, None)?;
        }
        download_ai_model_file(&download_app, voice.url, &voice_destination, 70, 100, voice.minimum_bytes)?;
        let _ = download_app.emit("ai-download-progress", 100u8);
        let _ = download_app.emit("ai-download-finished", ());
        Ok(DefaultAiModelPaths {
            general_path: destination.to_string_lossy().to_string(),
            writing_path: destination.to_string_lossy().to_string(),
            voice_path: voice_destination.to_string_lossy().to_string(),
        })
    }).await.map_err(|_| "SoFlo could not start the local AI download.".to_string())?;
    if result.is_err() {
        let _ = app.emit("ai-download-finished", ());
    }
    let paths = result?;
    let connection = database.open()?;
    let mut settings = get_settings(&connection, None)?;
    settings.ai_model_path = paths.general_path.clone();
    settings.ai_writing_model_path = paths.writing_path.clone();
    settings.ai_voice_model_path = paths.voice_path.clone();
    settings.ai_general_model_tier = "medium".into();
    settings.ai_writing_model_tier = "medium".into();
    settings.ai_voice_model_tier = "medium".into();
    let serialized = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    connection.execute("INSERT INTO app_settings (key, value, updated_at) VALUES ('settings', ?1, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP", [&serialized]).map_err(|error| error.to_string())?;
    Ok(paths)
}

#[tauri::command]
pub async fn install_ai_model(
    app: tauri::AppHandle,
    role: String,
    tier: String,
) -> CommandResult<String> {
    let profile = managed_ai_model(role.trim(), tier.trim())?;
    let download_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let destination = managed_models_dir(&download_app)?.join(profile.filename);
        download_ai_model_file(&download_app, profile.url, &destination, 0, 100, profile.minimum_bytes)?;
        let _ = download_app.emit("ai-download-progress", 100u8);
        let _ = download_app.emit("ai-download-finished", ());
        Ok(destination.to_string_lossy().to_string())
    }).await.map_err(|_| "SoFlo could not start the local AI download.".to_string())?;
    if result.is_err() { let _ = app.emit("ai-download-finished", ()); }
    result
}

#[tauri::command]
pub fn get_ai_model_inventory(app: tauri::AppHandle) -> CommandResult<serde_json::Value> {
    let models = managed_models_dir(&app)?;
    let installed = |role: &str, tier: &str| -> bool {
        managed_ai_model(role, tier).ok().is_some_and(|profile| {
            let path = models.join(profile.filename);
            path.is_file() && profile.minimum_bytes.map_or(true, |minimum| fs::metadata(path).is_ok_and(|metadata| metadata.len() >= minimum))
        })
    };
    Ok(serde_json::json!({
        "general": { "low": installed("general", "low"), "medium": installed("general", "medium"), "high": installed("general", "high") },
        "writing": { "low": installed("writing", "low"), "medium": installed("writing", "medium"), "high": installed("writing", "high") },
        "voice": { "low": installed("voice", "low"), "medium": installed("voice", "medium"), "high": installed("voice", "high") }
    }))
}

#[tauri::command]
pub fn delete_unused_ai_models(
    app: tauri::AppHandle,
    general_path: String,
    writing_path: String,
    voice_path: String,
) -> CommandResult<()> {
    stop_model_server(&AI_SERVER);
    stop_model_server(&WORD_AI_SERVER);
    let models = managed_models_dir(&app)?;
    let active = [
        if general_path.trim().is_empty() { models.join(DEFAULT_AI_MODEL_NAME) } else { Path::new(general_path.trim()).to_path_buf() },
        if writing_path.trim().is_empty() { models.join(WORD_AI_MODEL_NAME) } else { Path::new(writing_path.trim()).to_path_buf() },
        if voice_path.trim().is_empty() { models.join(VOICE_MEDIUM_MODEL_NAME) } else { Path::new(voice_path.trim()).to_path_buf() },
    ];
    let mut names = std::collections::HashSet::new();
    for role in ["general", "writing", "voice"] {
        for tier in ["low", "medium", "high"] {
            if let Ok(profile) = managed_ai_model(role, tier) { names.insert(profile.filename); }
        }
    }
    for name in names {
        let path = models.join(name);
        if path.is_file() && !active.iter().any(|item| item == &path) {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn delete_local_ai_models(
    app: tauri::AppHandle,
    database: State<'_, Database>,
) -> CommandResult<()> {
    AI_SERVER_SESSION_PINNED.store(false, Ordering::Relaxed);
    WORD_AI_SERVER_SESSION_PINNED.store(false, Ordering::Relaxed);
    stop_model_server(&AI_SERVER);
    stop_model_server(&WORD_AI_SERVER);
    let models = app.path().app_data_dir().map_err(|error| error.to_string())?.join("models");
    for name in [DEFAULT_AI_MODEL_NAME, WORD_AI_MODEL_NAME, LEGACY_DEFAULT_AI_MODEL_NAME, GENERAL_LOW_MODEL_NAME, GENERAL_HIGH_MODEL_NAME, WRITING_LOW_MODEL_NAME, WRITING_HIGH_MODEL_NAME, VOICE_LOW_MODEL_NAME, VOICE_MEDIUM_MODEL_NAME, VOICE_HIGH_MODEL_NAME] {
        let path = models.join(name);
        if path.is_file() { fs::remove_file(path).map_err(|error| error.to_string())?; }
    }
    let connection = database.open()?;
    let mut settings = get_settings(&connection, None)?;
    settings.ai_model_path.clear();
    settings.ai_writing_model_path.clear();
    settings.ai_voice_model_path.clear();
    settings.ai_general_model_tier = "medium".to_string();
    settings.ai_writing_model_tier = "medium".to_string();
    settings.ai_voice_model_tier = "medium".to_string();
    settings.ai_grammar = false;
    let serialized = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    connection.execute("INSERT INTO app_settings (key, value, updated_at) VALUES ('settings', ?1, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP", [&serialized]).map_err(|error| error.to_string())?;
    Ok(())
}

fn read_semester(row: &Row<'_>) -> rusqlite::Result<Semester> {
    Ok(Semester {
        id: row.get(0)?,
        name: row.get(1)?,
        term: row.get(2)?,
        year: row.get(3)?,
        position: row.get(4)?,
        archived_at: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn read_class(row: &Row<'_>) -> rusqlite::Result<CourseClass> {
    Ok(CourseClass {
        id: row.get(0)?,
        semester_id: row.get(1)?,
        name: row.get(2)?,
        course_code: row.get(3)?,
        professor: row.get(4)?,
        location: row.get(5)?,
        schedule: row.get(6)?,
        icon: row.get(7)?,
        accent_color: row.get(8)?,
        position: row.get(9)?,
        archived_at: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn read_document_summary(row: &Row<'_>) -> rusqlite::Result<DocumentSummary> {
    let favorite: i64 = row.get(4)?;
    Ok(DocumentSummary {
        id: row.get(0)?,
        class_id: row.get(1)?,
        title: row.get(2)?,
        excerpt: row.get(3)?,
        is_favorite: favorite != 0,
        updated_at: row.get(5)?,
        deleted_at: row.get(6)?,
        is_syllabus: row.get::<_, i64>(7)? != 0,
        folder_id: row.get(8)?,
        linked_pdf_path: row.get(9)?,
    })
}

fn read_document(row: &Row<'_>) -> rusqlite::Result<DocumentDetail> {
    let favorite: i64 = row.get(5)?;
    Ok(DocumentDetail {
        id: row.get(0)?,
        class_id: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        content_plain: row.get(4)?,
        is_favorite: favorite != 0,
        revision: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        deleted_at: row.get(9)?,
        is_syllabus: row.get::<_, i64>(10)? != 0,
        folder_id: row.get(11)?,
        linked_pdf_path: row.get(12)?,
    })
}

fn read_lecture_summary(row: &Row<'_>) -> rusqlite::Result<LectureSummary> {
    Ok(LectureSummary {
        id: row.get(0)?,
        class_id: row.get(1)?,
        course_code: row.get(2)?,
        course_name: row.get(3)?,
        lecture_date: row.get(4)?,
        scheduled_start: row.get(5)?,
        scheduled_end: row.get(6)?,
        professor_snapshot: row.get(7)?,
        title: row.get(8)?,
        excerpt: row.get(9)?,
        updated_at: row.get(10)?,
        created_at: row.get(11)?,
    })
}

fn read_lecture(row: &Row<'_>) -> rusqlite::Result<LectureDetail> {
    Ok(LectureDetail {
        id: row.get(0)?,
        class_id: row.get(1)?,
        course_code: row.get(2)?,
        course_name: row.get(3)?,
        lecture_date: row.get(4)?,
        scheduled_start: row.get(5)?,
        scheduled_end: row.get(6)?,
        professor_snapshot: row.get(7)?,
        title: row.get(8)?,
        content: row.get(9)?,
        content_plain: row.get(10)?,
        revision: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn read_set_summary(row: &Row<'_>) -> rusqlite::Result<FlashcardSetSummary> {
    Ok(FlashcardSetSummary {
        id: row.get(0)?,
        class_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        card_count: row.get(4)?,
        updated_at: row.get(5)?,
        deleted_at: row.get(6)?,
    })
}

fn read_card(row: &Row<'_>) -> rusqlite::Result<Flashcard> {
    let starred: i64 = row.get(7)?;
    Ok(Flashcard {
        id: row.get(0)?,
        set_id: row.get(1)?,
        front: row.get(2)?,
        back: row.get(3)?,
        notes: row.get(4)?,
        image_path: row.get(5)?,
        position: row.get(6)?,
        is_starred: starred != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn read_card_progress(row: &Row<'_>) -> rusqlite::Result<CardProgress> {
    Ok(CardProgress {
        card_id: row.get(0)?,
        mastery: row.get(1)?,
        correct_count: row.get(2)?,
        incorrect_count: row.get(3)?,
        consecutive_correct: row.get(4)?,
        last_seen_at: row.get(5)?,
        due_at: row.get(6)?,
    })
}

fn get_settings(
    connection: &Connection,
    installer_model_path: Option<&str>,
) -> CommandResult<AppSettings> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'settings'",
            [],
            |row| row.get(0),
        )
        .ok();
    let mut settings: AppSettings = raw
        .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
        .transpose()?
        .unwrap_or_default();
    let mut needs_save = false;
    if settings.editor_defaults_version < 1 {
        // Version 1 used 16px as the initial editor size. Move only that legacy
        // default to the Google Docs baseline without disturbing a custom size.
        if settings.editor_font_size == 16 {
            settings.editor_font_size = 11;
        }
        settings.editor_defaults_version = 1;
        needs_save = true;
    }
    if !settings.onboarding_completed && !settings.user_name.trim().is_empty() {
        settings.onboarding_completed = true;
        needs_save = true;
    }
    if settings.ai_model_path.trim().is_empty() {
        if let Some(path) = installer_model_path.filter(|path| !path.trim().is_empty()) {
            settings.ai_model_path = path.trim().to_string();
            needs_save = true;
        }
    }
    if needs_save {
        let serialized = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
        connection.execute("INSERT INTO app_settings (key, value, updated_at) VALUES ('settings', ?1, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", [&serialized]).map_err(|error| error.to_string())?;
    }
    Ok(settings)
}

#[tauri::command]
pub fn bootstrap(database: State<'_, Database>) -> CommandResult<BootstrapData> {
    let connection = database.open()?;
    purge_expired_trash(&connection)?;
    let auto_archived =
        auto_archive_finished_semesters(&connection, chrono::Local::now().date_naive())?;
    let semesters = list_semesters_from(&connection, false)?;
    let classes = list_classes_from(&connection, false)?;
    let installer_model_path = database.installer_model_path();
    let settings = get_settings(&connection, installer_model_path.as_deref())?;
    if installer_model_path.is_some() {
        database.clear_installer_model_path()?;
    }
    let result = BootstrapData {
        semesters,
        classes,
        settings,
        data_location: database.data_path().display().to_string(),
    };
    drop(connection);
    if auto_archived {
        database.sync_encrypted()?;
    }
    Ok(result)
}

fn semester_end_date(term: &str, year: i32) -> Option<chrono::NaiveDate> {
    let (month, day) = match term.trim().to_ascii_lowercase().as_str() {
        "spring" => (5, 12),
        "fall" => (12, 12),
        _ => return None,
    };
    chrono::NaiveDate::from_ymd_opt(year, month, day)
}

fn auto_archive_finished_semesters(
    connection: &Connection,
    today: chrono::NaiveDate,
) -> CommandResult<bool> {
    let mut statement = connection
        .prepare("SELECT id, term, year FROM semesters WHERE archived_at IS NULL")
        .map_err(|error| error.to_string())?;
    let candidates = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i32>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let mut changed = false;
    for (semester_id, term, year) in candidates {
        if semester_end_date(&term, year).is_some_and(|cutoff| today >= cutoff) {
            connection.execute("UPDATE classes SET archived_at=COALESCE(archived_at,CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE semester_id=?1", [&semester_id]).map_err(|error| error.to_string())?;
            changed |= connection.execute("UPDATE semesters SET archived_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?1", [&semester_id]).map_err(|error| error.to_string())? > 0;
        }
    }
    Ok(changed)
}

fn list_semesters_from(
    connection: &Connection,
    include_archived: bool,
) -> CommandResult<Vec<Semester>> {
    let mut statement = connection.prepare(
        "SELECT id, name, term, year, position, archived_at, created_at, updated_at FROM semesters WHERE (?1 = 1 OR archived_at IS NULL) ORDER BY archived_at IS NOT NULL, year DESC, position ASC, created_at DESC"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([include_archived as i32], read_semester)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_semesters(
    database: State<'_, Database>,
    include_archived: bool,
) -> CommandResult<Vec<Semester>> {
    list_semesters_from(&database.open()?, include_archived)
}

#[tauri::command]
pub fn create_semester(
    database: State<'_, Database>,
    input: CreateSemesterInput,
) -> CommandResult<Semester> {
    let connection = database.open()?;
    let id = Uuid::new_v4().to_string();
    let position: i32 = connection
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM semesters",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO semesters (id, name, term, year, position) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id,
                input.name.trim(),
                input.term.trim(),
                input.year,
                position
            ],
        )
        .map_err(|error| error.to_string())?;
    connection.query_row("SELECT id, name, term, year, position, archived_at, created_at, updated_at FROM semesters WHERE id = ?1", [&id], read_semester).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_semester(
    database: State<'_, Database>,
    input: UpdateSemesterInput,
) -> CommandResult<Semester> {
    let connection = database.open()?;
    let archive = if input.archived {
        "CURRENT_TIMESTAMP"
    } else {
        "NULL"
    };
    connection.execute(&format!("UPDATE semesters SET name=?1, term=?2, year=?3, archived_at={}, updated_at=CURRENT_TIMESTAMP WHERE id=?4", archive), params![input.name.trim(), input.term.trim(), input.year, input.id]).map_err(|error| error.to_string())?;
    connection.query_row("SELECT id, name, term, year, position, archived_at, created_at, updated_at FROM semesters WHERE id = ?1", [&input.id], read_semester).map_err(|error| error.to_string())
}

fn list_classes_from(
    connection: &Connection,
    include_archived: bool,
) -> CommandResult<Vec<CourseClass>> {
    let mut statement = connection.prepare(
        "SELECT id, semester_id, name, course_code, professor, location, schedule, icon, accent_color, position, archived_at, created_at, updated_at FROM classes WHERE (?1 = 1 OR archived_at IS NULL) ORDER BY archived_at IS NOT NULL, position ASC, created_at ASC"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([include_archived as i32], read_class)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_classes(
    database: State<'_, Database>,
    include_archived: bool,
) -> CommandResult<Vec<CourseClass>> {
    list_classes_from(&database.open()?, include_archived)
}

#[tauri::command]
pub fn create_class(
    database: State<'_, Database>,
    input: CreateClassInput,
) -> CommandResult<CourseClass> {
    let connection = database.open()?;
    let id = Uuid::new_v4().to_string();
    let position: i32 = connection
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM classes WHERE semester_id=?1",
            [&input.semester_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO classes (id, semester_id, name, course_code, professor, location, schedule, icon, accent_color, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, input.semester_id, input.name.trim(), input.course_code.trim(), input.professor, input.location, input.schedule, input.icon.unwrap_or_else(|| "book-open".into()), input.accent_color.unwrap_or_else(|| "#8B7CF6".into()), position],
    ).map_err(|error| error.to_string())?;
    connection.query_row("SELECT id, semester_id, name, course_code, professor, location, schedule, icon, accent_color, position, archived_at, created_at, updated_at FROM classes WHERE id=?1", [&id], read_class).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_class(
    database: State<'_, Database>,
    input: UpdateClassInput,
) -> CommandResult<CourseClass> {
    let connection = database.open()?;
    let archive = if input.archived {
        "CURRENT_TIMESTAMP"
    } else {
        "NULL"
    };
    connection.execute(&format!("UPDATE classes SET semester_id=?1, name=?2, course_code=?3, professor=?4, location=?5, schedule=?6, icon=?7, accent_color=?8, archived_at={}, updated_at=CURRENT_TIMESTAMP WHERE id=?9", archive), params![input.semester_id, input.name.trim(), input.course_code.trim(), input.professor, input.location, input.schedule, input.icon, input.accent_color, input.id]).map_err(|error| error.to_string())?;
    connection.query_row("SELECT id, semester_id, name, course_code, professor, location, schedule, icon, accent_color, position, archived_at, created_at, updated_at FROM classes WHERE id=?1", [&input.id], read_class).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_class(database: State<'_, Database>, id: String) -> CommandResult<()> {
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM test_attempts WHERE set_id IN (SELECT id FROM flashcard_sets WHERE class_id=?1)", [&id]).map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM lectures WHERE class_id=?1", [&id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM documents WHERE class_id=?1", [&id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM flashcard_sets WHERE class_id=?1", [&id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM document_folders WHERE class_id=?1", [&id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM classes WHERE id=?1", [&id])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_semester(database: State<'_, Database>, id: String) -> CommandResult<()> {
    let connection = database.open()?;
    let class_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM classes WHERE semester_id=?1",
            [&id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if class_count > 0 {
        return Err("Remove the classes in this semester before removing it.".into());
    }
    connection
        .execute("DELETE FROM semesters WHERE id=?1", [&id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_documents(
    database: State<'_, Database>,
    class_id: String,
    include_deleted: bool,
) -> CommandResult<Vec<DocumentSummary>> {
    let connection = database.open()?;
    purge_expired_trash(&connection)?;
    let mut statement = connection.prepare("SELECT id, class_id, title, substr(content_plain, 1, 160), is_favorite, updated_at, deleted_at, is_syllabus, folder_id, linked_pdf_path FROM documents WHERE class_id=?1 AND is_syllabus=0 AND (?2=1 OR deleted_at IS NULL) ORDER BY is_favorite DESC, updated_at DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![class_id, include_deleted as i32],
            read_document_summary,
        )
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_recent_documents(database: State<'_, Database>) -> CommandResult<Vec<DocumentSummary>> {
    let connection = database.open()?;
    let mut statement = connection.prepare("SELECT id, class_id, title, substr(content_plain, 1, 160), is_favorite, updated_at, deleted_at, is_syllabus, folder_id, linked_pdf_path FROM documents WHERE deleted_at IS NULL AND is_syllabus=0 ORDER BY updated_at DESC LIMIT 8").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], read_document_summary)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_document(database: State<'_, Database>, id: String) -> CommandResult<DocumentDetail> {
    let connection = database.open()?;
    connection.query_row("SELECT id, class_id, title, content, content_plain, is_favorite, revision, created_at, updated_at, deleted_at, is_syllabus, folder_id, linked_pdf_path FROM documents WHERE id=?1", [&id], read_document).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_syllabus(
    database: State<'_, Database>,
    class_id: String,
) -> CommandResult<Option<DocumentDetail>> {
    database
        .open()?
        .query_row(
            "SELECT id, class_id, title, content, content_plain, is_favorite, revision, created_at, updated_at, deleted_at, is_syllabus, folder_id, linked_pdf_path FROM documents WHERE class_id=?1 AND is_syllabus=1 AND deleted_at IS NULL LIMIT 1",
            [&class_id],
            read_document,
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_document_revisions(
    database: State<'_, Database>,
    id: String,
) -> CommandResult<Vec<RevisionHistoryEntry>> {
    let connection = database.open()?;
    let mut statement = connection
        .prepare("SELECT id, revision, title, content, content_plain, created_at, name, source FROM document_revisions WHERE document_id=?1 ORDER BY created_at DESC, revision DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([id], |row| {
            Ok(RevisionHistoryEntry {
                id: row.get(0)?,
                revision: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                content_plain: row.get(4)?,
                created_at: row.get(5)?,
                name: row.get(6)?,
                source: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn name_document_revision(
    database: State<'_, Database>,
    revision_id: String,
    name: String,
) -> CommandResult<()> {
    let trimmed = name.trim();
    let changed = database
        .open()?
        .execute(
            "UPDATE document_revisions SET name=?1 WHERE id=?2",
            params![
                if trimmed.is_empty() {
                    None::<String>
                } else {
                    Some(trimmed.to_string())
                },
                revision_id
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("That saved version could not be found.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn restore_document_revision(
    database: State<'_, Database>,
    id: String,
    revision_id: String,
) -> CommandResult<DocumentDetail> {
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (restore_title, restore_content, restore_plain): (String, String, String) = transaction.query_row(
        "SELECT title, content, content_plain FROM document_revisions WHERE id=?1 AND document_id=?2",
        params![revision_id, id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "That saved version could not be found.".to_string())?;
    let (current_title, current_content, current_plain, revision): (String, String, String, i32) =
        transaction
            .query_row(
                "SELECT title, content, content_plain, revision FROM documents WHERE id=?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO document_revisions (id, document_id, title, content, content_plain, revision, source) VALUES (?1,?2,?3,?4,?5,?6,'user')",
        params![Uuid::new_v4().to_string(), id, current_title, current_content, current_plain, revision],
    ).map_err(|error| error.to_string())?;
    transaction.execute(
        "UPDATE documents SET title=?1, content=?2, content_plain=?3, revision=?4, updated_at=CURRENT_TIMESTAMP WHERE id=?5",
        params![restore_title, restore_content, restore_plain, revision + 1, id],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_document(database, id)
}

#[tauri::command]
pub fn set_document_syllabus(
    database: State<'_, Database>,
    id: String,
) -> CommandResult<DocumentDetail> {
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let class_id: String = transaction
        .query_row("SELECT class_id FROM documents WHERE id=?1", [&id], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE documents SET is_syllabus=0 WHERE class_id=?1",
            [&class_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE documents SET is_syllabus=1, updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            [&id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_document(database, id)
}

#[tauri::command]
pub fn create_document(
    database: State<'_, Database>,
    input: CreateDocumentInput,
) -> CommandResult<DocumentDetail> {
    let connection = database.open()?;
    let id = Uuid::new_v4().to_string();
    let content = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
    connection.execute("INSERT INTO documents (id, class_id, title, content, content_plain) VALUES (?1, ?2, ?3, ?4, '')", params![id, input.class_id, input.title.trim(), content]).map_err(|error| error.to_string())?;
    connection.query_row("SELECT id, class_id, title, content, content_plain, is_favorite, revision, created_at, updated_at, deleted_at, is_syllabus, folder_id, linked_pdf_path FROM documents WHERE id=?1", [&id], read_document).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_lectures(
    database: State<'_, Database>,
    class_id: String,
) -> CommandResult<Vec<LectureSummary>> {
    let connection = database.open()?;
    let mut statement = connection.prepare("SELECT id, class_id, course_code, course_name, lecture_date, scheduled_start, scheduled_end, professor_snapshot, title, substr(content_plain, 1, 180), updated_at, created_at FROM lectures WHERE class_id=?1 ORDER BY lecture_date DESC, created_at DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([class_id], read_lecture_summary)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_lecture_revisions(
    database: State<'_, Database>,
    id: String,
) -> CommandResult<Vec<RevisionHistoryEntry>> {
    let connection = database.open()?;
    let mut statement = connection
        .prepare("SELECT id, revision, title, content, content_plain, created_at, name, source FROM lecture_revisions WHERE lecture_id=?1 ORDER BY created_at DESC, revision DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([id], |row| {
            Ok(RevisionHistoryEntry {
                id: row.get(0)?,
                revision: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                content_plain: row.get(4)?,
                created_at: row.get(5)?,
                name: row.get(6)?,
                source: row.get(7)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn name_lecture_revision(
    database: State<'_, Database>,
    revision_id: String,
    name: String,
) -> CommandResult<()> {
    let trimmed = name.trim();
    let changed = database
        .open()?
        .execute(
            "UPDATE lecture_revisions SET name=?1 WHERE id=?2",
            params![
                if trimmed.is_empty() {
                    None::<String>
                } else {
                    Some(trimmed.to_string())
                },
                revision_id
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("That saved lecture version could not be found.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn restore_lecture_revision(
    database: State<'_, Database>,
    id: String,
    revision_id: String,
) -> CommandResult<LectureDetail> {
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (restore_title, restore_content, restore_plain): (String, String, String) = transaction.query_row(
        "SELECT title, content, content_plain FROM lecture_revisions WHERE id=?1 AND lecture_id=?2",
        params![revision_id, id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "That saved lecture version could not be found.".to_string())?;
    let (current_title, current_content, current_plain, revision): (String, String, String, i32) =
        transaction
            .query_row(
                "SELECT title, content, content_plain, revision FROM lectures WHERE id=?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO lecture_revisions (id, lecture_id, title, content, content_plain, revision, source) VALUES (?1,?2,?3,?4,?5,?6,'user')",
        params![Uuid::new_v4().to_string(), id, current_title, current_content, current_plain, revision],
    ).map_err(|error| error.to_string())?;
    transaction.execute(
        "UPDATE lectures SET title=?1, content=?2, content_plain=?3, revision=?4, updated_at=CURRENT_TIMESTAMP WHERE id=?5",
        params![restore_title, restore_content, restore_plain, revision + 1, id],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    get_lecture(database, id)
}

#[tauri::command]
pub fn get_lecture(database: State<'_, Database>, id: String) -> CommandResult<LectureDetail> {
    database.open()?.query_row("SELECT id, class_id, course_code, course_name, lecture_date, scheduled_start, scheduled_end, professor_snapshot, title, content, content_plain, revision, created_at, updated_at FROM lectures WHERE id=?1", [&id], read_lecture).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_lecture(
    database: State<'_, Database>,
    input: CreateLectureInput,
) -> CommandResult<LectureDetail> {
    if input.title.trim().is_empty() {
        return Err("Give this lecture a title.".into());
    }
    let connection = database.open()?;
    let id = Uuid::new_v4().to_string();
    let content = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;
    connection.execute(
        "INSERT INTO lectures (id, class_id, course_code, course_name, lecture_date, scheduled_start, scheduled_end, professor_snapshot, title, content, content_plain) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '')",
        params![id, input.class_id, input.course_code.trim(), input.course_name.trim(), input.lecture_date.trim(), input.scheduled_start, input.scheduled_end, input.professor_snapshot.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()), input.title.trim(), content],
    ).map_err(|error| error.to_string())?;
    get_lecture(database, id)
}

#[tauri::command]
pub fn save_lecture(
    database: State<'_, Database>,
    input: SaveLectureInput,
) -> CommandResult<LectureDetail> {
    if input.title.trim().is_empty() {
        return Err("Lecture titles cannot be empty.".into());
    }
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (existing, revision, existing_plain, existing_title): (String, i32, String, String) =
        transaction
            .query_row(
                "SELECT content, revision, content_plain, title FROM lectures WHERE id=?1",
                [&input.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|error| error.to_string())?;
    let changed = existing != input.content || existing_title != input.title.trim();
    let latest_checkpoint_age: Option<i64> = transaction.query_row("SELECT CAST(strftime('%s','now') - strftime('%s',created_at) AS INTEGER) FROM lecture_revisions WHERE lecture_id=?1 ORDER BY created_at DESC LIMIT 1", [&input.id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    let checkpoint = changed && (input.force_checkpoint || latest_checkpoint_age.is_none_or(|seconds| seconds >= 180));
    let next_revision = if checkpoint { revision + 1 } else { revision };
    transaction.execute("UPDATE lectures SET title=?1, content=?2, content_plain=?3, revision=?4, updated_at=CURRENT_TIMESTAMP WHERE id=?5", params![input.title.trim(), input.content, input.content_plain, next_revision, input.id]).map_err(|error| error.to_string())?;
    if checkpoint {
        transaction.execute("INSERT INTO lecture_revisions (id, lecture_id, title, content, content_plain, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![Uuid::new_v4().to_string(), input.id, existing_title, existing, existing_plain, revision]).map_err(|error| error.to_string())?;
        transaction.execute("DELETE FROM lecture_revisions WHERE id IN (SELECT id FROM lecture_revisions WHERE lecture_id=?1 ORDER BY revision DESC LIMIT -1 OFFSET 200)", [&input.id]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    get_lecture(database, input.id)
}

#[tauri::command]
pub fn record_lecture_note_checkpoint(
    database: State<'_, Database>,
    input: RecordLectureNoteCheckpointInput,
) -> CommandResult<()> {
    if input.content_plain.trim().is_empty() {
        return Ok(());
    }
    let connection = database.open()?;
    let recording = connection.query_row(
        "SELECT state, captured_ms, COALESCE(CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER), 0) FROM lecture_recordings WHERE lecture_id=?1",
        [&input.lecture_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
    ).optional().map_err(|error| error.to_string())?;
    let Some((state, captured_ms, elapsed_ms)) = recording else { return Ok(()) };
    if state != "recording" {
        return Ok(());
    }
    let timestamp_ms = captured_ms.max(elapsed_ms).max(0);
    let latest = connection.query_row(
        "SELECT id, timestamp_ms, content_plain FROM lecture_note_checkpoints WHERE lecture_id=?1 ORDER BY timestamp_ms DESC, created_at DESC LIMIT 1",
        [&input.lecture_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)),
    ).optional().map_err(|error| error.to_string())?;
    if let Some((id, previous_timestamp, previous_plain)) = latest {
        if previous_plain == input.content_plain {
            return Ok(());
        }
        // Keep a meaningful timeline without writing a full document snapshot
        // for every keystroke. The newest change in a short typing burst replaces
        // that burst's checkpoint and remains tied to the right lecture moment.
        if timestamp_ms.saturating_sub(previous_timestamp) < 20_000 {
            connection.execute(
                "UPDATE lecture_note_checkpoints SET timestamp_ms=?1, content=?2, content_plain=?3, created_at=CURRENT_TIMESTAMP WHERE id=?4",
                params![timestamp_ms, input.content, input.content_plain, id],
            ).map_err(|error| error.to_string())?;
            return Ok(());
        }
    }
    connection.execute(
        "INSERT INTO lecture_note_checkpoints (id, lecture_id, timestamp_ms, content, content_plain) VALUES (?1,?2,?3,?4,?5)",
        params![Uuid::new_v4().to_string(), input.lecture_id, timestamp_ms, input.content, input.content_plain],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_lecture(database: State<'_, Database>, id: String) -> CommandResult<()> {
    let changed = database
        .open()?
        .execute("DELETE FROM lectures WHERE id=?1", [&id])
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("That lecture could not be found.".into());
    }
    Ok(())
}

// ---- Lecture recording ----------------------------------------------------
// Audio is written as little-endian 16 kHz mono PCM while recording. This
// makes every short capture chunk independently durable; at the end we stream
// that data into the compact MP3 the user keeps with the lecture.

fn lecture_recordings_dir(database: &Database, lecture_id: &str) -> CommandResult<PathBuf> {
    let directory = database.app_data_dir().join("recordings").join(lecture_id);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn recording_from_row(row: &Row<'_>) -> rusqlite::Result<LectureRecording> {
    Ok(LectureRecording {
        lecture_id: row.get(0)?,
        state: row.get(1)?,
        source_kind: row.get(2)?,
        audio_path: row.get(3)?,
        raw_audio_path: row.get(4)?,
        duration_ms: row.get(5)?,
        captured_ms: row.get(6)?,
        transcribed_ms: row.get(7)?,
        pending_chunks: row.get(8)?,
        status_message: row.get(9)?,
        started_at: row.get(10)?,
        stopped_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn ready_lecture_recording(lecture_id: String) -> LectureRecording {
    LectureRecording {
        lecture_id,
        state: "ready".into(),
        source_kind: "microphone".into(),
        audio_path: None,
        raw_audio_path: None,
        duration_ms: 0,
        captured_ms: 0,
        transcribed_ms: 0,
        pending_chunks: 0,
        status_message: "Ready to record or import audio.".into(),
        started_at: None,
        stopped_at: None,
        updated_at: String::new(),
    }
}

fn get_lecture_recording_from(connection: &Connection, lecture_id: &str) -> CommandResult<LectureRecording> {
    connection.query_row(
        "SELECT lecture_id, state, source_kind, audio_path, raw_audio_path, duration_ms, captured_ms, transcribed_ms, pending_chunks, status_message, started_at, stopped_at, updated_at FROM lecture_recordings WHERE lecture_id=?1",
        [lecture_id],
        recording_from_row,
    ).optional().map_err(|error| error.to_string()).map(|value| value.unwrap_or_else(|| ready_lecture_recording(lecture_id.to_string())))
}

fn update_recording_status(connection: &Connection, lecture_id: &str, state: &str, message: &str) -> CommandResult<()> {
    connection.execute(
        "UPDATE lecture_recordings SET state=?1, status_message=?2, updated_at=CURRENT_TIMESTAMP WHERE lecture_id=?3",
        params![state, message, lecture_id],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn emit_lecture_recording_update(app: &tauri::AppHandle, database: &Database, lecture_id: &str) {
    if let Ok(connection) = database.open() {
        if let Ok(recording) = get_lecture_recording_from(&connection, lecture_id) {
            let _ = app.emit("lecture-recording-update", recording);
        }
    }
}

#[tauri::command]
pub fn get_lecture_recording(database: State<'_, Database>, lecture_id: String) -> CommandResult<LectureRecording> {
    get_lecture_recording_from(&database.open()?, &lecture_id)
}

#[tauri::command]
pub fn list_lecture_transcript_segments(database: State<'_, Database>, lecture_id: String) -> CommandResult<Vec<LectureTranscriptSegment>> {
    let connection = database.open()?;
    let mut statement = connection.prepare(
        "SELECT id, lecture_id, chunk_index, start_ms, end_ms, speaker, text, is_final, created_at FROM lecture_transcript_segments WHERE lecture_id=?1 ORDER BY start_ms, chunk_index, id"
    ).map_err(|error| error.to_string())?;
    let segments = statement.query_map([lecture_id], |row| Ok(LectureTranscriptSegment {
        id: row.get(0)?, lecture_id: row.get(1)?, chunk_index: row.get(2)?, start_ms: row.get(3)?, end_ms: row.get(4)?, speaker: row.get(5)?, text: row.get(6)?, is_final: row.get::<_, i64>(7)? != 0, created_at: row.get(8)?,
    })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(segments)
}

#[tauri::command]
pub fn get_lecture_analysis(database: State<'_, Database>, lecture_id: String) -> CommandResult<Option<LectureAnalysis>> {
    let connection = database.open()?;
    connection.query_row(
        "SELECT lecture_id, status, overview, key_points_json, concepts_json, questions_json, next_steps_json, raw_transcript, cleaned_transcript, detailed_notes, note_suggestions_json, created_at, updated_at FROM lecture_analyses WHERE lecture_id=?1",
        [lecture_id],
        |row| Ok(LectureAnalysis {
            lecture_id: row.get(0)?, status: row.get(1)?, overview: row.get(2)?,
            key_points: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(3)?).unwrap_or_default(),
            concepts: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(4)?).unwrap_or_default(),
            questions: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(5)?).unwrap_or_default(),
            next_steps: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(6)?).unwrap_or_default(),
            raw_transcript: row.get(7)?, cleaned_transcript: row.get(8)?, detailed_notes: row.get(9)?,
            note_suggestions: serde_json::from_str::<Vec<LectureNoteSuggestion>>(&row.get::<_, String>(10)?).unwrap_or_default(),
            created_at: row.get(11)?, updated_at: row.get(12)?,
        })
    ).optional().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn start_lecture_recording(database: State<'_, Database>, lecture_id: String) -> CommandResult<LectureRecording> {
    let connection = database.open()?;
    connection.query_row("SELECT id FROM lectures WHERE id=?1", [&lecture_id], |row| row.get::<_, String>(0))
        .map_err(|_| "That lecture could not be found.".to_string())?;
    let existing = get_lecture_recording_from(&connection, &lecture_id)?;
    let directory = lecture_recordings_dir(&database, &lecture_id)?;
    let raw_path = directory.join("lecture.pcm");
    let audio_path = directory.join("lecture.mp3");
    // An interrupted take is intentionally preserved for recovery. A completed
    // take starts a new recording only after the user deliberately presses Start.
    if !matches!(existing.state.as_str(), "recording" | "interrupted") {
        let _ = fs::remove_file(&raw_path);
        let _ = fs::remove_file(&audio_path);
        connection.execute("DELETE FROM lecture_recording_chunks WHERE lecture_id=?1", [&lecture_id]).map_err(|error| error.to_string())?;
        connection.execute("DELETE FROM lecture_transcript_segments WHERE lecture_id=?1", [&lecture_id]).map_err(|error| error.to_string())?;
        connection.execute("DELETE FROM lecture_analyses WHERE lecture_id=?1", [&lecture_id]).map_err(|error| error.to_string())?;
        connection.execute("DELETE FROM lecture_note_checkpoints WHERE lecture_id=?1", [&lecture_id]).map_err(|error| error.to_string())?;
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&raw_path).map_err(|error| error.to_string())?;
    connection.execute(r#"
        INSERT INTO lecture_recordings (lecture_id, state, source_kind, audio_path, raw_audio_path, sample_rate, duration_ms, captured_ms, transcribed_ms, pending_chunks, status_message, started_at, stopped_at)
        VALUES (?1,'recording','microphone',?2,?3,16000,?4,?4,?5,0,'Recording microphone audio.',CURRENT_TIMESTAMP,NULL)
        ON CONFLICT(lecture_id) DO UPDATE SET state='recording', source_kind='microphone', audio_path=excluded.audio_path, raw_audio_path=excluded.raw_audio_path, status_message='Recording microphone audio.', stopped_at=NULL, updated_at=CURRENT_TIMESTAMP
    "#, params![lecture_id, audio_path.to_string_lossy(), raw_path.to_string_lossy(), if existing.state == "interrupted" { existing.duration_ms } else { 0 }, if existing.state == "interrupted" { existing.transcribed_ms } else { 0 }]).map_err(|error| error.to_string())?;
    get_lecture_recording_from(&connection, &lecture_id)
}

#[tauri::command]
pub fn append_lecture_audio_chunk(
    database: State<'_, Database>,
    lecture_id: String,
    pcm_base64: String,
    duration_ms: i64,
) -> CommandResult<i32> {
    let bytes = BASE64.decode(pcm_base64.as_bytes()).map_err(|_| "SoFlo could not read that microphone audio chunk.".to_string())?;
    if bytes.is_empty() || bytes.len() % 2 != 0 || bytes.len() > 4_000_000 || duration_ms <= 0 || duration_ms > 60_000 {
        return Err("That audio chunk is not valid.".into());
    }
    let connection = database.open()?;
    let recording = get_lecture_recording_from(&connection, &lecture_id)?;
    if recording.state != "recording" {
        return Err("Start a lecture recording before sending microphone audio.".into());
    }
    let raw_path = recording.raw_audio_path.ok_or_else(|| "SoFlo could not find the local recording file.".to_string())?;
    let offset = fs::metadata(&raw_path).map(|metadata| metadata.len() as i64).unwrap_or(0);
    let mut output = std::fs::OpenOptions::new().create(true).append(true).open(&raw_path).map_err(|error| error.to_string())?;
    output.write_all(&bytes).map_err(|error| error.to_string())?;
    output.sync_data().map_err(|error| error.to_string())?;
    let chunk_index: i32 = connection.query_row("SELECT COALESCE(MAX(chunk_index), -1) + 1 FROM lecture_recording_chunks WHERE lecture_id=?1", [&lecture_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let start_ms = recording.captured_ms;
    let end_ms = start_ms + duration_ms;
    connection.execute("INSERT INTO lecture_recording_chunks (lecture_id, chunk_index, start_ms, end_ms, byte_offset, byte_length, state) VALUES (?1,?2,?3,?4,?5,?6,'queued')", params![lecture_id, chunk_index, start_ms, end_ms, offset, bytes.len() as i64]).map_err(|error| error.to_string())?;
    connection.execute("UPDATE lecture_recordings SET duration_ms=?1, captured_ms=?1, pending_chunks=pending_chunks+1, updated_at=CURRENT_TIMESTAMP WHERE lecture_id=?2", params![end_ms, lecture_id]).map_err(|error| error.to_string())?;
    Ok(chunk_index)
}

fn append_imported_pcm_chunk(
    app: &tauri::AppHandle,
    database: &Database,
    connection: &Connection,
    lecture_id: &str,
    raw_path: &Path,
    bytes: &[u8],
    captured_ms: &mut i64,
    next_chunk_index: &mut i32,
) -> CommandResult<()> {
    if bytes.is_empty() { return Ok(()); }
    let offset = fs::metadata(raw_path).map(|metadata| metadata.len() as i64).unwrap_or(0);
    let mut output = fs::OpenOptions::new().create(true).append(true).open(raw_path).map_err(|error| error.to_string())?;
    output.write_all(bytes).map_err(|error| error.to_string())?;
    output.sync_data().map_err(|error| error.to_string())?;
    let duration_ms = ((bytes.len() as i64) * 1000 / (VOICE_SAMPLE_RATE * 2)).max(1);
    let start_ms = *captured_ms;
    *captured_ms += duration_ms;
    connection.execute(
        "INSERT INTO lecture_recording_chunks (lecture_id, chunk_index, start_ms, end_ms, byte_offset, byte_length, state) VALUES (?1,?2,?3,?4,?5,?6,'queued')",
        params![lecture_id, *next_chunk_index, start_ms, *captured_ms, offset, bytes.len() as i64],
    ).map_err(|error| error.to_string())?;
    connection.execute(
        "UPDATE lecture_recordings SET duration_ms=?1, captured_ms=?1, pending_chunks=pending_chunks+1, status_message='Preparing imported audio for transcription…', updated_at=CURRENT_TIMESTAMP WHERE lecture_id=?2",
        params![*captured_ms, lecture_id],
    ).map_err(|error| error.to_string())?;
    emit_lecture_recording_update(app, database, lecture_id);
    *next_chunk_index += 1;
    Ok(())
}

fn decode_imported_audio_to_pcm<F>(
    app: &tauri::AppHandle,
    database: &Database,
    source: &Path,
    destination: &Path,
    connection: &Connection,
    lecture_id: &str,
    queue_chunk: &mut F,
) -> CommandResult<i32>
where
    F: FnMut(i32) -> CommandResult<()>,
{
    let source_file = fs::File::open(source).map_err(|_| "SoFlo could not open that media file.".to_string())?;
    let mut hint = Hint::new();
    if let Some(extension) = source.extension().and_then(|value| value.to_str()) { hint.with_extension(extension); }
    let stream = MediaSourceStream::new(Box::new(source_file), Default::default());
    let mut format = get_probe().probe(&hint, stream, FormatOptions::default(), MetadataOptions::default())
        .map_err(|_| "SoFlo could not read that media format. Try MP3, WAV, M4A, AAC, FLAC, OGG, MP4, MOV, MKV, or WebM with a supported audio track.".to_string())?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| "That file has no playable audio track.".to_string())?;
    let track_id = track.id;
    let mut decoder = get_codecs().make_audio_decoder(
        track.codec_params.as_ref().ok_or_else(|| "That audio track has no usable codec information.".to_string())?.audio().ok_or_else(|| "That file does not contain an audio track SoFlo can decode.".to_string())?,
        &AudioDecoderOptions::default(),
    ).map_err(|_| "SoFlo could not decode that audio format.".to_string())?;
    let _ = fs::remove_file(destination);
    fs::File::create(destination).map_err(|error| error.to_string())?;
    let mut captured_ms = 0i64;
    let mut next_chunk_index = 0i32;
    let mut source_frame_cursor = 0f64;
    let mut next_output_source_frame = 0f64;
    let mut pcm_chunk = Vec::<u8>::with_capacity((VOICE_SAMPLE_RATE as usize) * 2 * 21);
    const CHUNK_BYTES: usize = (VOICE_SAMPLE_RATE as usize) * 2 * (VOICE_CHUNK_TARGET_MS as usize) / 1000;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::IoError(_)) => break,
            Err(SymphoniaError::ResetRequired) => return Err("That audio stream changed format while it was being read.".into()),
            Err(_) => return Err("SoFlo could not continue reading that media file.".into()),
        };
        if packet.track_id != track_id { continue; }
        let decoded = match decoder.decode(&packet) {
            Ok(buffer) => buffer,
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(_) => return Err("SoFlo could not decode the audio track in that media file.".into()),
        };
        let channels = decoded.spec().channels().count().max(1);
        let sample_rate = decoded.spec().rate().max(1) as f64;
        let mut samples = vec![0f32; decoded.samples_interleaved()];
        decoded.copy_to_slice_interleaved(&mut samples);
        let frame_count = samples.len() / channels;
        if frame_count == 0 { continue; }
        let end_source_frame = source_frame_cursor + frame_count as f64;
        while next_output_source_frame < end_source_frame {
            let frame = ((next_output_source_frame - source_frame_cursor).floor().max(0.0) as usize).min(frame_count - 1);
            let start = frame * channels;
            let averaged = samples[start..start + channels].iter().copied().sum::<f32>() / channels as f32;
            let sample = (averaged.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            pcm_chunk.extend_from_slice(&sample.to_le_bytes());
            next_output_source_frame += sample_rate / VOICE_SAMPLE_RATE as f64;
            while pcm_chunk.len() >= CHUNK_BYTES {
                let batch = pcm_chunk.drain(..CHUNK_BYTES).collect::<Vec<_>>();
                let chunk_index = next_chunk_index;
                append_imported_pcm_chunk(app, database, connection, lecture_id, destination, &batch, &mut captured_ms, &mut next_chunk_index)?;
                queue_chunk(chunk_index)?;
            }
        }
        source_frame_cursor = end_source_frame;
    }
    if !pcm_chunk.is_empty() {
        let chunk_index = next_chunk_index;
        append_imported_pcm_chunk(app, database, connection, lecture_id, destination, &pcm_chunk, &mut captured_ms, &mut next_chunk_index)?;
        queue_chunk(chunk_index)?;
    }
    if next_chunk_index == 0 { return Err("SoFlo could not decode usable audio from that file.".into()); }
    Ok(next_chunk_index)
}

fn process_imported_lecture_audio(
    app: tauri::AppHandle,
    database: Database,
    lecture_id: String,
    source_path: String,
    model_path: String,
) -> CommandResult<()> {
    let model_path = resolve_voice_model_path(&app, &model_path)?;
    let source = PathBuf::from(source_path);
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !matches!(extension.as_str(), "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "mp4" | "m4v" | "mov" | "mkv" | "webm") { return Err("Choose a supported audio or video file (MP3, WAV, M4A, AAC, FLAC, OGG, MP4, MOV, MKV, or WebM).".into()); }
    if !source.is_file() { return Err("That audio or video file is no longer available.".into()); }
    let connection = database.open()?;
    connection.query_row("SELECT id FROM lectures WHERE id=?1", [&lecture_id], |row| row.get::<_, String>(0)).map_err(|_| "That lecture could not be found.".to_string())?;
    let directory = lecture_recordings_dir(&database, &lecture_id)?;
    let raw_path = directory.join("lecture.pcm");
    let audio_path = directory.join("lecture.mp3");
    let source_copy = directory.join(format!("imported-source.{}", extension));
    let _ = fs::remove_file(&raw_path);
    let _ = fs::remove_file(&audio_path);
    let _ = fs::remove_file(&source_copy);
    connection.execute("DELETE FROM lecture_recording_chunks WHERE lecture_id=?1", [&lecture_id]).map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM lecture_transcript_segments WHERE lecture_id=?1", [&lecture_id]).map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM lecture_analyses WHERE lecture_id=?1", [&lecture_id]).map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM lecture_note_checkpoints WHERE lecture_id=?1", [&lecture_id]).map_err(|error| error.to_string())?;
    fs::copy(&source, &source_copy).map_err(|_| "SoFlo could not copy that media file into your lecture.".to_string())?;
    connection.execute(
        "INSERT INTO lecture_recordings (lecture_id, state, source_kind, audio_path, raw_audio_path, sample_rate, duration_ms, captured_ms, transcribed_ms, pending_chunks, status_message, started_at, stopped_at) VALUES (?1,'transcribing','import',?2,?3,16000,0,0,0,0,'Preparing imported audio…',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(lecture_id) DO UPDATE SET state='transcribing', source_kind='import', audio_path=excluded.audio_path, raw_audio_path=excluded.raw_audio_path, duration_ms=0, captured_ms=0, transcribed_ms=0, pending_chunks=0, status_message=excluded.status_message, started_at=CURRENT_TIMESTAMP, stopped_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP",
        params![lecture_id, audio_path.to_string_lossy(), raw_path.to_string_lossy()],
    ).map_err(|error| error.to_string())?;
    // Build the complete chunk index before transcription starts. The importer
    // owns this SQLite connection while it writes that index; sending chunks to
    // the worker immediately made large imports contend for the same library.
    let mut imported_chunks = Vec::new();
    let mut collect_chunk = |chunk_index| {
        imported_chunks.push(chunk_index);
        Ok(())
    };
    let _chunks = decode_imported_audio_to_pcm(&app, &database, &source_copy, &raw_path, &connection, &lecture_id, &mut collect_chunk)?;
    connection.execute("UPDATE lecture_recordings SET state='queued', status_message='Transcribing imported lecture…', updated_at=CURRENT_TIMESTAMP WHERE lecture_id=?1", [&lecture_id]).map_err(|error| error.to_string())?;
    drop(connection);
    for chunk_index in imported_chunks {
        voice_job_sender().send(VoiceTranscriptionJob {
            app: app.clone(),
            database: database.clone(),
            lecture_id: lecture_id.clone(),
            chunk_index,
            model_path: model_path.clone(),
            finalize: false,
        }).map_err(|_| "SoFlo's transcription worker is unavailable.".to_string())?;
    }
    voice_job_sender().send(VoiceTranscriptionJob { app: app.clone(), database: database.clone(), lecture_id: lecture_id.clone(), chunk_index: -1, model_path, finalize: true }).map_err(|_| "SoFlo's transcription worker is unavailable.".to_string())?;
    emit_lecture_recording_update(&app, &database, &lecture_id);
    Ok(())
}

#[tauri::command]
pub fn import_lecture_audio(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    lecture_id: String,
    source_path: String,
    model_path: String,
) -> CommandResult<()> {
    let model_path = resolve_voice_model_path(&app, &model_path)?;
    let source = PathBuf::from(source_path);
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !matches!(extension.as_str(), "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "mp4" | "m4v" | "mov" | "mkv" | "webm") {
        return Err("Choose a supported audio or video file (MP3, WAV, M4A, AAC, FLAC, OGG, MP4, MOV, MKV, or WebM).".into());
    }
    if !source.is_file() { return Err("That audio or video file is no longer available.".into()); }
    let connection = database.open()?;
    connection.query_row("SELECT id FROM lectures WHERE id=?1", [&lecture_id], |row| row.get::<_, String>(0)).map_err(|_| "That lecture could not be found.".to_string())?;
    connection.execute("INSERT INTO lecture_recordings (lecture_id, state, source_kind, status_message, started_at, stopped_at) VALUES (?1,'importing','import','Importing media in the background',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(lecture_id) DO UPDATE SET state='importing', source_kind='import', status_message='Importing media in the background', updated_at=CURRENT_TIMESTAMP", [&lecture_id]).map_err(|error| error.to_string())?;
    let database_handle = database.inner().clone();
    let thread_app = app.clone();
    let thread_lecture_id = lecture_id.clone();
    thread::Builder::new().name("soflo-lecture-import".into()).spawn(move || {
        let result = process_imported_lecture_audio(thread_app.clone(), database_handle.clone(), thread_lecture_id.clone(), source.to_string_lossy().to_string(), model_path);
        if let Err(error) = result {
            if let Ok(connection) = database_handle.open() {
                let _ = update_recording_status(&connection, &thread_lecture_id, "import_failed", &format!("SoFlo could not import this audio: {}", error));
            }
            emit_lecture_recording_update(&thread_app, &database_handle, &thread_lecture_id);
        }
    }).map_err(|_| "SoFlo could not start the audio import worker.".to_string())?;
    emit_lecture_recording_update(&app, database.inner(), &lecture_id);
    Ok(())
}

#[derive(Clone)]
struct VoiceTranscriptionJob {
    app: tauri::AppHandle,
    database: Database,
    lecture_id: String,
    chunk_index: i32,
    model_path: String,
    finalize: bool,
}

static VOICE_JOB_SENDER: OnceLock<mpsc::Sender<VoiceTranscriptionJob>> = OnceLock::new();

fn voice_job_sender() -> &'static mpsc::Sender<VoiceTranscriptionJob> {
    VOICE_JOB_SENDER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<VoiceTranscriptionJob>();
        thread::Builder::new().name("soflo-voice-transcription".into()).spawn(move || run_voice_jobs(receiver)).expect("could not start SoFlo voice worker");
        sender
    })
}

fn run_voice_jobs(receiver: mpsc::Receiver<VoiceTranscriptionJob>) {
    while let Ok(job) = receiver.recv() {
        // Voice transcription is intentionally independent of General and
        // Writing AI. Modern laptops can run the compact Whisper model beside
        // those features, so do not make a lecture wait behind another task.
        let result = if job.finalize {
            finalize_lecture_recording_job(&job)
        } else {
            transcribe_lecture_chunk(&job)
        };
        if let Err(error) = result {
            if let Ok(connection) = job.database.open() {
                let _ = update_recording_status(&connection, &job.lecture_id, "transcription_failed", &format!("Audio is safe, but transcription needs attention: {}", error));
            }
            emit_lecture_recording_update(&job.app, &job.database, &job.lecture_id);
        }
    }
}

fn write_pcm_wave(path: &Path, pcm: &[u8]) -> CommandResult<()> {
    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
    let byte_rate = (VOICE_SAMPLE_RATE * 2) as u32;
    let block_align = 2u16;
    let data_len = pcm.len() as u32;
    file.write_all(b"RIFF").map_err(|error| error.to_string())?;
    file.write_all(&(36u32 + data_len).to_le_bytes()).map_err(|error| error.to_string())?;
    file.write_all(b"WAVEfmt ").map_err(|error| error.to_string())?;
    file.write_all(&16u32.to_le_bytes()).map_err(|error| error.to_string())?;
    file.write_all(&1u16.to_le_bytes()).map_err(|error| error.to_string())?;
    file.write_all(&1u16.to_le_bytes()).map_err(|error| error.to_string())?;
    file.write_all(&(VOICE_SAMPLE_RATE as u32).to_le_bytes()).map_err(|error| error.to_string())?;
    file.write_all(&byte_rate.to_le_bytes()).map_err(|error| error.to_string())?;
    file.write_all(&block_align.to_le_bytes()).map_err(|error| error.to_string())?;
    file.write_all(&16u16.to_le_bytes()).map_err(|error| error.to_string())?;
    file.write_all(b"data").map_err(|error| error.to_string())?;
    file.write_all(&data_len.to_le_bytes()).map_err(|error| error.to_string())?;
    file.write_all(pcm).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn whisper_cli_path(app: &tauri::AppHandle) -> CommandResult<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|directory| directory.join("resources").join("whisper").join("whisper-cli.exe"));
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("whisper").join("whisper-cli.exe");
    bundled.filter(|path| path.is_file()).or_else(|| development.is_file().then_some(development)).ok_or_else(|| "SoFlo's private transcription helper is missing. Reinstall SoFlo to restore it.".to_string())
}

fn transcript_offset(value: &serde_json::Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str().and_then(|text| {
        let parts = text.replace(',', ".").split(':').map(str::parse::<f64>).collect::<Result<Vec<_>, _>>().ok()?;
        match parts.as_slice() {
            [seconds] => Some((seconds * 1000.0).round() as i64),
            [minutes, seconds] => Some(((minutes * 60.0 + seconds) * 1000.0).round() as i64),
            [hours, minutes, seconds] => Some(((hours * 3600.0 + minutes * 60.0 + seconds) * 1000.0).round() as i64),
            _ => None,
        }
    }))
}

fn transcribe_pcm_with_cli(app: &tauri::AppHandle, model_path: &str, pcm: &[u8], workspace: &Path) -> CommandResult<Vec<(i64, i64, String)>> {
    let input_path = workspace.join("chunk.wav");
    let output_prefix = workspace.join("chunk");
    let json_path = workspace.join("chunk.json");
    let _ = fs::remove_file(&json_path);
    write_pcm_wave(&input_path, pcm)?;
    let mut command = Command::new(whisper_cli_path(app)?);
    command.args(["-m", model_path, "-f", &input_path.to_string_lossy(), "-l", "en", "-oj", "-of", &output_prefix.to_string_lossy(), "-nt"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().map_err(|_| "SoFlo could not start its private transcription helper.".to_string())?;
    if !output.status.success() { return Err("SoFlo's private transcription helper could not read this audio.".into()); }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&json_path).map_err(|_| "SoFlo could not read the local transcription result.".to_string())?).map_err(|_| "SoFlo could not read the local transcription result.".to_string())?;
    let segments = value.get("transcription").or_else(|| value.get("segments")).and_then(|value| value.as_array()).cloned().unwrap_or_default();
    let mut result = Vec::new();
    for item in segments {
        let text = item.get("text").and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
        if text.is_empty() { continue; }
        let offsets = item.get("offsets").unwrap_or(&serde_json::Value::Null);
        let timestamps = item.get("timestamps").unwrap_or(&serde_json::Value::Null);
        let start = offsets.get("from").and_then(transcript_offset).or_else(|| timestamps.get("from").and_then(transcript_offset)).unwrap_or(0);
        let end = offsets.get("to").and_then(transcript_offset).or_else(|| timestamps.get("to").and_then(transcript_offset)).unwrap_or(start);
        result.push((start, end, text));
    }
    Ok(result)
}

fn refresh_lecture_speaker_labels(connection: &Connection, lecture_id: &str) -> CommandResult<()> {
    // whisper.cpp's compact models do not perform genuine voice diarization on
    // mono classroom audio. Keep this deliberately conservative: question-like
    // turns become a neutral secondary speaker, while the sustained majority
    // is only called Professor once it has a meaningful duration advantage.
    let mut statement = connection.prepare("SELECT id, start_ms, end_ms, text FROM lecture_transcript_segments WHERE lecture_id=?1 ORDER BY start_ms, id").map_err(|error| error.to_string())?;
    let segments = statement.query_map([lecture_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?))).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let primary_ms: i64 = segments.iter().filter(|(_, _, _, text)| !text.trim_end().ends_with('?')).map(|(_, start, end, _)| (end - start).max(0)).sum();
    let secondary_ms: i64 = segments.iter().filter(|(_, _, _, text)| text.trim_end().ends_with('?')).map(|(_, start, end, _)| (end - start).max(0)).sum();
    let professor_confident = primary_ms >= 60_000 && primary_ms >= secondary_ms.saturating_mul(3);
    for (id, _start, _end, text) in segments {
        let label = if text.trim_end().ends_with('?') { "Speaker 2" } else if professor_confident { "Professor" } else { "Speaker 1" };
        connection.execute("UPDATE lecture_transcript_segments SET speaker=?1 WHERE id=?2", params![label, id]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn transcribe_lecture_chunk(job: &VoiceTranscriptionJob) -> CommandResult<()> {
    let connection = job.database.open()?;
    let recording = get_lecture_recording_from(&connection, &job.lecture_id)?;
    let chunk: Option<(i64, i64, i64, i64, String)> = connection.query_row(
        "SELECT start_ms, end_ms, byte_offset, byte_length, state FROM lecture_recording_chunks WHERE lecture_id=?1 AND chunk_index=?2",
        params![job.lecture_id, job.chunk_index],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional().map_err(|error| error.to_string())?;
    // A newer import may replace one while old jobs are still waiting in the
    // shared worker queue. Those obsolete chunks should quietly disappear.
    let Some((start_ms, end_ms, byte_offset, byte_length, state)) = chunk else { return Ok(()); };
    if state == "complete" { return Ok(()); }
    update_recording_status(&connection, &job.lecture_id, if recording.state == "recording" { "recording" } else { "transcribing" }, "Transcribing your lecture…")?;
    let raw_path = recording.raw_audio_path.ok_or_else(|| "SoFlo could not find the local recording file.".to_string())?;
    let mut source = fs::File::open(raw_path).map_err(|error| error.to_string())?;
    source.seek(SeekFrom::Start(byte_offset as u64)).map_err(|error| error.to_string())?;
    let mut bytes = vec![0u8; byte_length as usize];
    source.read_exact(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() < 3200 {
        connection.execute("UPDATE lecture_recording_chunks SET state='complete' WHERE lecture_id=?1 AND chunk_index=?2", params![job.lecture_id, job.chunk_index]).map_err(|error| error.to_string())?;
        connection.execute("UPDATE lecture_recordings SET pending_chunks=MAX(0, pending_chunks-1), updated_at=CURRENT_TIMESTAMP WHERE lecture_id=?1", [&job.lecture_id]).map_err(|error| error.to_string())?;
        return Ok(());
    }
    let workspace = lecture_recordings_dir(&job.database, &job.lecture_id)?.join("transcription").join(format!("{:06}", job.chunk_index));
    fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
    let transcribed = transcribe_pcm_with_cli(&job.app, &job.model_path, &bytes, &workspace)?;
    connection.execute("DELETE FROM lecture_transcript_segments WHERE lecture_id=?1 AND chunk_index=?2", params![job.lecture_id, job.chunk_index]).map_err(|error| error.to_string())?;
    for (relative_start, relative_end, text) in transcribed {
        let segment_start = start_ms + relative_start;
        let segment_end = (start_ms + relative_end).min(end_ms);
        connection.execute("INSERT INTO lecture_transcript_segments (id, lecture_id, chunk_index, start_ms, end_ms, speaker, text, is_final) VALUES (?1,?2,?3,?4,?5,'Speaker 1',?6,1)", params![Uuid::new_v4().to_string(), job.lecture_id, job.chunk_index, segment_start, segment_end.max(segment_start), text]).map_err(|error| error.to_string())?;
    }
    refresh_lecture_speaker_labels(&connection, &job.lecture_id)?;
    connection.execute("UPDATE lecture_recording_chunks SET state='complete' WHERE lecture_id=?1 AND chunk_index=?2", params![job.lecture_id, job.chunk_index]).map_err(|error| error.to_string())?;
    connection.execute("UPDATE lecture_recordings SET transcribed_ms=MAX(transcribed_ms, ?1), pending_chunks=MAX(0, pending_chunks-1), status_message='Live transcript is up to date.', updated_at=CURRENT_TIMESTAMP WHERE lecture_id=?2", params![end_ms, job.lecture_id]).map_err(|error| error.to_string())?;
    emit_lecture_recording_update(&job.app, &job.database, &job.lecture_id);
    Ok(())
}

fn discard_lecture_audio(database: &Database, lecture_id: &str) -> CommandResult<()> {
    let directory = lecture_recordings_dir(database, lecture_id)?;
    if directory.exists() {
        fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
    }
    let connection = database.open()?;
    connection.execute("UPDATE lecture_recordings SET audio_path=NULL, raw_audio_path=NULL, updated_at=CURRENT_TIMESTAMP WHERE lecture_id=?1", [lecture_id]).map_err(|error| error.to_string())?;
    Ok(())
}

fn finalize_lecture_recording_job(job: &VoiceTranscriptionJob) -> CommandResult<()> {
    let connection = job.database.open()?;
    let state: Option<String> = connection.query_row("SELECT state FROM lecture_recordings WHERE lecture_id=?1", [&job.lecture_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    let Some(state) = state else { return Ok(()); };
    if !matches!(state.as_str(), "queued" | "transcribing") { return Ok(()); }
    let pending: i64 = connection.query_row("SELECT COUNT(*) FROM lecture_recording_chunks WHERE lecture_id=?1 AND state != 'complete'", [&job.lecture_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    // Ignore stale finalize jobs until the replacement import's chunks finish.
    if pending > 0 { return Ok(()); }
    update_recording_status(&connection, &job.lecture_id, "finalizing", "Transcript complete. Removing temporary audio…")?;
    drop(connection);
    emit_lecture_recording_update(&job.app, &job.database, &job.lecture_id);
    discard_lecture_audio(&job.database, &job.lecture_id)?;
    let connection = job.database.open()?;
    connection.execute("UPDATE lecture_recordings SET state='analyzing', duration_ms=captured_ms, status_message='Preparing lecture analysis…', stopped_at=COALESCE(stopped_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP WHERE lecture_id=?1", [&job.lecture_id]).map_err(|error| error.to_string())?;
    emit_lecture_recording_update(&job.app, &job.database, &job.lecture_id);
    let analysis_result = create_lecture_analysis(&job.app, &job.database, &job.lecture_id);
    let connection = job.database.open()?;
    match analysis_result {
        Ok(()) => update_recording_status(&connection, &job.lecture_id, "complete", "Lecture analysis is ready.")?,
        Err(error) => {
            connection.execute("INSERT INTO lecture_analyses (lecture_id, status) VALUES (?1,'failed') ON CONFLICT(lecture_id) DO UPDATE SET status='failed', updated_at=CURRENT_TIMESTAMP", [&job.lecture_id]).map_err(|failure| failure.to_string())?;
            update_recording_status(&connection, &job.lecture_id, "analysis_failed", &format!("Transcript is ready. Analysis can be retried: {}", error))?
        },
    }
    emit_lecture_recording_update(&job.app, &job.database, &job.lecture_id);
    Ok(())
}

fn clean_lecture_segment(text: &str) -> String {
    // Keep the source wording intact while removing the harmless repetitions and
    // whitespace artifacts that Whisper commonly introduces. The raw transcript
    // is stored separately and remains the audio-adjacent source of truth.
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut words = Vec::new();
    for word in compact.split(' ') {
        if words.last().is_some_and(|previous: &&str| previous.eq_ignore_ascii_case(word)) && word.len() > 2 {
            continue;
        }
        words.push(word);
    }
    words.join(" ").trim().to_string()
}

fn stored_lecture_transcripts(connection: &Connection, lecture_id: &str) -> CommandResult<(String, String)> {
    let mut statement = connection.prepare("SELECT start_ms, end_ms, speaker, text FROM lecture_transcript_segments WHERE lecture_id=?1 ORDER BY start_ms, chunk_index, id").map_err(|error| error.to_string())?;
    let rows = statement.query_map([lecture_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))).map_err(|error| error.to_string())?;
    let mut raw = Vec::new();
    let mut clean = Vec::new();
    for row in rows {
        let (start, end, speaker, text) = row.map_err(|error| error.to_string())?;
        let prefix = format!("[{:02}:{:02}–{:02}:{:02} · {}]", start / 60_000, (start / 1_000) % 60, end / 60_000, (end / 1_000) % 60, speaker);
        raw.push(format!("{} {}", prefix, text.trim()));
        let cleaned = clean_lecture_segment(&text);
        if !cleaned.is_empty() { clean.push(format!("{} {}", prefix, cleaned)); }
    }
    Ok((raw.join("\n"), clean.join("\n")))
}

fn lecture_analysis_context(connection: &Connection, lecture_id: &str) -> CommandResult<String> {
    connection.query_row(
        "SELECT course_code, course_name, lecture_date, title, COALESCE(professor_snapshot, ''), COALESCE(content_plain, '') FROM lectures WHERE id=?1",
        [lecture_id],
        |row| Ok(format!(
            "Course: {} {}\nLecture date: {}\nLecture title: {}\nProfessor: {}\nStudent notes already written: {}",
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?
        )),
    ).map_err(|_| "That lecture could not be found.".to_string())
}

fn lecture_timestamp_label(timestamp_ms: i64) -> String {
    format!("{:02}:{:02}", timestamp_ms.max(0) / 60_000, (timestamp_ms.max(0) / 1_000) % 60)
}

fn compact_lecture_note_timeline(connection: &Connection, lecture_id: &str) -> CommandResult<(String, String)> {
    let latest_notes = connection.query_row(
        "SELECT content_plain FROM lectures WHERE id=?1",
        [lecture_id],
        |row| row.get::<_, String>(0),
    ).map_err(|_| "That lecture could not be found.".to_string())?;
    let mut statement = connection.prepare(
        "SELECT timestamp_ms, content_plain FROM lecture_note_checkpoints WHERE lecture_id=?1 ORDER BY timestamp_ms ASC, created_at ASC"
    ).map_err(|error| error.to_string())?;
    let checkpoints = statement.query_map([lecture_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if checkpoints.is_empty() || latest_notes.trim().is_empty() {
        return Ok((latest_notes, String::new()));
    }
    // Keep moments from the whole class rather than only the very end. A note
    // snapshot can be large, so evenly sample the timeline before giving it to
    // the model. This still preserves first/last changes and caps prompt size.
    let checkpoint_count = checkpoints.len();
    let max_entries = 38usize;
    let stride = (checkpoint_count.div_ceil(max_entries)).max(1);
    let sampled = checkpoints
        .into_iter()
        .enumerate()
        .filter_map(|(index, checkpoint)| {
            (index == 0 || index + 1 == checkpoint_count || index % stride == 0).then_some(checkpoint)
        })
        .collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut prior = String::new();
    for (timestamp_ms, snapshot) in sampled {
        let normalized = snapshot.split_whitespace().collect::<Vec<_>>().join(" ");
        let prior_normalized = prior.split_whitespace().collect::<Vec<_>>().join(" ");
        let changed = normalized.strip_prefix(&prior_normalized).unwrap_or(&normalized).trim();
        prior = snapshot;
        if changed.is_empty() { continue; }
        let mut transcript = connection.prepare(
            "SELECT text FROM lecture_transcript_segments WHERE lecture_id=?1 AND end_ms >= ?2 AND start_ms <= ?3 ORDER BY start_ms ASC LIMIT 10"
        ).map_err(|error| error.to_string())?;
        let nearby = transcript.query_map(params![lecture_id, timestamp_ms.saturating_sub(45_000), timestamp_ms + 90_000], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
            .join(" ");
        entries.push(format!(
            "[{}] STUDENT WROTE: {}\nRELATED LECTURE MOMENT: {}",
            lecture_timestamp_label(timestamp_ms),
            changed.chars().take(900).collect::<String>(),
            nearby.chars().take(1_500).collect::<String>(),
        ));
    }
    Ok((latest_notes, entries.join("\n\n")))
}

fn normalize_note_fragment(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_lecture_markdown_line(value: &str) -> String {
    value.trim()
        .trim_matches('#')
        .trim()
        .trim_start_matches("- ")
        .trim_start_matches("* ")
        .trim_start_matches("• ")
        .replace("**", "")
        .replace("__", "")
        .replace('`', "")
        .trim()
        .to_string()
}

/// Each AI call receives only a portion of a longer lecture. Keep the final
/// document continuous by dropping the repeated document title/divider that a
/// model may add to every chunk. Section headings and all instructional content
/// remain intact.
fn normalize_lecture_notes_part(markdown: &str) -> String {
    markdown
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed == "---" || trimmed.starts_with("# ") {
                None
            } else {
                Some(line.trim_end())
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn lecture_paragraph_node(text: String) -> serde_json::Value {
    serde_json::json!({ "type": "paragraph", "content": [{ "type": "text", "text": text }] })
}

// AI output occasionally arrives as one perfectly valid but exhausting
// paragraph. Keep the source wording while giving the paper sensible reading
// breaks. This applies to any subject, not a specific lecture or example.
fn push_lecture_paragraphs(nodes: &mut Vec<serde_json::Value>, text: String) {
    const TARGET_CHARS: usize = 520;
    const MIN_BREAK_CHARS: usize = 240;
    let mut paragraph = String::new();
    for sentence in text.split_inclusive(|character: char| matches!(character, '.' | '!' | '?')) {
        let sentence = sentence.trim();
        if sentence.is_empty() { continue; }
        let would_exceed_target = !paragraph.is_empty()
            && paragraph.len() + 1 + sentence.len() > TARGET_CHARS;
        if would_exceed_target && paragraph.len() >= MIN_BREAK_CHARS {
            nodes.push(lecture_paragraph_node(std::mem::take(&mut paragraph)));
        }
        if !paragraph.is_empty() { paragraph.push(' '); }
        paragraph.push_str(sentence);
    }
    if !paragraph.trim().is_empty() {
        nodes.push(lecture_paragraph_node(paragraph));
    }
}

fn lecture_code_block_node(lines: Vec<String>) -> Option<serde_json::Value> {
    let text = lines.join("\n").trim_end().to_string();
    (!text.trim().is_empty()).then(|| serde_json::json!({
        "type": "codeBlock",
        "attrs": { "language": "python" },
        "content": [{ "type": "text", "text": text }]
    }))
}

fn flush_lecture_bullets(nodes: &mut Vec<serde_json::Value>, bullets: &mut Vec<String>) {
    if bullets.is_empty() { return; }
    let items = std::mem::take(bullets).into_iter().map(|text| {
        serde_json::json!({ "type": "listItem", "content": [lecture_paragraph_node(text)] })
    }).collect::<Vec<_>>();
    nodes.push(serde_json::json!({ "type": "bulletList", "content": items }));
}

fn lecture_markdown_to_editor_content(markdown: &str) -> String {
    let mut nodes = Vec::new();
    let mut bullets = Vec::new();
    let mut code_lines: Option<Vec<String>> = None;
    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            flush_lecture_bullets(&mut nodes, &mut bullets);
            if let Some(lines) = code_lines.take() {
                if let Some(node) = lecture_code_block_node(lines) { nodes.push(node); }
            } else {
                code_lines = Some(Vec::new());
            }
            continue;
        }
        if let Some(lines) = code_lines.as_mut() {
            lines.push(line.trim_end().to_string());
            continue;
        }
        if trimmed.is_empty() || trimmed == "---" {
            flush_lecture_bullets(&mut nodes, &mut bullets);
            continue;
        }
        let heading = [(3usize, "### "), (2usize, "## "), (1usize, "# ")]
            .iter()
            .find_map(|(level, prefix)| trimmed.strip_prefix(prefix).map(|text| (*level, text)));
        if let Some((level, text)) = heading {
            flush_lecture_bullets(&mut nodes, &mut bullets);
            let text = clean_lecture_markdown_line(text);
            if !text.is_empty() {
                // Lecture titles belong to the lecture itself, not once per AI
                // chunk. Keep imported/generated note sections at H2 or below.
                nodes.push(serde_json::json!({ "type": "heading", "attrs": { "level": level.max(2) }, "content": [{ "type": "text", "text": text }] }));
            }
            continue;
        }
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("• ") {
            let text = clean_lecture_markdown_line(trimmed);
            if !text.is_empty() { bullets.push(text); }
            continue;
        }
        let bold_heading = trimmed.strip_prefix("**").and_then(|text| text.strip_suffix("**"));
        if let Some(text) = bold_heading.filter(|text| !text.contains("**")) {
            flush_lecture_bullets(&mut nodes, &mut bullets);
            let text = clean_lecture_markdown_line(text);
            if !text.is_empty() {
                nodes.push(serde_json::json!({ "type": "heading", "attrs": { "level": 3 }, "content": [{ "type": "text", "text": text }] }));
            }
            continue;
        }
        flush_lecture_bullets(&mut nodes, &mut bullets);
        let text = clean_lecture_markdown_line(trimmed);
        if !text.is_empty() { push_lecture_paragraphs(&mut nodes, text); }
    }
    if let Some(lines) = code_lines.take() {
        if let Some(node) = lecture_code_block_node(lines) { nodes.push(node); }
    }
    flush_lecture_bullets(&mut nodes, &mut bullets);
    if nodes.is_empty() { nodes.push(serde_json::json!({ "type": "paragraph" })); }
    serde_json::json!({ "type": "doc", "content": nodes }).to_string()
}

fn lecture_markdown_to_plain_text(markdown: &str) -> String {
    markdown.lines()
        .filter(|line| !line.trim().starts_with("```"))
        .map(clean_lecture_markdown_line)
        .filter(|line| !line.is_empty() && line != "---")
        .collect::<Vec<_>>()
        .join("\n")
}

fn usable_lecture_notes(value: &str, transcript_part: &str) -> Option<String> {
    let notes = normalize_lecture_notes_part(value);
    let normalized_notes = normalize_note_fragment(&notes);
    let normalized_transcript = normalize_note_fragment(transcript_part);
    if normalized_notes.is_empty() {
        return None;
    }
    // A model occasionally echoes the source when it is interrupted. That is a
    // transcript, not study notes, and must never replace a lecture paper.
    let likely_transcript_echo = normalized_notes.len() >= normalized_transcript.len().saturating_mul(2) / 3
        && normalized_notes.matches(" · ").count() >= 4;
    let timestamp_sections = notes.lines().filter(|line| {
        let line = line.trim();
        (line.starts_with('[') || line.starts_with('#') || line.starts_with("**["))
            && line.contains(':')
            && line.contains("Professor")
    }).count();
    (!likely_transcript_echo && timestamp_sections < 3).then_some(notes)
}

fn fallback_lecture_summary(detailed_notes: &str) -> serde_json::Value {
    let highlights = detailed_notes.lines()
        .map(clean_lecture_markdown_line)
        .filter(|line| line.len() > 18)
        .take(18)
        .collect::<Vec<_>>();
    serde_json::json!({
        "overview": "The complete chronological lecture notes are available below and were also added to this empty lecture paper.",
        "keyPoints": highlights,
        "concepts": [],
        "questions": [],
        "nextSteps": []
    })
}

fn populate_lecture_with_study_notes(database: &Database, lecture_id: &str, detailed_notes: &str, prior_generated_notes: Option<&str>) -> CommandResult<bool> {
    let mut connection = database.open()?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let (title, current_content, current_plain, revision): (String, String, String, i32) = transaction.query_row(
        "SELECT title, content, content_plain, revision FROM lectures WHERE id=?1",
        [lecture_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(|_| "That lecture could not be found.".to_string())?;
    let current_is_prior_generated_notes = prior_generated_notes
        .map(lecture_markdown_to_plain_text)
        .map(|prior_plain| normalize_note_fragment(&prior_plain) == normalize_note_fragment(&current_plain))
        .unwrap_or(false);
    // A regeneration may safely replace the AI-created draft it originally
    // filled. If the student has written or changed anything, leave it alone.
    if !current_plain.trim().is_empty() && !current_is_prior_generated_notes {
        return Ok(false);
    }
    let content = lecture_markdown_to_editor_content(detailed_notes);
    let plain = lecture_markdown_to_plain_text(detailed_notes);
    if plain.is_empty() { return Ok(false); }
    transaction.execute(
        "INSERT INTO lecture_revisions (id, lecture_id, title, content, content_plain, revision, source) VALUES (?1,?2,?3,?4,?5,?6,'user')",
        params![Uuid::new_v4().to_string(), lecture_id, title, current_content, current_plain, revision],
    ).map_err(|error| error.to_string())?;
    transaction.execute(
        "UPDATE lectures SET content=?1, content_plain=?2, revision=?3, updated_at=CURRENT_TIMESTAMP WHERE id=?4",
        params![content, plain, revision + 1, lecture_id],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

fn create_lecture_note_suggestions(
    client: &reqwest::blocking::Client,
    port: u16,
    connection: &Connection,
    lecture_id: &str,
    lecture_context: &str,
    lecture_digest: &str,
) -> CommandResult<Vec<LectureNoteSuggestion>> {
    let (student_notes, timeline) = compact_lecture_note_timeline(connection, lecture_id)?;
    if student_notes.trim().is_empty() {
        return Ok(Vec::new());
    }
    let system = "You create optional, precise additions to a student's live lecture notes. Return only a valid JSON array. Each object must have exactly original, replacement, reason, timestamp, kind. original must be an exact, short excerpt copied from the student's current notes (3 to 35 words). replacement must begin with that exact original text, then naturally add only the missing directly relevant lecture context in the student's concise note-taking voice. Do not rewrite the whole note, create headings, add generic summaries, add unrelated ideas, invent facts, cite sources, or add more than 70 words total to any one suggestion. Examine the full notes and timestamped lecture moments for every supported partial idea; return 12 to 24 distinct useful additions when the material supports them, rather than stopping after a few examples. reason must briefly say what was filled in. timestamp must be the relevant MM:SS moment. kind must be bridge or clarify. Return [] only if no responsible additions are supported.";
    let prompt = format!(
        "LECTURE CONTEXT\n{}\n\nCURRENT STUDENT NOTES\n{}\n\nTIMESTAMPED NOTE MOMENTS\n{}\n\nLECTURE GUIDE\n{}",
        lecture_context,
        student_notes.chars().take(28_000).collect::<String>(),
        timeline.chars().take(30_000).collect::<String>(),
        lecture_digest.chars().take(24_000).collect::<String>(),
    );
    let output = local_chat_text(client, port, system, &prompt, 4_200)?;
    let json = json_array_from_response(&output).ok_or_else(|| "The local AI model returned unreadable lecture-note suggestions.".to_string())?;
    let suggestions = serde_json::from_str::<Vec<LectureNoteSuggestion>>(&json).map_err(|_| "The local AI model returned unreadable lecture-note suggestions.".to_string())?;
    let normalized_notes = normalize_note_fragment(&student_notes).to_lowercase();
    let mut seen = HashSet::new();
    Ok(suggestions.into_iter().filter_map(|suggestion| {
        let original = suggestion.original.trim().to_string();
        let replacement = suggestion.replacement.trim().to_string();
        let normalized_original = normalize_note_fragment(&original);
        let normalized_replacement = normalize_note_fragment(&replacement);
        let original_words = normalized_original.split_whitespace().count();
        let replacement_words = normalized_replacement.split_whitespace().count();
        let valid = original_words >= 3
            && original_words <= 35
            && replacement_words > original_words
            && replacement_words <= 70
            && original.len() <= 360
            && replacement.len() <= 760
            && normalized_notes.contains(&normalized_original.to_lowercase())
            && normalized_replacement.to_lowercase().starts_with(&normalized_original.to_lowercase())
            && matches!(suggestion.kind.trim().to_lowercase().as_str(), "bridge" | "clarify");
        if !valid || !seen.insert(normalized_original.to_lowercase()) { return None; }
        Some(LectureNoteSuggestion {
            original,
            replacement,
            reason: suggestion.reason.trim().chars().take(280).collect(),
            timestamp: suggestion.timestamp.trim().chars().take(12).collect(),
            kind: suggestion.kind.trim().to_lowercase(),
        })
    }).take(24).collect())
}

fn create_lecture_analysis(app: &tauri::AppHandle, database: &Database, lecture_id: &str) -> CommandResult<()> {
    let connection = database.open()?;
    let settings = get_settings(&connection, None)?;
    if !settings.ai_enabled || settings.ai_model_path.trim().is_empty() {
        return Err("Enable General AI to create the lecture analysis.".into());
    }
    let model_path = resolve_ai_model_path(app, &settings.ai_model_path)?;
    let (raw_transcript, cleaned_transcript) = stored_lecture_transcripts(&connection, lecture_id)?;
    let lecture_context = lecture_analysis_context(&connection, lecture_id)?;
    let prior_detailed_notes: Option<String> = connection
        .query_row(
            "SELECT detailed_notes FROM lecture_analyses WHERE lecture_id=?1",
            [lecture_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if cleaned_transcript.trim().is_empty() { return Err("There is no transcript to analyze yet.".into()); }
    connection.execute("INSERT INTO lecture_analyses (lecture_id, status, raw_transcript, cleaned_transcript) VALUES (?1,'analyzing',?2,?3) ON CONFLICT(lecture_id) DO UPDATE SET status='analyzing', raw_transcript=excluded.raw_transcript, cleaned_transcript=excluded.cleaned_transcript, updated_at=CURRENT_TIMESTAMP", params![lecture_id, raw_transcript, cleaned_transcript]).map_err(|error| error.to_string())?;
    let port = ensure_ai_server(&model_path, app)?;
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(150)).build().map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    let chunks = split_source_for_ai(&cleaned_transcript, AI_SOURCE_CHUNK_CHARS);
    let mut notes = Vec::with_capacity(chunks.len());
    for (index, chunk) in chunks.iter().enumerate() {
        let progress_connection = database.open()?;
        update_recording_status(&progress_connection, lecture_id, "analyzing", &format!("Building detailed study notes: part {} of {}...", index + 1, chunks.len()))?;
        emit_lecture_recording_update(app, database, lecture_id);
        let system = "You are SoFlo's meticulous lecture note-taker. Turn this chronological portion of one lecture into dense, complete study notes that a student could rely on instead of rewatching it. Preserve every academic detail: definitions, reasoning, worked examples, code or procedure steps, corrections, instructor emphasis, questions and answers, cautions, assignments, due dates, and next-class previews. Keep the order of the lecture. Compress verbal filler only; do not omit meaningful instructional content, and do not invent anything. This is one continuation inside a larger note document: do not add a document title, an H1 heading, a divider, timestamp, speaker label, or a recap of an earlier part. Do not turn every spoken moment into a section; merge related material into a few clear conceptual sections. Return structured Markdown only: use H2 for main topics, H3 for subtopics, concise paragraphs and bullets for explanation, and fenced ```python code blocks for every Python example. Never put code in ordinary prose.";
        let prompt = format!("LECTURE CONTEXT\n{}\n\nLECTURE PART {} OF {} — continue directly from the prior part when applicable.\n\n{}", lecture_context, index + 1, chunks.len(), chunk);
        let note = local_chat_text(&client, port, system, &prompt, 2_000)
            .ok()
            .and_then(|value| usable_lecture_notes(&value, chunk));
        // A retry gives a temporarily busy local model a shorter, simpler
        // instruction before we mark analysis as failed. We never substitute
        // the raw transcript for an AI note draft.
        let note = note.or_else(|| {
            let retry_system = "Create structured study notes from this lecture excerpt. Use H2/H3 headings, short paragraphs, and bullets. Put Python examples only in fenced ```python code blocks. Do not include timestamps, speaker labels, a title, a divider, or raw transcript text.";
            local_chat_text(&client, port, retry_system, &prompt, 1_400)
                .ok()
                .and_then(|value| usable_lecture_notes(&value, chunk))
        }).ok_or_else(|| format!("SoFlo could not turn lecture part {} into study notes. Your existing lecture paper was left unchanged.", index + 1))?;
        notes.push(note);
    }
    let detailed_notes = notes.join("\n\n");
    let digest_chunks = split_source_for_ai(&detailed_notes, AI_SOURCE_CHUNK_CHARS * 2);
    let mut digest_parts = Vec::with_capacity(digest_chunks.len());
    for (index, chunk) in digest_chunks.iter().enumerate() {
        let progress_connection = database.open()?;
        update_recording_status(&progress_connection, lecture_id, "analyzing", &format!("Organizing your lecture guide: section {} of {}...", index + 1, digest_chunks.len()))?;
        emit_lecture_recording_update(app, database, lecture_id);
        let system = "You are SoFlo's lecture analyst. Condense these detailed chronological study notes into a faithful sectional digest for a final course guide. Preserve all concrete facts, definitions, examples, assignments, questions, and cautions. Do not invent or remove meaningful academic content.";
        let prompt = format!("LECTURE CONTEXT\n{}\n\nDETAILED NOTES SECTION {} OF {}\n\n{}", lecture_context, index + 1, digest_chunks.len(), chunk);
        let digest = local_chat_text(&client, port, system, &prompt, 1_200)
            .ok()
            .filter(|digest| !digest.trim().is_empty())
            .unwrap_or_else(|| chunk.to_string());
        digest_parts.push(digest);
    }
    let synthesis = digest_parts.join("\n\n");
    let system = "You are SoFlo's lecture analyst. Using every supplied lecture digest, return exactly one valid JSON object with keys overview, keyPoints, concepts, questions, nextSteps. Make the overview a helpful multi-sentence explanation rather than a one-line summary. The other keys are arrays with as many useful entries as the lecture supports. Preserve all assignments, dates, names, examples, corrections, and uncertainty. Never invent sources or information not present in the lecture.";
    let output = local_chat_text(&client, port, system, &format!("LECTURE CONTEXT\n{}\n\nCreate a complete course-ready lecture guide from these chronological digests:\n\n{}", lecture_context, synthesis), 3_200).unwrap_or_default();
    let value: serde_json::Value = json_object_from_response(&output)
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_else(|| fallback_lecture_summary(&detailed_notes));
    let array = |key: &str| value.get(key).and_then(|item| item.as_array()).map(|items| items.iter().filter_map(|item| item.as_str().map(|text| text.trim().to_string())).filter(|text| !text.is_empty()).take(36).collect::<Vec<_>>()).unwrap_or_default();
    let progress_connection = database.open()?;
    update_recording_status(&progress_connection, lecture_id, "analyzing", "Finding optional additions for your own notes...")?;
    emit_lecture_recording_update(app, database, lecture_id);
    let note_suggestions = create_lecture_note_suggestions(&client, port, &progress_connection, lecture_id, &lecture_context, &detailed_notes).unwrap_or_default();
    let auto_filled_lecture = populate_lecture_with_study_notes(database, lecture_id, &detailed_notes, prior_detailed_notes.as_deref())?;
    let connection = database.open()?;
    connection.execute("UPDATE lecture_analyses SET status='complete', overview=?1, key_points_json=?2, concepts_json=?3, questions_json=?4, next_steps_json=?5, detailed_notes=?6, note_suggestions_json=?7, updated_at=CURRENT_TIMESTAMP WHERE lecture_id=?8", params![value.get("overview").and_then(|item| item.as_str()).unwrap_or_default().trim(), serde_json::to_string(&array("keyPoints")).unwrap_or_else(|_| "[]".into()), serde_json::to_string(&array("concepts")).unwrap_or_else(|_| "[]".into()), serde_json::to_string(&array("questions")).unwrap_or_else(|_| "[]".into()), serde_json::to_string(&array("nextSteps")).unwrap_or_else(|_| "[]".into()), detailed_notes, serde_json::to_string(&note_suggestions).unwrap_or_else(|_| "[]".into()), lecture_id]).map_err(|error| error.to_string())?;
    touch_ai_server();
    if auto_filled_lecture {
        let _ = app.emit("lecture-content-updated", lecture_id.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn retry_lecture_analysis(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    lecture_id: String,
) -> CommandResult<()> {
    let connection = database.open()?;
    let recording = get_lecture_recording_from(&connection, &lecture_id)?;
    if !matches!(recording.state.as_str(), "complete" | "analysis_failed") {
        return Err("Finish the lecture transcript before retrying the analysis.".into());
    }
    update_recording_status(&connection, &lecture_id, "analyzing", "Preparing lecture analysis…")?;
    let database_handle = database.inner().clone();
    let thread_app = app.clone();
    let thread_lecture_id = lecture_id.clone();
    thread::spawn(move || {
        let result = create_lecture_analysis(&thread_app, &database_handle, &thread_lecture_id);
        if let Ok(connection) = database_handle.open() {
            let message = match result {
                Ok(()) => ("complete", "Lecture analysis is ready.".to_string()),
                Err(error) => ("analysis_failed", format!("Recording and transcript are ready, but analysis needs another try: {}", error)),
            };
            let _ = update_recording_status(&connection, &thread_lecture_id, message.0, &message.1);
        }
        emit_lecture_recording_update(&thread_app, &database_handle, &thread_lecture_id);
    });
    emit_lecture_recording_update(&app, database.inner(), &lecture_id);
    Ok(())
}

#[tauri::command]
pub fn queue_lecture_transcription(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    lecture_id: String,
    chunk_index: i32,
    model_path: String,
) -> CommandResult<()> {
    let model_path = resolve_voice_model_path(&app, &model_path)?;
    voice_job_sender().send(VoiceTranscriptionJob { app, database: database.inner().clone(), lecture_id, chunk_index, model_path, finalize: false }).map_err(|_| "SoFlo's transcription worker is unavailable.".to_string())
}

#[tauri::command]
pub fn finish_lecture_recording(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    lecture_id: String,
    model_path: String,
) -> CommandResult<()> {
    let model_path = resolve_voice_model_path(&app, &model_path)?;
    let connection = database.open()?;
    let recording = get_lecture_recording_from(&connection, &lecture_id)?;
    if !matches!(recording.state.as_str(), "recording" | "interrupted" | "queued") { return Err("There is no active lecture recording to finish.".into()); }
    connection.execute("UPDATE lecture_recordings SET state='queued', status_message='Finishing the recording after the remaining transcript chunks.', stopped_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE lecture_id=?1", [&lecture_id]).map_err(|error| error.to_string())?;
    let mut statement = connection.prepare("SELECT chunk_index FROM lecture_recording_chunks WHERE lecture_id=?1 AND state != 'complete' ORDER BY chunk_index").map_err(|error| error.to_string())?;
    let pending = statement.query_map([&lecture_id], |row| row.get::<_, i32>(0)).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    for chunk_index in pending {
        voice_job_sender().send(VoiceTranscriptionJob { app: app.clone(), database: database.inner().clone(), lecture_id: lecture_id.clone(), chunk_index, model_path: model_path.clone(), finalize: false }).map_err(|_| "SoFlo's transcription worker is unavailable.".to_string())?;
    }
    voice_job_sender().send(VoiceTranscriptionJob { app, database: database.inner().clone(), lecture_id, chunk_index: -1, model_path, finalize: true }).map_err(|_| "SoFlo's transcription worker is unavailable.".to_string())
}

#[tauri::command]
pub fn recover_interrupted_lecture_recordings(database: State<'_, Database>) -> CommandResult<Vec<LectureRecording>> {
    let connection = database.open()?;
    connection.execute("UPDATE lecture_recordings SET state='interrupted', status_message=CASE WHEN source_kind='import' THEN 'Audio import was interrupted. The prepared audio is saved and can be finished.' ELSE 'Recording was interrupted. You can continue or finish the saved audio.' END, updated_at=CURRENT_TIMESTAMP WHERE state IN ('recording','importing','transcribing','queued','finalizing','analyzing')", []).map_err(|error| error.to_string())?;
    let mut statement = connection.prepare("SELECT lecture_id, state, source_kind, audio_path, raw_audio_path, duration_ms, captured_ms, transcribed_ms, pending_chunks, status_message, started_at, stopped_at, updated_at FROM lecture_recordings WHERE state='interrupted' ORDER BY updated_at DESC").map_err(|error| error.to_string())?;
    let recordings = statement.query_map([], recording_from_row).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(recordings)
}

#[tauri::command]
pub fn save_document(
    database: State<'_, Database>,
    input: SaveDocumentInput,
) -> CommandResult<DocumentDetail> {
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (existing, revision, existing_plain, existing_title): (String, i32, String, String) =
        transaction
            .query_row(
                "SELECT content, revision, content_plain, title FROM documents WHERE id=?1",
                [&input.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|error| error.to_string())?;
    let changed = existing != input.content || existing_title != input.title.trim();
    let latest_checkpoint_age: Option<i64> = transaction.query_row("SELECT CAST(strftime('%s','now') - strftime('%s',created_at) AS INTEGER) FROM document_revisions WHERE document_id=?1 ORDER BY created_at DESC LIMIT 1", [&input.id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    let checkpoint = changed && latest_checkpoint_age.is_none_or(|seconds| seconds >= 180);
    let next_revision = if checkpoint { revision + 1 } else { revision };
    transaction.execute("UPDATE documents SET title=?1, content=?2, content_plain=?3, is_favorite=?4, revision=?5, updated_at=CURRENT_TIMESTAMP WHERE id=?6", params![input.title.trim(), input.content, input.content_plain, input.is_favorite as i32, next_revision, input.id]).map_err(|error| error.to_string())?;
    if checkpoint {
        transaction.execute("INSERT INTO document_revisions (id, document_id, title, content, content_plain, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![Uuid::new_v4().to_string(), input.id, existing_title, existing, existing_plain, revision]).map_err(|error| error.to_string())?;
        transaction.execute("DELETE FROM document_revisions WHERE id IN (SELECT id FROM document_revisions WHERE document_id=?1 ORDER BY revision DESC LIMIT -1 OFFSET 200)", [&input.id]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    get_document(database, input.id)
}

#[tauri::command]
pub fn set_document_deleted(
    database: State<'_, Database>,
    id: String,
    deleted: bool,
) -> CommandResult<()> {
    let connection = database.open()?;
    let value = if deleted { "CURRENT_TIMESTAMP" } else { "NULL" };
    connection
        .execute(
            &format!(
                "UPDATE documents SET deleted_at={}, updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                value
            ),
            [&id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn duplicate_document(
    database: State<'_, Database>,
    id: String,
    title: Option<String>,
) -> CommandResult<DocumentDetail> {
    let connection = database.open()?;
    let source = connection
        .query_row(
            "SELECT class_id, title, content, content_plain FROM documents WHERE id=?1",
            [&id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let copy_id = Uuid::new_v4().to_string();
    let copy_title = title
        .unwrap_or_else(|| format!("{} copy", source.1))
        .trim()
        .to_string();
    if copy_title.is_empty() {
        return Err("Give the duplicate a paper name.".into());
    }
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE class_id=?1 AND deleted_at IS NULL AND lower(title)=lower(?2))", params![source.0, copy_title], |row| row.get(0)).map_err(|error| error.to_string())?;
    if exists {
        return Err("A paper with that name already exists in this class.".into());
    }
    connection.execute("INSERT INTO documents (id, class_id, title, content, content_plain) VALUES (?1,?2,?3,?4,?5)", params![copy_id, source.0, copy_title, source.2, source.3]).map_err(|error| error.to_string())?;
    connection.query_row("SELECT id, class_id, title, content, content_plain, is_favorite, revision, created_at, updated_at, deleted_at, is_syllabus, folder_id, linked_pdf_path FROM documents WHERE id=?1", [&copy_id], read_document).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn rename_documents(
    database: State<'_, Database>,
    input: RenameDocumentsInput,
) -> CommandResult<()> {
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for document in input.documents {
        let title = document.title.trim();
        if title.is_empty() {
            return Err("Paper names cannot be empty.".into());
        }
        transaction.execute("UPDATE documents SET title=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2 AND is_syllabus=0", params![title, document.id]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_document_pdf_link(
    database: State<'_, Database>,
    id: String,
    path: Option<String>,
) -> CommandResult<()> {
    let connection = database.open()?;
    connection
        .execute(
            "UPDATE documents SET linked_pdf_path=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
            params![path, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_document_folders(
    database: State<'_, Database>,
    class_id: String,
) -> CommandResult<Vec<DocumentFolder>> {
    let connection = database.open()?;
    let mut statement = connection
        .prepare("SELECT id, class_id, title FROM document_folders WHERE class_id=?1 ORDER BY created_at")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([class_id], |row| {
            Ok(DocumentFolder {
                id: row.get(0)?,
                class_id: row.get(1)?,
                title: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn rename_document_folder(
    database: State<'_, Database>,
    id: String,
    title: String,
) -> CommandResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err("A paper group needs a name.".into());
    }
    if title.chars().count() > 120 {
        return Err("Paper group names can be up to 120 characters.".into());
    }
    let changed = database
        .open()?
        .execute(
            "UPDATE document_folders SET title=?1 WHERE id=?2",
            params![title, id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("That paper group is no longer available.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn group_documents(
    database: State<'_, Database>,
    id: String,
    target_id: String,
) -> CommandResult<()> {
    if id == target_id {
        return Ok(());
    }
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let source: (String, Option<String>) = transaction.query_row("SELECT class_id, folder_id FROM documents WHERE id=?1 AND deleted_at IS NULL AND is_syllabus=0", [&id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|_| "That paper is no longer available.".to_string())?;
    let target: (String, Option<String>) = transaction.query_row("SELECT class_id, folder_id FROM documents WHERE id=?1 AND deleted_at IS NULL AND is_syllabus=0", [&target_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|_| "Choose another paper to make a group.".to_string())?;
    if source.0 != target.0 {
        return Err("Paper groups can only contain papers from the same class.".into());
    }
    let folder_id = target
        .1
        .or(source.1)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    transaction.execute("INSERT OR IGNORE INTO document_folders (id, class_id, title) VALUES (?1,?2,'Paper group')", params![folder_id, source.0]).map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE documents SET folder_id=?1, updated_at=CURRENT_TIMESTAMP WHERE id IN (?2,?3)",
            params![folder_id, id, target_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_document_from_folder(database: State<'_, Database>, id: String) -> CommandResult<()> {
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let folder_id: Option<String> = transaction
        .query_row(
            "SELECT folder_id FROM documents WHERE id=?1",
            [&id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let Some(folder_id) = folder_id else {
        return Ok(());
    };
    transaction
        .execute(
            "UPDATE documents SET folder_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            [&id],
        )
        .map_err(|error| error.to_string())?;
    let remaining: i32 = transaction
        .query_row(
            "SELECT COUNT(*) FROM documents WHERE folder_id=?1 AND deleted_at IS NULL",
            [&folder_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if remaining < 2 {
        transaction
            .execute(
                "UPDATE documents SET folder_id=NULL WHERE folder_id=?1",
                [&folder_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM document_folders WHERE id=?1", [&folder_id])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn move_document(
    database: State<'_, Database>,
    id: String,
    class_id: String,
) -> CommandResult<()> {
    database
        .open()?
        .execute(
            "UPDATE documents SET class_id=?1, updated_at=CURRENT_TIMESTAMP WHERE id=?2",
            params![class_id, id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_flashcard_sets(
    database: State<'_, Database>,
    class_id: String,
    include_deleted: bool,
) -> CommandResult<Vec<FlashcardSetSummary>> {
    let connection = database.open()?;
    purge_expired_trash(&connection)?;
    let mut statement = connection.prepare("SELECT s.id, s.class_id, s.title, s.description, COUNT(c.id), s.updated_at, s.deleted_at FROM flashcard_sets s LEFT JOIN flashcards c ON c.set_id=s.id WHERE s.class_id=?1 AND s.is_study_web_private=0 AND (?2=1 OR s.deleted_at IS NULL) GROUP BY s.id ORDER BY s.updated_at DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![class_id, include_deleted as i32], read_set_summary)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_flashcard_set(
    database: State<'_, Database>,
    input: CreateFlashcardSetInput,
) -> CommandResult<FlashcardSetDetail> {
    let connection = database.open()?;
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO flashcard_sets (id, class_id, title, description) VALUES (?1, ?2, ?3, ?4)",
            params![id, input.class_id, input.title.trim(), input.description],
        )
        .map_err(|error| error.to_string())?;
    get_flashcard_set(database, id)
}

#[tauri::command]
pub fn get_flashcard_set(
    database: State<'_, Database>,
    id: String,
) -> CommandResult<FlashcardSetDetail> {
    let connection = database.open()?;
    let (id, class_id, title, description, updated_at): (
        String,
        String,
        String,
        Option<String>,
        String,
    ) = connection
        .query_row(
            "SELECT id, class_id, title, description, updated_at FROM flashcard_sets WHERE id=?1",
            [&id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let mut statement = connection.prepare("SELECT id, set_id, front, back, notes, image_path, position, is_starred, created_at, updated_at FROM flashcards WHERE set_id=?1 ORDER BY position ASC, created_at ASC").map_err(|error| error.to_string())?;
    let cards = statement
        .query_map([&id], read_card)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut progress_statement = connection.prepare("SELECT card_id, mastery, correct_count, incorrect_count, consecutive_correct, last_seen_at, due_at FROM card_progress WHERE card_id IN (SELECT id FROM flashcards WHERE set_id=?1)").map_err(|error| error.to_string())?;
    let progress = progress_statement
        .query_map([&id], read_card_progress)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(FlashcardSetDetail {
        id,
        class_id,
        title,
        description,
        cards,
        progress,
        updated_at,
    })
}

#[tauri::command]
pub fn save_flashcard_set(
    database: State<'_, Database>,
    input: SaveFlashcardSetInput,
) -> CommandResult<FlashcardSetDetail> {
    database.open()?.execute("UPDATE flashcard_sets SET title=?1, description=?2, updated_at=CURRENT_TIMESTAMP WHERE id=?3", params![input.title.trim(), input.description, input.id]).map_err(|error| error.to_string())?;
    get_flashcard_set(database, input.id)
}

#[tauri::command]
pub fn set_flashcard_set_deleted(
    database: State<'_, Database>,
    id: String,
    deleted: bool,
) -> CommandResult<()> {
    let value = if deleted { "CURRENT_TIMESTAMP" } else { "NULL" };
    database
        .open()?
        .execute(
            &format!(
                "UPDATE flashcard_sets SET deleted_at={}, updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                value
            ),
            [&id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn flashcard_export_cell(value: &str) -> String {
    value
        .replace(['\t', '\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn flashcard_export_filename(title: &str) -> String {
    let name: String = title
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == ' '
                || character == '-'
                || character == '_'
            {
                character
            } else {
                '_'
            }
        })
        .collect();
    let name = name.trim_matches([' ', '_', '-']);
    if name.is_empty() {
        "SoFlo flashcards".into()
    } else {
        format!("SoFlo flashcards - {}", name)
    }
}

#[tauri::command]
pub fn export_flashcard_set_text(
    database: State<'_, Database>,
    set_id: String,
) -> CommandResult<String> {
    let set = get_flashcard_set(database, set_id)?;
    let download_dir = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?)
        .join("Downloads");
    fs::create_dir_all(&download_dir).map_err(|error| error.to_string())?;
    let path = download_dir.join(format!("{}.txt", flashcard_export_filename(&set.title)));
    let content = set
        .cards
        .iter()
        .map(|card| {
            format!(
                "{}\t{}",
                flashcard_export_cell(&card.front),
                flashcard_export_cell(&card.back)
            )
        })
        .collect::<Vec<_>>()
        .join("\r\n");
    fs::write(&path, content).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_text_file(path: String) -> CommandResult<String> {
    let source = PathBuf::from(path);
    if !source
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
    {
        return Err("Choose a .txt file to import flashcards.".into());
    }
    fs::read_to_string(&source)
        .map(|content| content.trim_start_matches('\u{feff}').to_string())
        .map_err(|_| "SoFlo could not read that text file.".into())
}

fn local_chat_json_object(
    client: &reqwest::blocking::Client,
    port: u16,
    system: &str,
    prompt: &str,
    max_tokens: u16,
) -> CommandResult<String> {
    let response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", port))
        .json(&serde_json::json!({
            "messages": [{"role":"system","content":system},{"role":"user","content":prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.1,
            "response_format": {"type":"json_object"},
            "stream": false
        }))
        .send()
        .map_err(|error| format!("SoFlo's local AI model did not respond: {}", error))?
        .error_for_status()
        .map_err(|error| format!("SoFlo's local AI model could not create the calendar: {}", error))?;
    let body: serde_json::Value = response
        .json()
        .map_err(|_| "SoFlo could not read the local AI response.".to_string())?;
    Ok(body
        .get("choices")
        .and_then(|value| value.get(0))
        .and_then(|value| value.get("message"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string())
}

fn fragmented_pdf_spacing_stats(text: &str) -> (usize, usize) {
    let words = text
        .split_whitespace()
        .filter(|word| word.chars().any(char::is_alphabetic))
        .collect::<Vec<_>>();
    let fragments = words
        .windows(2)
        .filter(|pair| {
            pair.iter().all(|word| {
                let letters = word.chars().filter(|character| character.is_alphabetic()).count();
                letters >= 2 && letters <= 3 && word.chars().all(|character| character.is_alphabetic())
            })
        })
        .count();
    (words.len(), fragments)
}

fn has_fragmented_pdf_spacing(text: &str) -> bool {
    let (word_count, fragments) = fragmented_pdf_spacing_stats(text);
    word_count >= 24 && fragments >= 8 && fragments.saturating_mul(12) >= word_count
}

fn repairs_fragmented_pdf_spacing(source: &str, formatted: &str) -> bool {
    let (_, original_fragments) = fragmented_pdf_spacing_stats(source);
    let (_, formatted_fragments) = fragmented_pdf_spacing_stats(formatted);
    original_fragments > 0 && formatted_fragments.saturating_mul(3) <= original_fragments
}

fn read_course_calendar_detail(connection: &Connection, class_id: &str) -> CommandResult<CourseCalendarDetail> {
    let mut sources = connection.prepare("SELECT id, class_id, title, content_plain, source_path, created_at FROM course_calendar_sources WHERE class_id=?1 ORDER BY created_at DESC").map_err(|error| error.to_string())?;
    let sources = sources.query_map([class_id], |row| Ok(CourseCalendarSource { id: row.get(0)?, class_id: row.get(1)?, title: row.get(2)?, content_plain: row.get(3)?, source_path: row.get(4)?, created_at: row.get(5)? })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let mut items = connection.prepare("SELECT id, class_id, source_id, title, due_date, description, urgency, completed, source_excerpt FROM course_calendar_items WHERE class_id=?1 ORDER BY due_date, completed, title").map_err(|error| error.to_string())?;
    let items = items.query_map([class_id], |row| Ok(CourseCalendarItem { id: row.get(0)?, class_id: row.get(1)?, source_id: row.get(2)?, title: row.get(3)?, due_date: row.get(4)?, description: row.get(5)?, urgency: row.get(6)?, completed: row.get::<_, i64>(7)? != 0, source_excerpt: row.get(8)? })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let plan = connection.query_row("SELECT game_plan, updated_at FROM course_calendar_plans WHERE class_id=?1", [class_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|error| error.to_string())?;
    Ok(CourseCalendarDetail { class_id: class_id.to_string(), sources, items, game_plan: plan.as_ref().map(|entry: &(String, String)| entry.0.clone()).unwrap_or_default(), updated_at: plan.map(|entry| entry.1) })
}

#[tauri::command]
pub fn get_course_calendar(database: State<'_, Database>, class_id: String) -> CommandResult<CourseCalendarDetail> {
    let connection = database.open()?;
    let source_count: i64 = connection.query_row("SELECT COUNT(*) FROM course_calendar_sources WHERE class_id=?1", [&class_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if source_count == 0 {
        connection.execute("DELETE FROM course_calendar_items WHERE class_id=?1", [&class_id]).map_err(|error| error.to_string())?;
        connection.execute("DELETE FROM course_calendar_plans WHERE class_id=?1", [&class_id]).map_err(|error| error.to_string())?;
    }
    read_course_calendar_detail(&connection, &class_id)
}

#[tauri::command]
pub fn add_course_calendar_source(database: State<'_, Database>, input: AddCourseCalendarSourceInput) -> CommandResult<CourseCalendarDetail> {
    let title = input.title.trim().chars().take(180).collect::<String>();
    let content = input.content_plain.trim().chars().take(250_000).collect::<String>();
    if title.is_empty() || content.is_empty() { return Err("That course document has no readable text.".into()); }
    let connection = database.open()?;
    let count: i64 = connection.query_row("SELECT COUNT(*) FROM course_calendar_sources WHERE class_id=?1", [&input.class_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if count >= 10 { return Err("A Course Calendar can keep up to 10 source documents. Remove one before adding another.".into()); }
    connection.execute("INSERT INTO course_calendar_sources (id, class_id, title, content_plain, source_path) VALUES (?1,?2,?3,?4,?5)", params![Uuid::new_v4().to_string(), input.class_id, title, content, input.source_path]).map_err(|error| error.to_string())?;
    read_course_calendar_detail(&connection, &input.class_id)
}

#[tauri::command]
pub fn remove_course_calendar_source(database: State<'_, Database>, id: String) -> CommandResult<()> {
    let mut connection = database.open()?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let class_id = transaction.query_row("SELECT class_id FROM course_calendar_sources WHERE id=?1", [&id], |row| row.get::<_, String>(0)).optional().map_err(|error| error.to_string())?;
    transaction.execute("DELETE FROM course_calendar_sources WHERE id=?1", [&id]).map_err(|error| error.to_string())?;
    if let Some(class_id) = class_id {
        let remaining: i64 = transaction.query_row("SELECT COUNT(*) FROM course_calendar_sources WHERE class_id=?1", [&class_id], |row| row.get(0)).map_err(|error| error.to_string())?;
        if remaining == 0 {
            transaction.execute("DELETE FROM course_calendar_items WHERE class_id=?1", [&class_id]).map_err(|error| error.to_string())?;
            transaction.execute("DELETE FROM course_calendar_plans WHERE class_id=?1", [&class_id]).map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_course_calendar_item_completed(database: State<'_, Database>, id: String, completed: bool) -> CommandResult<()> {
    let connection = database.open()?;
    connection.execute("UPDATE course_calendar_items SET completed=?1 WHERE id=?2", params![completed as i32, id]).map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct CourseCalendarAiPlan { #[serde(default)] items: Vec<CourseCalendarAiItem>, #[serde(default)] game_plan: Vec<CourseCalendarAiPlanStep> }
#[derive(serde::Deserialize)]
struct CourseCalendarAiItem { source_title: String, title: String, due_date: String, #[serde(default)] description: String, #[serde(default)] urgency: String, #[serde(default)] source_excerpt: String }
#[derive(serde::Serialize, serde::Deserialize)]
struct CourseCalendarAiPlanStep { action: String, #[serde(default)] context: String }

fn course_calendar_plan_from_response(output: &str) -> Option<CourseCalendarAiPlan> {
    json_object_from_response(output)
        .and_then(|json| serde_json::from_str::<CourseCalendarAiPlan>(&json).ok())
}

fn explicit_course_dates(text: &str) -> Vec<(String, String)> {
    text.split(|character: char| !(character.is_ascii_digit() || character == '/' || character == '-'))
        .filter_map(|token| {
            let separator = if token.contains('/') { '/' } else if token.contains('-') { '-' } else { return None };
            let values = token.split(separator).collect::<Vec<_>>();
            if values.len() != 3 || values.iter().any(|value| value.is_empty()) { return None; }
            let first = values[0].parse::<i32>().ok()?; let second = values[1].parse::<u32>().ok()?; let third = values[2].parse::<u32>().ok()?;
            let (year, month, day) = if values[0].len() == 4 { (first, second, third) } else { (values[2].parse::<i32>().ok()?, first as u32, second) };
            chrono::NaiveDate::from_ymd_opt(year, month, day).map(|date| (date.to_string(), token.to_string()))
        })
        .collect()
}

fn fallback_course_calendar_plan(sources: &[CourseCalendarSource], today: &str) -> CourseCalendarAiPlan {
    let mut seen = HashSet::new(); let mut items = Vec::new();
    for source in sources {
        for line in source.content_plain.replace('\u{000c}', "\n").lines() {
            let text = line.split_whitespace().collect::<Vec<_>>().join(" ");
            if text.is_empty() { continue; }
            for (due_date, raw_date) in explicit_course_dates(&text) {
                let before = text.split_once(&raw_date).map(|(value, _)| value).unwrap_or("").trim_matches(|character: char| character.is_ascii_punctuation() || character.is_whitespace());
                let after = text.split_once(&raw_date).map(|(_, value)| value).unwrap_or("").trim_matches(|character: char| character.is_ascii_punctuation() || character.is_whitespace());
                let title = if before.chars().any(|character| character.is_alphabetic()) { before.chars().take(180).collect::<String>() } else if after.chars().any(|character| character.is_alphabetic()) { after.chars().take(180).collect::<String>() } else { format!("Dated course work from {}", source.title) };
                let key = format!("{}|{}|{}", source.id, due_date, title.to_ascii_lowercase());
                if !seen.insert(key) { continue; }
                let urgency = if due_date.as_str() < today { "later" } else { "upcoming" }.to_string();
                items.push(CourseCalendarAiItem { source_title: source.title.clone(), title, due_date, description: text.chars().take(1200).collect(), urgency, source_excerpt: text.chars().take(1200).collect() });
            }
        }
    }
    items.sort_by(|left, right| left.due_date.cmp(&right.due_date)); items.truncate(250);
    let game_plan = items.iter().filter(|item| item.due_date.as_str() >= today).take(8).map(|item| CourseCalendarAiPlanStep { action: format!("Start {} before {}.", item.title, item.due_date), context: format!("Explicitly dated in {}.", item.source_title) }).collect();
    CourseCalendarAiPlan { items, game_plan }
}

fn course_calendar_plan_uses_source_dates(plan: &CourseCalendarAiPlan, sources: &[CourseCalendarSource]) -> bool {
    plan.items.iter().all(|item| {
        let Some(source) = sources.iter().find(|source| source.title.eq_ignore_ascii_case(item.source_title.trim())) else { return false; };
        explicit_course_dates(&source.content_plain).into_iter().any(|(date, _)| date == item.due_date.chars().take(10).collect::<String>())
    })
}

#[tauri::command]
pub async fn refresh_course_calendar(app: tauri::AppHandle, database: State<'_, Database>, class_id: String, model_path: String) -> CommandResult<CourseCalendarDetail> {
    let database = database.inner().clone(); let app_for_ai = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = database.open()?;
        let detail = read_course_calendar_detail(&connection, &class_id)?;
        if detail.sources.is_empty() { return Err("Add one or more course documents first.".into()); }
        let settings = get_settings(&connection, None)?;
        if !settings.ai_enabled { return Err("Enable General AI to build the Course Calendar.".into()); }
        emit_ai_progress(&app_for_ai, 5, "Preparing Course Calendar");
        emit_ai_progress(&app_for_ai, 18, "Reading saved course documents");
        let sources = detail.sources.clone();
        let mut planner_sources = Vec::new();
        for source in &sources {
            if !has_fragmented_pdf_spacing(&source.content_plain) {
                planner_sources.push(source.clone());
            }
        }
        if planner_sources.is_empty() { planner_sources = sources.clone(); }
        let source_text = planner_sources.iter().map(|source| format!("SOURCE: {}\n{}", source.title, source.content_plain.chars().take(6_000).collect::<String>())).collect::<Vec<_>>().join("\n\n--- NEXT DOCUMENT ---\n\n");
        let today = chrono::Local::now().date_naive().to_string();
        emit_ai_progress(&app_for_ai, 48, "Finding supported deadlines");
        let prompt = format!("TODAY: {today}\n\nExtract only concrete course deadlines, readings, exams, meetings, assignments, and milestones from the documents. Never infer a date. Return one valid JSON object only, with no Markdown and no prose outside it: {{\"items\":[{{\"source_title\":\"exact source name\",\"title\":\"short task\",\"due_date\":\"YYYY-MM-DD\",\"description\":\"what to do\",\"urgency\":\"critical|high|upcoming|later\",\"source_excerpt\":\"short supporting text\"}}],\"game_plan\":[{{\"action\":\"specific imperative action\",\"context\":\"why it comes first\"}}]}}. Return at most 60 items and 8 game-plan steps. Omit uncertain dates and do not invent work.\n\n{source_text}");
        let system = "You extract course calendars faithfully. Never invent dates. Output one valid JSON object only.";
        let ai_plan = (|| {
            let resolved = resolve_ai_model_path(&app_for_ai, &model_path).ok()?;
            let port = ensure_ai_server(&resolved, &app_for_ai).ok()?;
            let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(180)).build().ok()?;
            local_chat_json_object(&client, port, system, &prompt, 1400).ok().and_then(|raw| course_calendar_plan_from_response(&raw)).or_else(|| {
                let retry = format!("Return only the requested JSON object now, with empty arrays if there are no supported dated items.\n\n{prompt}");
                local_chat_json_object(&client, port, system, &retry, 1400).ok().and_then(|output| course_calendar_plan_from_response(&output))
            })
        })();
        let plan = ai_plan.filter(|plan| course_calendar_plan_uses_source_dates(plan, &planner_sources)).unwrap_or_else(|| fallback_course_calendar_plan(&planner_sources, &today));
        emit_ai_progress(&app_for_ai, 88, "Saving your course calendar");
        let transaction = connection.unchecked_transaction().map_err(|error| error.to_string())?;
        transaction.execute("DELETE FROM course_calendar_items WHERE class_id=?1", [&class_id]).map_err(|error| error.to_string())?;
        for item in plan.items.into_iter().take(250) {
            if !item.due_date.chars().take(10).collect::<String>().chars().all(|character| character.is_ascii_digit() || character == '-') || item.due_date.len() < 10 { continue; }
            let source_id = planner_sources.iter().find(|source| source.title.eq_ignore_ascii_case(item.source_title.trim())).or_else(|| planner_sources.first()).map(|source| source.id.clone()).unwrap_or_default();
            let title = item.title.trim().chars().take(180).collect::<String>(); if title.is_empty() || source_id.is_empty() { continue; }
            let due_date = item.due_date.chars().take(10).collect::<String>(); let completed = due_date.as_str() < today.as_str();
            let urgency = match item.urgency.trim().to_lowercase().as_str() { "critical" | "high" | "upcoming" | "later" => item.urgency.trim().to_lowercase(), _ => "upcoming".to_string() };
            transaction.execute("INSERT INTO course_calendar_items (id,class_id,source_id,title,due_date,description,urgency,completed,source_excerpt) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![Uuid::new_v4().to_string(), class_id, source_id, title, due_date, item.description.trim().chars().take(1200).collect::<String>(), urgency, completed as i32, item.source_excerpt.trim().chars().take(1200).collect::<String>()]).map_err(|error| error.to_string())?;
        }
        let game_plan = serde_json::to_string(&plan.game_plan).map_err(|_| "SoFlo could not save the course game plan.".to_string())?;
        transaction.execute("INSERT INTO course_calendar_plans (class_id,game_plan,updated_at) VALUES (?1,?2,CURRENT_TIMESTAMP) ON CONFLICT(class_id) DO UPDATE SET game_plan=excluded.game_plan,updated_at=CURRENT_TIMESTAMP", params![class_id, game_plan.chars().take(4000).collect::<String>()]).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        emit_ai_progress(&app_for_ai, 100, "Course Calendar is ready");
        read_course_calendar_detail(&connection, &class_id)
    }).await.map_err(|_| "SoFlo's Course Calendar task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub fn duplicate_flashcard_set(
    database: State<'_, Database>,
    id: String,
    title: String,
) -> CommandResult<FlashcardSetDetail> {
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (class_id, description): (String, Option<String>) = transaction
        .query_row(
            "SELECT class_id, description FROM flashcard_sets WHERE id=?1 AND deleted_at IS NULL",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "That flashcard set could not be found.".to_string())?;
    let copy_id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT INTO flashcard_sets (id, class_id, title, description) VALUES (?1, ?2, ?3, ?4)",
            params![copy_id, class_id, title.trim(), description],
        )
        .map_err(|error| error.to_string())?;
    let mut statement = transaction.prepare("SELECT front, back, notes, image_path, position, is_starred FROM flashcards WHERE set_id=?1 ORDER BY position ASC, created_at ASC").map_err(|error| error.to_string())?;
    let cards = statement
        .query_map([&id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i32>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for card in cards {
        let (front, back, notes, image_path, position, is_starred) =
            card.map_err(|error| error.to_string())?;
        transaction.execute("INSERT INTO flashcards (id, set_id, front, back, notes, image_path, position, is_starred) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)", params![Uuid::new_v4().to_string(), copy_id, front, back, notes, image_path, position, is_starred as i32]).map_err(|error| error.to_string())?;
    }
    drop(statement);
    transaction.commit().map_err(|error| error.to_string())?;
    get_flashcard_set(database, copy_id)
}

#[tauri::command]
pub fn save_flashcard(
    database: State<'_, Database>,
    input: SaveFlashcardInput,
) -> CommandResult<Flashcard> {
    let connection = database.open()?;
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    connection.execute("INSERT INTO flashcards (id, set_id, front, back, notes, image_path, position, is_starred) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET front=excluded.front, back=excluded.back, notes=excluded.notes, image_path=excluded.image_path, position=excluded.position, is_starred=excluded.is_starred, updated_at=CURRENT_TIMESTAMP", params![id, input.set_id, input.front, input.back, input.notes, input.image_path, input.position, input.is_starred as i32]).map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE flashcard_sets SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            [&input.set_id],
        )
        .map_err(|error| error.to_string())?;
    connection.query_row("SELECT id, set_id, front, back, notes, image_path, position, is_starred, created_at, updated_at FROM flashcards WHERE id=?1", [&id], read_card).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_flashcard(database: State<'_, Database>, id: String) -> CommandResult<()> {
    database
        .open()?
        .execute("DELETE FROM flashcards WHERE id=?1", [&id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_all_cards(
    database: State<'_, Database>,
    class_id: String,
) -> CommandResult<Vec<Flashcard>> {
    let connection = database.open()?;
    let mut statement = connection.prepare("SELECT c.id, c.set_id, c.front, c.back, c.notes, c.image_path, c.position, c.is_starred, c.created_at, c.updated_at FROM flashcards c INNER JOIN flashcard_sets s ON s.id=c.set_id WHERE s.class_id=?1 AND s.is_study_web_private=0 AND s.deleted_at IS NULL ORDER BY s.updated_at DESC, c.position ASC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([class_id], read_card)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[derive(Clone)]
struct StudyWebSourceCard {
    id: String,
    front: String,
    back: String,
    updated_at: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct StudyWebSemanticPlan {
    #[serde(default)]
    groups: Vec<StudyWebSemanticGroup>,
    #[serde(default)]
    relationships: Vec<StudyWebSemanticRelationship>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct StudyWebSemanticGroup {
    id: String,
    label: String,
    #[serde(default)]
    members: Vec<String>,
    #[serde(default, alias = "parentId")]
    parent_id: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct StudyWebSemanticRelationship {
    source: String,
    target: String,
    #[serde(
        default = "default_study_web_relationship_type",
        alias = "relationshipType"
    )]
    relationship_type: String,
    #[serde(default = "default_study_web_strength")]
    strength: f64,
}

#[derive(serde::Deserialize)]
struct StudyWebParentClassification {
    #[serde(default)]
    assignments: Vec<StudyWebParentAssignment>,
}

#[derive(serde::Deserialize)]
struct StudyWebParentAssignment {
    id: String,
    parent: String,
}

#[derive(serde::Deserialize)]
struct StudyWebLeafClassification {
    #[serde(default)]
    assignments: Vec<StudyWebLeafAssignment>,
}

#[derive(serde::Deserialize)]
struct StudyWebLeafAssignment {
    id: String,
    leaf: String,
}

#[allow(dead_code)]
#[derive(serde::Deserialize)]
struct StudyWebThemeBridgePlan {
    #[serde(default)]
    connections: Vec<StudyWebThemeBridge>,
}

#[allow(dead_code)]
#[derive(serde::Deserialize)]
struct StudyWebThemeBridge {
    source_parent: String,
    target_parent: String,
    source: String,
    target: String,
    #[serde(default)]
    reason: String,
}

#[allow(dead_code)]
#[derive(serde::Deserialize)]
struct StudyWebRelationshipPlan {
    #[serde(default)]
    connections: Vec<StudyWebRelationshipCandidate>,
}

#[allow(dead_code)]
#[derive(serde::Deserialize)]
struct StudyWebRelationshipCandidate {
    source: String,
    target: String,
    #[serde(default)]
    relationship_type: String,
    #[serde(default)]
    reason: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableStudyWeb {
    format: String,
    version: u8,
    name: String,
    #[serde(default)]
    cards: Vec<PortableStudyWebCard>,
    #[serde(default)]
    nodes: Vec<PortableStudyWebNode>,
    #[serde(default)]
    groups: Vec<PortableStudyWebGroup>,
    #[serde(default)]
    relationships: Vec<PortableStudyWebRelationship>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableStudyWebCard {
    id: String,
    front: String,
    back: String,
    notes: Option<String>,
    image_path: Option<String>,
    position: i32,
    is_starred: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableStudyWebNode {
    card_id: String,
    x: f64,
    y: f64,
    manually_positioned: bool,
    pinned: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableStudyWebGroup {
    id: String,
    label: String,
    #[serde(default = "default_study_web_group_color")]
    color: String,
    parent_group_id: Option<String>,
    card_ids: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableStudyWebRelationship {
    source_card_id: String,
    target_card_id: String,
    relationship_type: String,
    strength: f64,
}

fn default_study_web_relationship_type() -> String {
    "related_to".into()
}
fn default_study_web_group_color() -> String {
    "#7E70D6".into()
}
fn normalize_study_web_group_color(value: &str) -> String {
    let value = value.trim();
    if value.len() == 7 && value.starts_with('#') && value.as_bytes()[1..].iter().all(|byte| byte.is_ascii_hexdigit()) {
        value.to_ascii_uppercase()
    } else {
        default_study_web_group_color()
    }
}
fn default_study_web_strength() -> f64 {
    0.5
}

fn study_web_sources(
    database: &Database,
    set_ids: &[String],
) -> CommandResult<(String, Vec<String>, Vec<StudyWebSourceCard>)> {
    study_web_sources_from_connection(&database.open()?, set_ids)
}

fn study_web_sources_from_connection(
    connection: &Connection,
    set_ids: &[String],
) -> CommandResult<(String, Vec<String>, Vec<StudyWebSourceCard>)> {
    let unique_ids = set_ids.iter().filter(|id| !id.trim().is_empty()).fold(
        Vec::<String>::new(),
        |mut values, id| {
            if !values.contains(id) {
                values.push(id.clone());
            }
            values
        },
    );
    if unique_ids.is_empty() {
        return Err("Choose at least one flashcard set for this Study Web.".into());
    }
    if unique_ids.len() > 5 {
        return Err("A Study Web can combine up to five flashcard sets.".into());
    }
    let mut class_id = None;
    let mut titles = Vec::new();
    let mut cards = Vec::new();
    for set_id in &unique_ids {
        let (next_class_id, title, next_cards) =
            study_web_source_from_connection(connection, set_id)?;
        if let Some(current_class_id) = &class_id {
            if current_class_id != &next_class_id {
                return Err("All Study Web sets must belong to the same class.".into());
            }
        } else {
            class_id = Some(next_class_id);
        }
        titles.push(title);
        cards.extend(next_cards);
    }
    Ok((class_id.unwrap_or_default(), titles, cards))
}

fn study_web_set_ids(
    connection: &Connection,
    web_id: &str,
    fallback_set_id: &str,
) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare("SELECT flashcard_set_id FROM study_web_sources WHERE study_web_id=?1 ORDER BY position, flashcard_set_id").map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([web_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(if ids.is_empty() {
        vec![fallback_set_id.to_string()]
    } else {
        ids
    })
}

fn study_web_source_hash(cards: &[StudyWebSourceCard]) -> String {
    cards
        .iter()
        .map(|card| {
            format!(
                "{}:{}:{}:{}",
                card.id, card.front, card.back, card.updated_at
            )
        })
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

fn ensure_study_web_group_color_column(connection: &Connection) -> CommandResult<()> {
    let mut statement = connection
        .prepare("PRAGMA table_info(study_web_groups)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !columns.iter().any(|column| column == "color") {
        connection
            .execute_batch("ALTER TABLE study_web_groups ADD COLUMN color TEXT NOT NULL DEFAULT '#7E70D6'; PRAGMA user_version = 14;")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn read_study_web_detail(connection: &Connection, id: &str) -> CommandResult<StudyWebDetail> {
    ensure_study_web_group_color_column(connection)?;
    let (id, class_id, flashcard_set_id, name, source_hash, generated_at, updated_at): (String, String, String, String, String, String, String) = connection.query_row("SELECT id, class_id, flashcard_set_id, name, source_hash, generated_at, updated_at FROM study_webs WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))).map_err(|_| "That Study Web could not be found.".to_string())?;
    let mut node_statement = connection.prepare("SELECT flashcard_id, x, y, manually_positioned, pinned FROM study_web_nodes WHERE study_web_id=?1 ORDER BY flashcard_id").map_err(|error| error.to_string())?;
    let nodes = node_statement
        .query_map([&id], |row| {
            Ok(StudyWebNode {
                card_id: row.get(0)?,
                x: row.get(1)?,
                y: row.get(2)?,
                manually_positioned: row.get::<_, i32>(3)? != 0,
                pinned: row.get::<_, i32>(4)? != 0,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut group_statement = connection.prepare("SELECT id, label, color, parent_group_id FROM study_web_groups WHERE study_web_id=?1 ORDER BY label COLLATE NOCASE").map_err(|error| error.to_string())?;
    let group_rows = group_statement
        .query_map([&id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut groups = Vec::new();
    for (group_id, label, color, parent_group_id) in group_rows {
        let mut members = connection.prepare("SELECT flashcard_id FROM study_web_group_members WHERE study_web_id=?1 AND group_id=?2 ORDER BY flashcard_id").map_err(|error| error.to_string())?;
        let card_ids = members
            .query_map(params![&id, &group_id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())?;
        groups.push(StudyWebGroup {
            id: group_id,
            label,
            color,
            parent_group_id,
            card_ids,
        });
    }
    let mut relationship_statement = connection.prepare("SELECT id, source_flashcard_id, target_flashcard_id, relationship_type, strength FROM study_web_relationships WHERE study_web_id=?1 ORDER BY strength DESC, id").map_err(|error| error.to_string())?;
    let relationships = relationship_statement
        .query_map([&id], |row| {
            Ok(StudyWebRelationship {
                id: row.get(0)?,
                source_card_id: row.get(1)?,
                target_card_id: row.get(2)?,
                relationship_type: row.get(3)?,
                strength: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let flashcard_set_ids = study_web_set_ids(connection, &id, &flashcard_set_id)?;
    let (_, _, cards) = study_web_sources_from_connection(connection, &flashcard_set_ids)?;
    Ok(StudyWebDetail {
        id,
        class_id,
        flashcard_set_id,
        flashcard_set_ids,
        name,
        generated_at,
        updated_at,
        out_of_date: source_hash != "manual" && source_hash != study_web_source_hash(&cards),
        is_manual: source_hash == "manual",
        nodes,
        groups,
        relationships,
    })
}

fn study_web_source_from_connection(
    connection: &Connection,
    set_id: &str,
) -> CommandResult<(String, String, Vec<StudyWebSourceCard>)> {
    let (class_id, title): (String, String) = connection
        .query_row(
            "SELECT class_id, title FROM flashcard_sets WHERE id=?1 AND deleted_at IS NULL",
            [set_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "That flashcard set could not be found.".to_string())?;
    let mut statement = connection.prepare("SELECT id, front, back, updated_at FROM flashcards WHERE set_id=?1 ORDER BY position ASC, created_at ASC").map_err(|error| error.to_string())?;
    let cards = statement
        .query_map([set_id], |row| {
            Ok(StudyWebSourceCard {
                id: row.get(0)?,
                front: row.get(1)?,
                back: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok((class_id, title, cards))
}

#[tauri::command]
fn list_study_webs_by_deleted(
    database: State<'_, Database>,
    class_id: String,
    deleted: bool,
) -> CommandResult<Vec<StudyWebSummary>> {
    let connection = database.open()?;
    let mut statement = connection.prepare("SELECT id, class_id, flashcard_set_id, name, source_hash, generated_at, updated_at, deleted_at FROM study_webs WHERE class_id=?1 AND (deleted_at IS NOT NULL)=?2 ORDER BY updated_at DESC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![&class_id, deleted as i32], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut webs = Vec::new();
    for row in rows {
        let (id, class_id, set_id, name, source_hash, generated_at, updated_at, deleted_at) =
            row.map_err(|error| error.to_string())?;
        let card_count = connection
            .query_row(
                "SELECT COUNT(*) FROM study_web_nodes WHERE study_web_id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let group_count = connection
            .query_row(
                "SELECT COUNT(*) FROM study_web_groups WHERE study_web_id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let flashcard_set_ids = study_web_set_ids(&connection, &id, &set_id)?;
        let (_, _, cards) = study_web_sources_from_connection(&connection, &flashcard_set_ids)?;
        webs.push(StudyWebSummary {
            id,
            class_id,
            flashcard_set_id: set_id,
            flashcard_set_ids,
            name,
            card_count,
            group_count,
            generated_at,
            updated_at,
            deleted_at,
            out_of_date: source_hash != "manual" && source_hash != study_web_source_hash(&cards),
            is_manual: source_hash == "manual",
        });
    }
    Ok(webs)
}

#[tauri::command]
pub fn list_study_webs(
    database: State<'_, Database>,
    class_id: String,
) -> CommandResult<Vec<StudyWebSummary>> {
    list_study_webs_by_deleted(database, class_id, false)
}

#[tauri::command]
pub fn list_trashed_study_webs(
    database: State<'_, Database>,
    class_id: String,
) -> CommandResult<Vec<StudyWebSummary>> {
    list_study_webs_by_deleted(database, class_id, true)
}

#[tauri::command]
pub fn set_study_web_deleted(
    database: State<'_, Database>,
    id: String,
    deleted: bool,
) -> CommandResult<()> {
    let connection = database.open()?;
    let changed = connection.execute("UPDATE study_webs SET deleted_at=CASE WHEN ?1 THEN CURRENT_TIMESTAMP ELSE NULL END, updated_at=CURRENT_TIMESTAMP WHERE id=?2", params![deleted as i32, id]).map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("That Study Web could not be found.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn get_study_web(database: State<'_, Database>, id: String) -> CommandResult<StudyWebDetail> {
    read_study_web_detail(&database.open()?, &id)
}

#[tauri::command]
pub fn create_empty_study_web(
    database: State<'_, Database>,
    class_id: String,
    name: String,
) -> CommandResult<StudyWebDetail> {
    let mut connection = database.open()?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let title = name.trim().chars().take(96).collect::<String>();
    let title = if title.is_empty() { "Study Web".to_string() } else { title };
    let set_id = Uuid::new_v4().to_string();
    let web_id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO flashcard_sets (id, class_id, title, description, is_study_web_private) VALUES (?1,?2,?3,?4,1)",
        params![&set_id, &class_id, format!("{} cards", title), "Cards created inside this Study Web."],
    ).map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO study_webs (id, class_id, flashcard_set_id, name, source_hash) VALUES (?1,?2,?3,?4,'manual')",
        params![&web_id, &class_id, &set_id, &title],
    ).map_err(|error| error.to_string())?;
    transaction.execute(
        "INSERT INTO study_web_sources (study_web_id, flashcard_set_id, position) VALUES (?1,?2,0)",
        params![&web_id, &set_id],
    ).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    read_study_web_detail(&database.open()?, &web_id)
}

fn study_web_export_filename(name: &str) -> String {
    let safe = name
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_') { character } else { '_' })
        .collect::<String>();
    let safe = safe.trim_matches([' ', '-', '_']);
    if safe.is_empty() { "SoFlo Study Web".to_string() } else { format!("SoFlo Study Web - {}", safe) }
}

#[tauri::command]
pub fn export_study_web_json(database: State<'_, Database>, id: String) -> CommandResult<String> {
    let connection = database.open()?;
    let detail = read_study_web_detail(&connection, &id)?;
    let mut statement = connection.prepare("SELECT f.id, f.front, f.back, f.notes, f.image_path, f.position, f.is_starred FROM flashcards f INNER JOIN study_web_nodes n ON n.flashcard_id=f.id WHERE n.study_web_id=?1 ORDER BY f.position, f.created_at").map_err(|error| error.to_string())?;
    let cards = statement.query_map([&id], |row| Ok(PortableStudyWebCard { id: row.get(0)?, front: row.get(1)?, back: row.get(2)?, notes: row.get(3)?, image_path: row.get(4)?, position: row.get(5)?, is_starred: row.get::<_, i32>(6)? != 0 })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let export = PortableStudyWeb {
        format: "soflo-study-web".into(), version: 1, name: detail.name,
        cards,
        nodes: detail.nodes.into_iter().map(|node| PortableStudyWebNode { card_id: node.card_id, x: node.x, y: node.y, manually_positioned: node.manually_positioned, pinned: node.pinned }).collect(),
        groups: detail.groups.into_iter().map(|group| PortableStudyWebGroup { id: group.id, label: group.label, color: group.color, parent_group_id: group.parent_group_id, card_ids: group.card_ids }).collect(),
        relationships: detail.relationships.into_iter().map(|edge| PortableStudyWebRelationship { source_card_id: edge.source_card_id, target_card_id: edge.target_card_id, relationship_type: edge.relationship_type, strength: edge.strength }).collect(),
    };
    let downloads = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?).join("Downloads");
    fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let destination = downloads.join(format!("{}.json", study_web_export_filename(&export.name)));
    fs::write(&destination, serde_json::to_vec_pretty(&export).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_study_web_json(
    database: State<'_, Database>,
    class_id: String,
    source: String,
) -> CommandResult<StudyWebDetail> {
    let path = PathBuf::from(source);
    if !path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("json")) {
        return Err("Choose a SoFlo Study Web .json file.".into());
    }
    let portable = serde_json::from_slice::<PortableStudyWeb>(&fs::read(&path).map_err(|_| "SoFlo could not read that Study Web file.".to_string())?).map_err(|_| "That file is not a valid SoFlo Study Web export.".to_string())?;
    if portable.format != "soflo-study-web" || portable.version != 1 || portable.cards.len() > 600 {
        return Err("That file is not a compatible SoFlo Study Web export.".into());
    }
    let mut connection = database.open()?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let title = portable.name.trim().chars().take(96).collect::<String>();
    let title = if title.is_empty() { "Imported Study Web".to_string() } else { title };
    let set_id = Uuid::new_v4().to_string();
    let web_id = Uuid::new_v4().to_string();
    transaction.execute("INSERT INTO flashcard_sets (id, class_id, title, description, is_study_web_private) VALUES (?1,?2,?3,?4,1)", params![&set_id, &class_id, format!("{} cards", title), "Cards imported with this Study Web."]).map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO study_webs (id, class_id, flashcard_set_id, name, source_hash) VALUES (?1,?2,?3,?4,'manual')", params![&web_id, &class_id, &set_id, &title]).map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO study_web_sources (study_web_id, flashcard_set_id, position) VALUES (?1,?2,0)", params![&web_id, &set_id]).map_err(|error| error.to_string())?;
    let mut card_ids = HashMap::new();
    for (index, card) in portable.cards.iter().enumerate() {
        if card.id.trim().is_empty() || card_ids.contains_key(&card.id) { continue; }
        let new_id = Uuid::new_v4().to_string();
        transaction.execute("INSERT INTO flashcards (id, set_id, front, back, notes, image_path, position, is_starred) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![&new_id, &set_id, card.front.trim(), card.back.trim(), card.notes, card.image_path, card.position.max(index as i32), card.is_starred as i32]).map_err(|error| error.to_string())?;
        card_ids.insert(card.id.clone(), new_id);
    }
    let mut node_cards = HashSet::new();
    for node in portable.nodes {
        let Some(card_id) = card_ids.get(&node.card_id) else { continue; };
        if !node.x.is_finite() || !node.y.is_finite() || !node_cards.insert(card_id.clone()) { continue; }
        transaction.execute("INSERT INTO study_web_nodes (study_web_id, flashcard_id, x, y, manually_positioned, pinned) VALUES (?1,?2,?3,?4,?5,?6)", params![&web_id, card_id, node.x, node.y, node.manually_positioned as i32, node.pinned as i32]).map_err(|error| error.to_string())?;
    }
    for (index, card_id) in card_ids.values().enumerate() {
        if node_cards.insert(card_id.clone()) { transaction.execute("INSERT INTO study_web_nodes (study_web_id, flashcard_id, x, y, manually_positioned, pinned) VALUES (?1,?2,?3,?4,1,0)", params![&web_id, card_id, 280.0 + (index % 4) as f64 * 290.0, 240.0 + (index / 4) as f64 * 130.0]).map_err(|error| error.to_string())?; }
    }
    let mut group_ids = HashMap::new();
    for group in &portable.groups {
        if group.id.trim().is_empty() || group.label.trim().is_empty() || group_ids.contains_key(&group.id) { continue; }
        let new_id = Uuid::new_v4().to_string();
        transaction.execute("INSERT INTO study_web_groups (id, study_web_id, label, color, parent_group_id) VALUES (?1,?2,?3,?4,NULL)", params![&new_id, &web_id, group.label.trim().chars().take(72).collect::<String>(), normalize_study_web_group_color(&group.color)]).map_err(|error| error.to_string())?;
        group_ids.insert(group.id.clone(), new_id);
    }
    for group in &portable.groups {
        let Some(group_id) = group_ids.get(&group.id) else { continue; };
        if let Some(parent) = group.parent_group_id.as_ref().and_then(|parent| group_ids.get(parent)) { transaction.execute("UPDATE study_web_groups SET parent_group_id=?1 WHERE id=?2", params![parent, group_id]).map_err(|error| error.to_string())?; }
        for card_id in &group.card_ids { if let Some(card_id) = card_ids.get(card_id) { transaction.execute("INSERT OR IGNORE INTO study_web_group_members (study_web_id, group_id, flashcard_id) VALUES (?1,?2,?3)", params![&web_id, group_id, card_id]).map_err(|error| error.to_string())?; } }
    }
    let mut seen_edges = HashSet::new();
    for edge in portable.relationships {
        let (Some(source), Some(target)) = (card_ids.get(&edge.source_card_id), card_ids.get(&edge.target_card_id)) else { continue; };
        if source == target { continue; }
        let key = if source < target { (source.clone(), target.clone()) } else { (target.clone(), source.clone()) };
        if seen_edges.insert(key.clone()) { transaction.execute("INSERT INTO study_web_relationships (id, study_web_id, source_flashcard_id, target_flashcard_id, relationship_type, strength) VALUES (?1,?2,?3,?4,?5,?6)", params![Uuid::new_v4().to_string(), &web_id, key.0, key.1, edge.relationship_type.trim().chars().take(32).collect::<String>(), edge.strength.clamp(0.1, 1.0)]).map_err(|error| error.to_string())?; }
    }
    transaction.commit().map_err(|error| error.to_string())?;
    read_study_web_detail(&database.open()?, &web_id)
}

#[tauri::command]
pub fn save_study_web_node_position(
    database: State<'_, Database>,
    input: SaveStudyWebNodePositionInput,
) -> CommandResult<()> {
    if !input.x.is_finite() || !input.y.is_finite() {
        return Err("That Study Web position is invalid.".into());
    }
    let connection = database.open()?;
    if let Some(pinned) = input.pinned {
        connection.execute("INSERT INTO study_web_nodes (study_web_id, flashcard_id, x, y, manually_positioned, pinned) VALUES (?1,?2,?3,?4,1,?5) ON CONFLICT(study_web_id, flashcard_id) DO UPDATE SET x=excluded.x, y=excluded.y, manually_positioned=1, pinned=excluded.pinned", params![input.study_web_id, input.card_id, input.x, input.y, if pinned { 1 } else { 0 }]).map_err(|error| error.to_string())?;
    } else {
        connection.execute("INSERT INTO study_web_nodes (study_web_id, flashcard_id, x, y, manually_positioned, pinned) VALUES (?1,?2,?3,?4,1,0) ON CONFLICT(study_web_id, flashcard_id) DO UPDATE SET x=excluded.x, y=excluded.y, manually_positioned=1", params![input.study_web_id, input.card_id, input.x, input.y]).map_err(|error| error.to_string())?;
    }
    connection
        .execute(
            "UPDATE study_webs SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            [&input.study_web_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn toggle_study_web_relationship(
    database: State<'_, Database>,
    input: ToggleStudyWebRelationshipInput,
) -> CommandResult<Option<StudyWebRelationship>> {
    if input.source_card_id == input.target_card_id {
        return Err("Choose two different cards to link.".into());
    }
    let connection = database.open()?;
    let present: i64 = connection.query_row("SELECT COUNT(*) FROM study_web_nodes WHERE study_web_id=?1 AND flashcard_id IN (?2, ?3)", params![&input.study_web_id, &input.source_card_id, &input.target_card_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    if present != 2 {
        return Err("Both cards must belong to this Study Web.".into());
    }
    let (source, target) = if input.source_card_id < input.target_card_id {
        (input.source_card_id, input.target_card_id)
    } else {
        (input.target_card_id, input.source_card_id)
    };
    let existing: Option<String> = connection.query_row("SELECT id FROM study_web_relationships WHERE study_web_id=?1 AND source_flashcard_id=?2 AND target_flashcard_id=?3", params![&input.study_web_id, &source, &target], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    let result = if let Some(id) = existing {
        connection
            .execute("DELETE FROM study_web_relationships WHERE id=?1", [&id])
            .map_err(|error| error.to_string())?;
        None
    } else {
        let id = Uuid::new_v4().to_string();
        connection.execute("INSERT INTO study_web_relationships (id, study_web_id, source_flashcard_id, target_flashcard_id, relationship_type, strength) VALUES (?1,?2,?3,?4,'manual_related',0.75)", params![&id, &input.study_web_id, &source, &target]).map_err(|error| error.to_string())?;
        Some(StudyWebRelationship {
            id,
            source_card_id: source,
            target_card_id: target,
            relationship_type: "manual_related".into(),
            strength: 0.75,
        })
    };
    connection
        .execute(
            "UPDATE study_webs SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            [&input.study_web_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn remove_empty_study_web_groups(connection: &Connection, study_web_id: &str) -> CommandResult<()> {
    loop {
        let removed = connection
            .execute(
                "DELETE FROM study_web_groups WHERE study_web_id=?1 AND NOT EXISTS(SELECT 1 FROM study_web_group_members member WHERE member.study_web_id=study_web_groups.study_web_id AND member.group_id=study_web_groups.id) AND NOT EXISTS(SELECT 1 FROM study_web_groups child WHERE child.study_web_id=study_web_groups.study_web_id AND child.parent_group_id=study_web_groups.id)",
                [study_web_id],
            )
            .map_err(|error| error.to_string())?;
        if removed == 0 {
            return Ok(());
        }
    }
}

#[tauri::command]
pub fn update_study_web_group_membership(
    database: State<'_, Database>,
    input: UpdateStudyWebGroupMembershipInput,
) -> CommandResult<StudyWebDetail> {
    let connection = database.open()?;
    let group_is_leaf: Option<i64> = connection
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM study_web_groups child WHERE child.parent_group_id=g.id) FROM study_web_groups g WHERE g.id=?1 AND g.study_web_id=?2",
            params![&input.group_id, &input.study_web_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if group_is_leaf != Some(1) {
        return Err("Choose one of the concept groups before changing its cards.".into());
    }
    let belongs_to_web: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM study_web_nodes WHERE study_web_id=?1 AND flashcard_id=?2",
            params![&input.study_web_id, &input.card_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if belongs_to_web != 1 {
        return Err("That card is not part of this Study Web.".into());
    }
    if input.included {
        connection
            .execute(
                "INSERT OR IGNORE INTO study_web_group_members (study_web_id, group_id, flashcard_id) VALUES (?1,?2,?3)",
                params![&input.study_web_id, &input.group_id, &input.card_id],
            )
            .map_err(|error| error.to_string())?;
    } else {
        connection
            .execute(
                "DELETE FROM study_web_group_members WHERE study_web_id=?1 AND group_id=?2 AND flashcard_id=?3",
                params![&input.study_web_id, &input.group_id, &input.card_id],
            )
            .map_err(|error| error.to_string())?;
        remove_empty_study_web_groups(&connection, &input.study_web_id)?;
    }
    connection
        .execute(
            "UPDATE study_webs SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            [&input.study_web_id],
        )
        .map_err(|error| error.to_string())?;
    read_study_web_detail(&connection, &input.study_web_id)
}

#[tauri::command]
pub fn update_study_web_group_color(
    database: State<'_, Database>,
    input: UpdateStudyWebGroupColorInput,
) -> CommandResult<StudyWebDetail> {
    let color = normalize_study_web_group_color(&input.color);
    let connection = database.open()?;
    let updated = connection
        .execute(
            "UPDATE study_web_groups SET color=?1 WHERE id=?2 AND study_web_id=?3",
            params![&color, &input.group_id, &input.study_web_id],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err("That concept group could not be found.".into());
    }
    connection
        .execute(
            "UPDATE study_webs SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            [&input.study_web_id],
        )
        .map_err(|error| error.to_string())?;
    read_study_web_detail(&connection, &input.study_web_id)
}

#[tauri::command]
pub fn create_study_web_group(
    database: State<'_, Database>,
    input: CreateStudyWebGroupInput,
) -> CommandResult<StudyWebDetail> {
    let label = input.label.trim().chars().take(72).collect::<String>();
    if label.is_empty() {
        return Err("Give this concept group a name.".into());
    }
    let connection = database.open()?;
    let belongs_to_web: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM study_web_nodes WHERE study_web_id=?1 AND flashcard_id=?2",
            params![&input.study_web_id, &input.card_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if belongs_to_web != 1 {
        return Err("That card is not part of this Study Web.".into());
    }
    let group_id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO study_web_groups (id, study_web_id, label, parent_group_id) VALUES (?1,?2,?3,NULL)",
            params![&group_id, &input.study_web_id, &label],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO study_web_group_members (study_web_id, group_id, flashcard_id) VALUES (?1,?2,?3)",
            params![&input.study_web_id, &group_id, &input.card_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE study_webs SET updated_at=CURRENT_TIMESTAMP WHERE id=?1",
            [&input.study_web_id],
        )
        .map_err(|error| error.to_string())?;
    read_study_web_detail(&connection, &input.study_web_id)
}

#[tauri::command]
pub async fn generate_study_web(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    set_ids: Vec<String>,
    model_path: String,
    study_web_id: Option<String>,
) -> CommandResult<StudyWebDetail> {
    let database = database.inner().clone();
    let (class_id, set_titles, cards) = study_web_sources(&database, &set_ids)?;
    if cards.len() < 2 {
        return Err("Add a few more cards before creating a Study Web.".into());
    }
    let app_for_ai = app.clone();
    let cards_for_ai = cards.clone();
    let semantic = tauri::async_runtime::spawn_blocking(move || {
        generate_study_web_semantics(app_for_ai, model_path, cards_for_ai)
    })
    .await
    .map_err(|_| "SoFlo's Study Web task stopped unexpectedly.".to_string())??;
    save_generated_study_web(
        &database,
        &class_id,
        &set_ids,
        &set_titles,
        &cards,
        semantic,
        study_web_id,
    )
}

#[allow(unreachable_code)]
fn generate_study_web_semantics(
    app: tauri::AppHandle,
    model_path: String,
    cards: Vec<StudyWebSourceCard>,
) -> CommandResult<StudyWebSemanticPlan> {
    return generate_study_web_semantics_layered(app, model_path, cards);

    let model_path = resolve_ai_model_path(&app, &model_path)?;
    emit_ai_progress(&app, 8, "Starting your private local model");
    let port = ensure_study_web_ai_server(&model_path, &app)?;
    emit_ai_progress(&app, 24, "Reading each concept and definition");
    // Short model-only IDs and compact source fields leave the local model enough
    // context to return the complete web instead of a truncated JSON response.
    let model_cards = cards
        .iter()
        .take(100)
        .enumerate()
        .map(|(index, card)| StudyWebSourceCard {
            id: format!("c{}", index + 1),
            front: card.front.chars().take(68).collect(),
            back: card.back.chars().take(156).collect(),
            updated_at: String::new(),
        })
        .collect::<Vec<_>>();
    let material = model_cards.iter().map(|card| serde_json::json!({ "id": card.id, "term": card.front, "definition": card.back })).collect::<Vec<_>>();
    let prompt = format!("FLASHCARDS:\n{}\n\nRead every term and definition, then return the semantic organization now.", serde_json::to_string(&material).unwrap_or_default());
    let target_leaf_group_count = ((cards.len() + 3) / 4).clamp(2, 12);
    let target_parent_group_count = ((target_leaf_group_count + 2) / 3)
        .clamp(1, 4)
        .min(target_leaf_group_count);
    let max_relationship_count = target_leaf_group_count * 2 + 4;
    let system = format!("You are building the reasoning plan for an academic concept web. Return compact JSON only: {{\"groups\":[{{\"id\":\"parent-1\",\"label\":\"specific larger theme\",\"members\":[],\"parent_id\":null}},{{\"id\":\"leaf-1\",\"label\":\"short specific subgroup\",\"members\":[\"flashcard id in a meaningful order\"],\"parent_id\":\"parent-1\"}}],\"relationships\":[{{\"source\":\"flashcard id\",\"target\":\"flashcard id\",\"relationship_type\":\"direct_relation\",\"strength\":0.8}}]}}. Carefully read both sides of every supplied flashcard before deciding. Build a two-level semantic web, not a flat list: create roughly {target_leaf_group_count} compact leaf groups and {target_parent_group_count} broader parent groups. Every leaf group must have a parent_id pointing to one of the parent groups. Parent groups must use an empty members array: they inherit their cards from child leaf groups. Each leaf should normally contain 2 to 6 closely related cards; do not make one group for every individual card unless it is genuinely isolated. Use short, descriptive labels for both levels: parent labels name a meaningful larger theme, while leaf labels name a narrower shared idea. Never use umbrella labels such as Core concepts, Key terms, Overview, or the whole subject name. Every supplied ID must appear in a leaf group. A genuine bridge concept may appear in two closely related leaf groups only when it directly connects both; do not duplicate cards gratuitously. Add a small, meaningful set of direct explanatory relationships within leaf groups and precise bridge relationships between cards in neighboring leaf groups when those groups belong together. Return no more than {max_relationship_count} relationships total; do not chain every card just to fill space. A bridge must still be a real relationship between those exact cards, not merely a shared parent label. You may use reliable domain knowledge to interpret a term, but never connect cards merely because they share a broad category, discipline, system, location, vocabulary word, or analogous example. Before adding a relationship, ask whether you can state the exact direct relationship. Prefer no relationship over a speculative one. Valid links are direct part-whole, direct interaction, sequence, cause-effect, contrast, prerequisite, or another well-established relationship. Use only supplied IDs. Do not invent cards, coordinates, markdown, or commentary.");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(125))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    let raw = local_chat_text(&client, port, &system, &prompt, 2600).unwrap_or_default();
    let candidate = json_object_from_response(&raw)
        .and_then(|json| serde_json::from_str::<StudyWebSemanticPlan>(&json).ok())
        .unwrap_or_else(|| fallback_study_web_plan(&model_cards));
    emit_ai_progress(&app, 66, "Checking relationships for real meaning");
    let audit_prompt = format!(
        "FLASHCARDS:\n{}\n\nCANDIDATE PLAN:\n{}\n\nReturn the corrected plan now.",
        serde_json::to_string(&material).unwrap_or_default(),
        serde_json::to_string(&candidate).unwrap_or_default()
    );
    let audit_system = "You are the quality gate for an academic concept web. Return the complete corrected JSON plan only, using exactly the schema from the candidate. Re-read the source definitions before approving any part of the candidate. The finished plan must be a two-level web: specific leaf groups with parent_id values, plus broader parent groups with parent_id null and empty members arrays. Parent groups inherit their cards from the child leaves. Reorganize flat or singleton-heavy plans into compact leaf clusters under meaningful larger themes. The goal is a connected semantic web with small clusters joined through a few justified bridge relationships, not a table of separate terms and not one undifferentiated cloud. Audit every relationship one by one: retain it only if there is a direct structural, functional, causal, sequential, contrasting, prerequisite, or other well-established relationship between those exact cards. Delete links based merely on the cards belonging to the same broad category, discipline, system, region, or familiar list. Use a bridge edge only when it precisely connects neighboring leaf groups. Keep the relationships deliberately sparse; do not create a long chain through every card. Every label must name the narrow shared idea or meaningful larger theme visible in its members, not a generic heading or whole-subject name. A bridge card may be in two close leaf groups only when it genuinely connects both. Keep every supplied card in a leaf group, preserve only supplied IDs, and do not add commentary, markdown, or coordinates.";
    let audited_raw =
        local_chat_text(&client, port, audit_system, &audit_prompt, 2600).unwrap_or_default();
    let mut plan = json_object_from_response(&audited_raw)
        .and_then(|json| serde_json::from_str::<StudyWebSemanticPlan>(&json).ok())
        .unwrap_or(candidate);
    if !study_web_plan_has_hierarchy(&plan, &model_cards) {
        emit_ai_progress(&app, 84, "Building connected concept layers");
        let repair_prompt = format!("FLASHCARDS:\n{}\n\nPLAN TO REPAIR:\n{}\n\nReturn a corrected two-level Study Web plan now.", serde_json::to_string(&material).unwrap_or_default(), serde_json::to_string(&plan).unwrap_or_default());
        let repair_system = "Return compact JSON only using the plan schema you were given. Repair this into a connected two-level semantic web. Create meaningful parent groups with parent_id null and empty members arrays, then 2 to 6-card leaf groups that point to those parents. Do not leave every card in its own group. Keep leaf labels narrow and parent labels broader but still descriptive. Add only a small number of well-established direct and bridge relationships so the visual result is a web, never a chain through every card. Never use a shared broad category alone as evidence for an edge. Use only supplied IDs and do not add commentary, markdown, or coordinates.";
        if let Some(repaired) = json_object_from_response(
            &local_chat_text(&client, port, repair_system, &repair_prompt, 2800)
                .unwrap_or_default(),
        )
        .and_then(|json| serde_json::from_str::<StudyWebSemanticPlan>(&json).ok())
        {
            plan = repaired;
        }
    }
    emit_ai_progress(&app, 90, "Validating concept relationships");
    touch_ai_server();
    emit_ai_progress(&app, 100, "Arranging your Study Web");
    Ok(remap_study_web_plan_ids(plan, &model_cards, &cards))
}

fn generate_study_web_semantics_layered(
    app: tauri::AppHandle,
    model_path: String,
    cards: Vec<StudyWebSourceCard>,
) -> CommandResult<StudyWebSemanticPlan> {
    let model_path = resolve_ai_model_path(&app, &model_path)?;
    emit_ai_progress(&app, 8, "Starting your private local model");
    let port = ensure_study_web_ai_server(&model_path, &app)?;
    let model_cards = cards
        .iter()
        .take(100)
        .enumerate()
        .map(|(index, card)| StudyWebSourceCard {
            id: format!("c{}", index + 1),
            front: card.front.chars().take(68).collect(),
            back: card.back.chars().take(156).collect(),
            updated_at: String::new(),
        })
        .collect::<Vec<_>>();
    let material = model_cards.iter().map(|card| serde_json::json!({ "id": card.id, "term": card.front, "definition": card.back })).collect::<Vec<_>>();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(125))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    emit_ai_progress(&app, 24, "Finding the larger themes");
    let parent_system = "You classify study cards into meaningful themes. Return only valid JSON with one key, assignments. Its value is an array with exactly one object for each provided card. Each object has exactly three string keys: id, parent, leaf. id must be copied from a supplied card. parent is a concise broad semantic theme. leaf is a concise, narrower subgroup within that parent. Prefer the fewest meaningful parent themes, normally 2 to 6, and use a new parent only when the cards have a genuinely different role, process, location, or relationship. Assign every card exactly once. Do not include relationships, explanations, or any other keys.";
    let parent_prompt = format!(
        "FLASHCARDS:\n{}\n\nReturn the classification now.",
        serde_json::to_string(&material).unwrap_or_default()
    );
    let parent_raw = local_chat_text(&client, port, parent_system, &parent_prompt, 2200)?;
    let parent_classification = json_object_from_response(&parent_raw)
        .and_then(|json| serde_json::from_str::<StudyWebParentClassification>(&json).ok())
        .ok_or_else(|| {
            "SoFlo could not read the Study Web's theme plan. Please try again.".to_string()
        })?;
    let parent_buckets =
        study_web_parent_buckets(&parent_classification.assignments, &model_cards)?;
    let mut groups = Vec::new();
    let mut leaves = Vec::<(String, String, String, Vec<String>)>::new();
    let parent_count = parent_buckets.len().max(1);
    for (parent_index, (parent_label, card_ids)) in parent_buckets.iter().enumerate() {
        let parent_id = format!("parent-{}", parent_index + 1);
        groups.push(StudyWebSemanticGroup {
            id: parent_id.clone(),
            label: parent_label.clone(),
            members: Vec::new(),
            parent_id: None,
        });
        let progress = 42 + ((parent_index * 42) / parent_count) as u8;
        emit_ai_progress(
            &app,
            progress,
            &format!("Organizing {} into smaller groups", parent_label),
        );
        let next_leaves =
            classify_study_web_leaves(&client, port, parent_label, card_ids, &model_cards)
                .unwrap_or_else(|| vec![(parent_label.clone(), card_ids.clone())]);
        for (label, members) in next_leaves {
            let leaf_id = format!("leaf-{}", leaves.len() + 1);
            groups.push(StudyWebSemanticGroup {
                id: leaf_id.clone(),
                label: label.clone(),
                members: members.clone(),
                parent_id: Some(parent_id.clone()),
            });
            leaves.push((leaf_id, parent_id.clone(), label, members));
        }
    }
    // The model's job is the hierarchy and its groups. The canvas derives its
    // card-to-card tree directly from that hierarchy, which keeps every line
    // attached to real cards without inventing a factual relationship.
    emit_ai_progress(&app, 82, "Checking the concept hierarchy");
    let relationships = Vec::<StudyWebSemanticRelationship>::new();
    let plan = StudyWebSemanticPlan {
        groups,
        relationships,
    };
    if !study_web_plan_has_hierarchy(&plan, &model_cards) {
        return Err(
            "SoFlo could not build a complete Study Web hierarchy. Please try again.".into(),
        );
    }
    emit_ai_progress(&app, 92, "Connecting the strongest relationships");
    touch_ai_server();
    emit_ai_progress(&app, 100, "Arranging your Study Web");
    Ok(remap_study_web_plan_ids(plan, &model_cards, &cards))
}

fn study_web_parent_buckets(
    assignments: &[StudyWebParentAssignment],
    cards: &[StudyWebSourceCard],
) -> CommandResult<Vec<(String, Vec<String>)>> {
    let known = cards
        .iter()
        .map(|card| card.id.as_str())
        .collect::<HashSet<_>>();
    let mut assigned = HashSet::new();
    let mut buckets = Vec::<(String, Vec<String>)>::new();
    for assignment in assignments {
        let label = assignment
            .parent
            .trim()
            .chars()
            .take(72)
            .collect::<String>();
        if !known.contains(assignment.id.as_str())
            || label.is_empty()
            || !assigned.insert(assignment.id.clone())
        {
            continue;
        }
        if let Some((existing_label, card_ids)) = buckets
            .iter_mut()
            .find(|(existing_label, _)| study_web_labels_match(existing_label, &label))
        {
            if label.chars().count() > existing_label.chars().count() {
                *existing_label = label;
            }
            card_ids.push(assignment.id.clone());
        } else {
            buckets.push((label, vec![assignment.id.clone()]));
        }
    }
    if assigned.len() != cards.len() {
        return Err("SoFlo's local model did not classify every flashcard.".into());
    }
    Ok(buckets)
}

fn classify_study_web_leaves(
    client: &reqwest::blocking::Client,
    port: u16,
    parent_label: &str,
    card_ids: &[String],
    cards: &[StudyWebSourceCard],
) -> Option<Vec<(String, Vec<String>)>> {
    classify_study_web_leaves_inner(client, port, parent_label, card_ids, cards, 0)
}

fn classify_study_web_leaves_inner(
    client: &reqwest::blocking::Client,
    port: u16,
    parent_label: &str,
    card_ids: &[String],
    cards: &[StudyWebSourceCard],
    depth: usize,
) -> Option<Vec<(String, Vec<String>)>> {
    if card_ids.len() <= 3 {
        return Some(vec![(parent_label.to_string(), card_ids.to_vec())]);
    }
    let requested_cards = cards.iter().filter(|card| card_ids.contains(&card.id)).map(|card| serde_json::json!({ "id": card.id, "term": card.front, "definition": card.back })).collect::<Vec<_>>();
    let system = "You group related study cards into a few useful subgroups. Return only valid JSON with one key, assignments. Its value is an array with exactly one object for every supplied card. Each object has exactly two string keys: id and leaf. id must be copied from a supplied card. leaf must be a concise subgroup label shared by multiple cards where possible. Use the card definitions to create smaller groups by role, location, process, relationship, or type. Never use the term itself as its own leaf label. Each leaf should contain 2 to 6 cards unless one is genuinely isolated. Do not include parent, relationships, explanations, or other keys.";
    let prompt = format!(
        "LARGER THEME: {parent_label}\nFLASHCARDS:\n{}\n\nReturn the subgroup classification now.",
        serde_json::to_string(&requested_cards).ok()?
    );
    let raw = local_chat_text(client, port, system, &prompt, 1100).ok()?;
    let classification = json_object_from_response(&raw)
        .and_then(|json| serde_json::from_str::<StudyWebLeafClassification>(&json).ok())?;
    let expected = card_ids.iter().map(String::as_str).collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut buckets = Vec::<(String, Vec<String>)>::new();
    for assignment in classification.assignments {
        let label = assignment.leaf.trim().chars().take(72).collect::<String>();
        if !expected.contains(assignment.id.as_str())
            || label.is_empty()
            || !seen.insert(assignment.id.clone())
        {
            continue;
        }
        if let Some((_, members)) = buckets
            .iter_mut()
            .find(|(existing_label, _)| existing_label.eq_ignore_ascii_case(&label))
        {
            members.push(assignment.id);
        } else {
            buckets.push((label, vec![assignment.id]));
        }
    }
    if seen.len() != card_ids.len() {
        return None;
    }
    if depth >= 1 {
        return Some(buckets);
    }
    let mut refined = Vec::new();
    for (label, members) in buckets {
        if members.len() > 6 && members.len() < card_ids.len() {
            if let Some(children) =
                classify_study_web_leaves_inner(client, port, &label, &members, cards, depth + 1)
            {
                refined.extend(children);
            } else {
                refined.push((label, members));
            }
        } else {
            refined.push((label, members));
        }
    }
    Some(refined)
}

fn study_web_labels_match(left: &str, right: &str) -> bool {
    if left.trim().eq_ignore_ascii_case(right.trim()) {
        return true;
    }
    let left_words = study_web_label_words(left);
    let right_words = study_web_label_words(right);
    !left_words.is_empty()
        && !right_words.is_empty()
        && (left_words.is_subset(&right_words) || right_words.is_subset(&left_words))
}

fn study_web_label_words(value: &str) -> HashSet<String> {
    value
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| {
            word.len() >= 3
                && !matches!(
                    *word,
                    "system"
                        | "anatomy"
                        | "concept"
                        | "concepts"
                        | "terms"
                        | "term"
                        | "study"
                        | "material"
                        | "materials"
                )
        })
        .map(str::to_string)
        .collect()
}

#[allow(dead_code)]
fn infer_study_web_leaf_relationships(
    client: &reqwest::blocking::Client,
    port: u16,
    leaves: &[(String, String, String, Vec<String>)],
    cards: &[StudyWebSourceCard],
) -> Vec<StudyWebSemanticRelationship> {
    if leaves.is_empty() {
        return Vec::new();
    }
    let material = leaves
        .iter()
        .map(|(leaf_id, parent_id, label, members)| {
            let concepts = cards
                .iter()
                .filter(|card| members.contains(&card.id))
                .map(|card| {
                    serde_json::json!({
                        "id": card.id,
                        "term": card.front.chars().take(68).collect::<String>(),
                        "definition": card.back.chars().take(156).collect::<String>(),
                    })
                })
                .collect::<Vec<_>>();
            serde_json::json!({ "leaf_id": leaf_id, "parent_id": parent_id, "label": label, "cards": concepts })
        })
        .collect::<Vec<_>>();
    let maximum = leaves.len().saturating_mul(2).clamp(3, 28);
    let system = format!("You are the relationship verifier for an academic Study Web. Return only valid JSON: {{\"connections\":[{{\"source\":\"supplied card id\",\"target\":\"supplied card id\",\"relationship_type\":\"short exact relationship\",\"reason\":\"brief evidence from the supplied definitions\"}}]}}. Read every term and definition. Add at most {maximum} connections. A connection is allowed only when the two exact cards have a specific, direct relationship you can state clearly: part-whole, direct interaction, sequence, cause-effect, contrast, prerequisite, or a directly evidenced shared mechanism. Apply a replacement test before accepting a line: if either card could be swapped with another card from the same category without making the stated relation false, reject it. Never connect cards merely because they are in the same broad subject, category, region, list, or because they are analogous. Do not invent knowledge not supported by the supplied cards. If the connection is uncertain, omit it. Prefer no line over a questionable line. Every reason must name the precise relationship in at least six words; vague reasons such as 'both are related' are invalid. Do not add commentary, markdown, groups, coordinates, or IDs that were not supplied.");
    let prompt = format!(
        "LEAF GROUPS AND FLASHCARDS:\n{}\n\nReturn only the verified direct connections now.",
        serde_json::to_string(&material).unwrap_or_default()
    );
    let raw = match local_chat_text(client, port, &system, &prompt, 1500) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    let Some(plan) = json_object_from_response(&raw)
        .and_then(|json| serde_json::from_str::<StudyWebRelationshipPlan>(&json).ok())
    else {
        return Vec::new();
    };
    let valid_ids = cards.iter().map(|card| card.id.as_str()).collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    plan.connections
        .into_iter()
        .filter_map(|connection| {
            if connection.source == connection.target
                || connection.reason.split_whitespace().count() < 6
                || !valid_ids.contains(connection.source.as_str())
                || !valid_ids.contains(connection.target.as_str())
            {
                return None;
            }
            let (source, target) = if connection.source < connection.target {
                (connection.source, connection.target)
            } else {
                (connection.target, connection.source)
            };
            if !seen.insert((source.clone(), target.clone())) {
                return None;
            }
            let relationship_type = connection
                .relationship_type
                .trim()
                .chars()
                .take(32)
                .collect::<String>();
            Some(StudyWebSemanticRelationship {
                source,
                target,
                relationship_type: if relationship_type.is_empty() { "direct_relation".into() } else { relationship_type },
                strength: 0.8,
            })
        })
        .take(maximum)
        .collect()
}

#[allow(dead_code)]
fn infer_study_web_theme_bridges(
    client: &reqwest::blocking::Client,
    port: u16,
    themes: &[(String, String, Vec<String>)],
    cards: &[StudyWebSourceCard],
) -> Vec<StudyWebSemanticRelationship> {
    if themes.len() < 2 {
        return Vec::new();
    }
    let material = themes
        .iter()
        .map(|(id, label, members)| {
            let concepts = cards
                .iter()
                .filter(|card| members.contains(&card.id))
                .map(|card| {
                    serde_json::json!({
                        "id": card.id,
                        "term": card.front.chars().take(68).collect::<String>(),
                        "definition": card.back.chars().take(88).collect::<String>(),
                    })
                })
                .collect::<Vec<_>>();
            serde_json::json!({ "parent_id": id, "theme": label, "cards": concepts })
        })
        .collect::<Vec<_>>();
    let system = "You are creating verified bridges between themes in an academic Study Web. Return only valid JSON with exactly one key, connections. connections is an array of no more than one fewer than the supplied parent themes. Every item has exactly these string keys: source_parent, target_parent, source, target, reason. parent values must be supplied parent_id values. source and target must be supplied card IDs from their named parent themes. A bridge is allowed only if those two exact cards have a direct, specific relationship that is supported by the supplied definitions. Apply a replacement test: if either selected card could be replaced by another card from its theme without making the reason false, reject it. Do not use a generic controller, representative, or broad category as a hub. Do not connect themes merely because both are academic material or share a broad subject. reason must name the precise direct relation in at least six words. If no exact bridge is supported, return fewer connections. Never invent IDs, commentary, labels, markdown, or extra keys.";
    let prompt = format!(
        "PARENT THEMES:\n{}\n\nReturn the theme bridges now.",
        serde_json::to_string(&material).unwrap_or_default()
    );
    let raw = match local_chat_text(client, port, system, &prompt, 800) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    let Some(plan) = json_object_from_response(&raw)
        .and_then(|json| serde_json::from_str::<StudyWebThemeBridgePlan>(&json).ok())
    else {
        return Vec::new();
    };
    let members_by_parent = themes
        .iter()
        .map(|(id, _, members)| (id.as_str(), members.iter().map(String::as_str).collect::<HashSet<_>>()))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    plan.connections
        .into_iter()
        .filter_map(|bridge| {
            if bridge.source_parent == bridge.target_parent
                || bridge.reason.split_whitespace().count() < 6
                || !members_by_parent
                    .get(bridge.source_parent.as_str())
                    .is_some_and(|members| members.contains(bridge.source.as_str()))
                || !members_by_parent
                    .get(bridge.target_parent.as_str())
                    .is_some_and(|members| members.contains(bridge.target.as_str()))
            {
                return None;
            }
            let (source, target) = if bridge.source < bridge.target {
                (bridge.source, bridge.target)
            } else {
                (bridge.target, bridge.source)
            };
            seen.insert((source.clone(), target.clone())).then_some(StudyWebSemanticRelationship {
                source,
                target,
                relationship_type: "theme_bridge".into(),
                strength: 0.68,
            })
        })
        .take(themes.len().saturating_sub(1))
        .collect()
}

#[allow(dead_code)]
fn infer_study_web_relationships(
    cards: &[StudyWebSourceCard],
    leaves: &[(String, String, String, Vec<String>)],
) -> Vec<StudyWebSemanticRelationship> {
    let raw_tokens = cards
        .iter()
        .map(|card| {
            (
                card.id.clone(),
                study_web_relation_words(&format!("{} {}", card.front, card.back)),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut frequency = HashMap::<String, usize>::new();
    for tokens in raw_tokens.values() {
        for token in tokens {
            *frequency.entry(token.clone()).or_default() += 1;
        }
    }
    let max_shared_frequency = (cards.len() / 10).max(3);
    let tokens = raw_tokens
        .into_iter()
        .map(|(id, values)| {
            (
                id,
                values
                    .into_iter()
                    .filter(|token| {
                        frequency.get(token).copied().unwrap_or(0) <= max_shared_frequency
                    })
                    .collect::<HashSet<_>>(),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    let mut add_edge = |source: &String, target: &String, kind: &str, score: f64| {
        let (source, target) = if source < target {
            (source.clone(), target.clone())
        } else {
            (target.clone(), source.clone())
        };
        if seen.insert((source.clone(), target.clone())) {
            edges.push(StudyWebSemanticRelationship {
                source,
                target,
                relationship_type: kind.into(),
                strength: (0.42 + score / 7.0).clamp(0.42, 0.9),
            });
        }
    };
    for (_, _, _, members) in leaves {
        let mut candidates = Vec::new();
        for left in 0..members.len() {
            for right in (left + 1)..members.len() {
                let score = study_web_relationship_score(
                    &members[left],
                    &members[right],
                    &tokens,
                    &frequency,
                    cards.len(),
                    max_shared_frequency,
                );
                // A direct card-to-card line should have more than a passing
                // vocabulary overlap. Broader map structure is represented
                // separately by group backbones, so weak matches do not need
                // to pretend to be factual relationships.
                if score >= 2.8 {
                    candidates.push((score, &members[left], &members[right]));
                }
            }
        }
        candidates.sort_by(|left, right| right.0.total_cmp(&left.0));
        for (score, source, target) in candidates
            .into_iter()
            .take(members.len().saturating_sub(1).min(3))
        {
            add_edge(source, target, "direct_relation", score);
        }
        // A leaf is already a semantic decision made from the cards' full
        // definitions. Keep that cluster visually connected even when two
        // related cards do not happen to repeat the same uncommon wording.
        // These are explicitly stored as shared-subgroup links, not claimed
        // as direct factual relationships.
        if let Some(anchor) = members.iter().max_by(|left, right| {
            let left_score = members
                .iter()
                .filter(|other| *other != *left)
                .map(|other| {
                    study_web_relationship_score(
                        left,
                        other,
                        &tokens,
                        &frequency,
                        cards.len(),
                        max_shared_frequency,
                    )
                })
                .sum::<f64>();
            let right_score = members
                .iter()
                .filter(|other| *other != *right)
                .map(|other| {
                    study_web_relationship_score(
                        right,
                        other,
                        &tokens,
                        &frequency,
                        cards.len(),
                        max_shared_frequency,
                    )
                })
                .sum::<f64>();
            left_score.total_cmp(&right_score)
        }) {
            for member in members {
                if member != anchor {
                    add_edge(anchor, member, "shared_subgroup", 0.5);
                }
            }
        }
    }
    let mut bridge_candidates = Vec::new();
    for left in 0..leaves.len() {
        for right in (left + 1)..leaves.len() {
            if leaves[left].1 != leaves[right].1 {
                continue;
            }
            let mut best = None;
            for source in &leaves[left].3 {
                for target in &leaves[right].3 {
                    let score = study_web_relationship_score(
                        source,
                        target,
                        &tokens,
                        &frequency,
                        cards.len(),
                        max_shared_frequency,
                    );
                    if score >= 3.0
                        && best
                            .as_ref()
                            .map_or(true, |(best_score, _, _)| score > *best_score)
                    {
                        best = Some((score, source.clone(), target.clone()));
                    }
                }
            }
            if let Some(candidate) = best {
                bridge_candidates.push(candidate);
            }
        }
    }
    bridge_candidates.sort_by(|left, right| right.0.total_cmp(&left.0));
    for (score, source, target) in bridge_candidates.into_iter().take(leaves.len().min(18)) {
        add_edge(&source, &target, "cluster_bridge", score);
    }

    // The AI's two-level grouping is also meaningful map structure. Build a
    // lightweight backbone through those groups so every leaf has a path to
    // every other leaf, even when neighboring concepts use different words.
    // These links deliberately describe hierarchy, never a made-up factual
    // relationship between the two cards.
    let mut leaves_by_parent = Vec::<(String, Vec<&(String, String, String, Vec<String>)>)>::new();
    for leaf in leaves {
        if let Some((_, children)) = leaves_by_parent
            .iter_mut()
            .find(|(parent_id, _)| parent_id == &leaf.1)
        {
            children.push(leaf);
        } else {
            leaves_by_parent.push((leaf.1.clone(), vec![leaf]));
        }
    }
    let mut parent_roots = Vec::<(String, String, usize)>::new();
    for (parent_id, children) in leaves_by_parent {
        let Some(root_leaf) = children.iter().max_by(|left, right| {
            left.3
                .len()
                .cmp(&right.3.len())
                .then_with(|| left.0.cmp(&right.0))
        }) else {
            continue;
        };
        let Some(root_card) = study_web_group_anchor(
            &root_leaf.3,
            &tokens,
            &frequency,
            cards.len(),
            max_shared_frequency,
        ) else {
            continue;
        };
        let total_members = children.iter().map(|leaf| leaf.3.len()).sum();
        for leaf in &children {
            if leaf.0 == root_leaf.0 {
                continue;
            }
            if let Some(child_card) = study_web_group_anchor(
                &leaf.3,
                &tokens,
                &frequency,
                cards.len(),
                max_shared_frequency,
            ) {
                add_edge(&root_card, &child_card, "parent_backbone", 0.68);
            }
        }
        parent_roots.push((parent_id, root_card, total_members));
    }
    if let Some((root_parent, root_card, _)) = parent_roots.iter().max_by(|left, right| {
        left.2
            .cmp(&right.2)
            .then_with(|| left.0.cmp(&right.0))
    }) {
        for (parent_id, card_id, _) in &parent_roots {
            if parent_id != root_parent {
                add_edge(root_card, card_id, "theme_backbone", 0.82);
            }
        }
    }
    edges
}

#[allow(dead_code)]
fn study_web_group_anchor(
    members: &[String],
    tokens: &HashMap<String, HashSet<String>>,
    frequency: &HashMap<String, usize>,
    total_cards: usize,
    max_shared_frequency: usize,
) -> Option<String> {
    members
        .iter()
        .max_by(|left, right| {
            let score = |candidate: &String| {
                members
                    .iter()
                    .filter(|other| *other != candidate)
                    .map(|other| {
                        study_web_relationship_score(
                            candidate,
                            other,
                            tokens,
                            frequency,
                            total_cards,
                            max_shared_frequency,
                        )
                    })
                    .sum::<f64>()
            };
            score(left).total_cmp(&score(right))
        })
        .cloned()
}

#[allow(dead_code)]
fn study_web_relation_words(value: &str) -> HashSet<String> {
    value
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| {
            word.len() >= 3
                && !matches!(
                    *word,
                    "the"
                        | "and"
                        | "for"
                        | "with"
                        | "from"
                        | "into"
                        | "that"
                        | "this"
                        | "these"
                        | "those"
                        | "which"
                        | "when"
                        | "where"
                        | "while"
                        | "than"
                        | "then"
                        | "are"
                        | "was"
                        | "were"
                        | "has"
                        | "have"
                        | "had"
                        | "can"
                        | "may"
                        | "its"
                        | "their"
                        | "they"
                        | "used"
                        | "use"
                        | "also"
                        | "often"
                        | "part"
                        | "type"
                        | "term"
                        | "definition"
                        | "concept"
                )
        })
        .map(str::to_string)
        .collect()
}

#[allow(dead_code)]
fn study_web_relationship_score(
    source: &str,
    target: &str,
    tokens: &HashMap<String, HashSet<String>>,
    frequency: &HashMap<String, usize>,
    total_cards: usize,
    max_shared_frequency: usize,
) -> f64 {
    let (Some(source_tokens), Some(target_tokens)) = (tokens.get(source), tokens.get(target))
    else {
        return 0.0;
    };
    source_tokens
        .intersection(target_tokens)
        .filter_map(|token| {
            frequency
                .get(token)
                .copied()
                .filter(|count| *count <= max_shared_frequency)
        })
        .map(|count| (total_cards as f64 / count as f64).ln_1p())
        .sum()
}

fn remap_study_web_plan_ids(
    mut plan: StudyWebSemanticPlan,
    model_cards: &[StudyWebSourceCard],
    cards: &[StudyWebSourceCard],
) -> StudyWebSemanticPlan {
    let card_ids = model_cards
        .iter()
        .zip(cards.iter())
        .map(|(model_card, card)| (model_card.id.as_str(), card.id.clone()))
        .collect::<HashMap<_, _>>();
    for group in &mut plan.groups {
        group.members = group
            .members
            .iter()
            .filter_map(|id| card_ids.get(id.as_str()).cloned())
            .collect();
    }
    plan.relationships = plan
        .relationships
        .into_iter()
        .filter_map(|mut relationship| {
            relationship.source = card_ids.get(relationship.source.as_str())?.clone();
            relationship.target = card_ids.get(relationship.target.as_str())?.clone();
            Some(relationship)
        })
        .collect();
    plan
}

fn study_web_plan_has_hierarchy(plan: &StudyWebSemanticPlan, cards: &[StudyWebSourceCard]) -> bool {
    let groups_by_id = plan
        .groups
        .iter()
        .map(|group| (group.id.as_str(), group))
        .collect::<HashMap<_, _>>();
    let leaves = plan
        .groups
        .iter()
        .filter(|group| {
            group
                .parent_id
                .as_ref()
                .is_some_and(|parent_id| groups_by_id.contains_key(parent_id.as_str()))
        })
        .collect::<Vec<_>>();
    if cards.len() > 3 && leaves.len() < 2 {
        return false;
    }
    if leaves.is_empty() {
        return false;
    }
    let mut children_by_parent = HashMap::<&str, Vec<&StudyWebSemanticGroup>>::new();
    for leaf in &leaves {
        children_by_parent
            .entry(leaf.parent_id.as_deref().unwrap_or_default())
            .or_default()
            .push(*leaf);
    }
    if children_by_parent.is_empty()
        || (leaves.len() > 1
            && children_by_parent
                .values()
                .all(|children| children.len() < 2))
    {
        return false;
    }
    if leaves.len() >= 4
        && leaves
            .iter()
            .filter(|group| group.members.len() <= 1)
            .count()
            * 2
            > leaves.len()
    {
        return false;
    }
    let leaf_members = leaves
        .iter()
        .flat_map(|group| group.members.iter().map(String::as_str))
        .collect::<HashSet<_>>();
    if cards
        .iter()
        .any(|card| !leaf_members.contains(card.id.as_str()))
    {
        return false;
    }
    children_by_parent.into_keys().all(|parent_id| {
        groups_by_id
            .get(parent_id)
            .is_some_and(|parent| parent.members.is_empty())
    })
}

#[allow(unreachable_code)]
fn fallback_study_web_plan(cards: &[StudyWebSourceCard]) -> StudyWebSemanticPlan {
    // The fallback intentionally makes no semantic claims. The normal two-pass
    // model path supplies descriptive clusters and edges; if it is unavailable,
    // preserving cards is safer than drawing a relationship from coincidence.
    let groups = cards
        .chunks(4)
        .enumerate()
        .map(|(index, chunk)| {
            let first_term = chunk
                .first()
                .map(|card| card.front.trim().chars().take(42).collect::<String>())
                .unwrap_or_default();
            StudyWebSemanticGroup {
                id: format!("fallback-{index}"),
                label: if first_term.is_empty() {
                    "Study material".into()
                } else {
                    format!("{first_term} and related")
                },
                members: chunk.iter().map(|card| card.id.clone()).collect(),
                parent_id: None,
            }
        })
        .collect();
    return StudyWebSemanticPlan {
        groups,
        relationships: Vec::new(),
    };

    let mut buckets: HashMap<char, Vec<String>> = HashMap::new();
    for card in cards {
        let key = card
            .front
            .chars()
            .find(|character| character.is_alphanumeric())
            .map(|character| character.to_ascii_uppercase())
            .unwrap_or('#');
        buckets.entry(key).or_default().push(card.id.clone());
    }
    let mut groups = buckets
        .into_iter()
        .enumerate()
        .map(|(index, (key, members))| StudyWebSemanticGroup {
            id: format!("fallback-{index}"),
            label: if key == '#' {
                "Core concepts".into()
            } else {
                format!("Concepts · {key}")
            },
            members,
            parent_id: None,
        })
        .collect::<Vec<_>>();
    if groups.len() > 8 {
        groups = vec![StudyWebSemanticGroup {
            id: "fallback-core".into(),
            label: "Core concepts".into(),
            members: cards.iter().map(|card| card.id.clone()).collect(),
            parent_id: None,
        }];
    }
    // Keep a useful, visible web even if the local model is unavailable or returns
    // incomplete JSON. These are deterministic keyword connections, never made-up
    // content, and the model's relationships still take precedence when present.
    let words = cards
        .iter()
        .map(|card| {
            format!("{} {}", card.front, card.back)
                .to_lowercase()
                .split(|character: char| !character.is_alphanumeric())
                .filter(|word| {
                    word.len() >= 4
                        && !matches!(
                            *word,
                            "this"
                                | "that"
                                | "with"
                                | "from"
                                | "into"
                                | "your"
                                | "what"
                                | "when"
                                | "which"
                                | "about"
                                | "there"
                                | "their"
                                | "have"
                                | "will"
                                | "would"
                                | "could"
                                | "should"
                                | "definition"
                                | "concept"
                        )
                })
                .map(str::to_string)
                .collect::<HashSet<_>>()
        })
        .collect::<Vec<_>>();
    let mut candidates = Vec::new();
    for left in 0..cards.len() {
        for right in (left + 1)..cards.len() {
            let shared = words[left].intersection(&words[right]).count();
            if shared > 0 {
                candidates.push((
                    shared as f64 / words[left].len().min(words[right].len()).max(1) as f64,
                    left,
                    right,
                ));
            }
        }
    }
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut degree = vec![0_usize; cards.len()];
    let mut linked = HashSet::new();
    let mut relationships = Vec::new();
    for (score, left, right) in candidates {
        if degree[left] >= 2 || degree[right] >= 2 || !linked.insert((left, right)) {
            continue;
        }
        degree[left] += 1;
        degree[right] += 1;
        relationships.push(StudyWebSemanticRelationship {
            source: cards[left].id.clone(),
            target: cards[right].id.clone(),
            relationship_type: "related_to".into(),
            strength: (0.35 + score).clamp(0.35, 0.9),
        });
    }
    // A category should never render as isolated cards. Link adjacent members as a
    // calm visual fallback when their wording has little overlap.
    for group in &groups {
        for pair in group.members.windows(2) {
            let Some(left) = cards.iter().position(|card| card.id == pair[0]) else {
                continue;
            };
            let Some(right) = cards.iter().position(|card| card.id == pair[1]) else {
                continue;
            };
            let key = if left < right {
                (left, right)
            } else {
                (right, left)
            };
            if linked.insert(key) {
                relationships.push(StudyWebSemanticRelationship {
                    source: cards[left].id.clone(),
                    target: cards[right].id.clone(),
                    relationship_type: "related_to".into(),
                    strength: 0.42,
                });
            }
        }
    }
    StudyWebSemanticPlan {
        groups,
        relationships,
    }
}

fn save_generated_study_web(
    database: &Database,
    class_id: &str,
    set_ids: &[String],
    set_titles: &[String],
    cards: &[StudyWebSourceCard],
    plan: StudyWebSemanticPlan,
    study_web_id: Option<String>,
) -> CommandResult<StudyWebDetail> {
    let primary_set_id = set_ids
        .first()
        .ok_or_else(|| "Choose at least one flashcard set for this Study Web.".to_string())?;
    let known = cards
        .iter()
        .map(|card| card.id.clone())
        .collect::<HashSet<_>>();
    let parent_group_ids = plan
        .groups
        .iter()
        .filter_map(|group| group.parent_id.clone())
        .collect::<HashSet<_>>();
    let mut semantic_group_ids = HashSet::new();
    let mut groups = plan
        .groups
        .into_iter()
        .filter_map(|group| {
            let id = group.id.trim().to_string();
            let label = group.label.trim().chars().take(72).collect::<String>();
            if id.is_empty() || label.is_empty() || !semantic_group_ids.insert(id.clone()) {
                return None;
            }
            let mut member_ids = HashSet::new();
            let members = group
                .members
                .into_iter()
                .filter(|member| known.contains(member) && member_ids.insert(member.clone()))
                .collect::<Vec<_>>();
            if members.is_empty() && !parent_group_ids.contains(&id) {
                return None;
            }
            Some((id, label, group.parent_id, members))
        })
        .collect::<Vec<_>>();
    let grouped = groups
        .iter()
        .flat_map(|(_, _, _, members)| members.iter().cloned())
        .collect::<HashSet<_>>();
    let missing = cards
        .iter()
        .filter(|card| !grouped.contains(&card.id))
        .map(|card| card.id.clone())
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        groups.push((
            "unassigned".into(),
            "Unassigned study material".into(),
            None,
            missing,
        ));
    }
    if groups.is_empty() {
        groups.push((
            "unassigned".into(),
            "Unassigned study material".into(),
            None,
            cards.iter().map(|card| card.id.clone()).collect(),
        ));
    }
    let mut seen_edges = HashSet::new();
    let mut edges = Vec::new();
    for relationship in plan.relationships {
        if !known.contains(&relationship.source)
            || !known.contains(&relationship.target)
            || relationship.source == relationship.target
        {
            continue;
        }
        let (source, target) = if relationship.source < relationship.target {
            (relationship.source, relationship.target)
        } else {
            (relationship.target, relationship.source)
        };
        if !seen_edges.insert((source.clone(), target.clone())) {
            continue;
        }
        let relationship_type = relationship
            .relationship_type
            .trim()
            .chars()
            .take(32)
            .collect::<String>();
        edges.push((
            source,
            target,
            if relationship_type.is_empty() {
                "related_to".into()
            } else {
                relationship_type
            },
            relationship.strength.clamp(0.1, 1.0),
        ));
    }
    // Groups influence layout and their label only. A visible line must come
    // from the model's direct reasoning or a manual link, never card order.
    let positions = layout_study_web_nodes(cards, &groups, &edges);
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let web_id = study_web_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    if let Some(existing_set) = transaction
        .query_row(
            "SELECT flashcard_set_id FROM study_webs WHERE id=?1",
            [&web_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
    {
        if existing_set != *primary_set_id {
            return Err("That Study Web belongs to a different flashcard set.".into());
        }
        transaction
            .execute("DELETE FROM study_webs WHERE id=?1", [&web_id])
            .map_err(|error| error.to_string())?;
    }
    let name = if set_titles.len() == 1 {
        format!("{} Study Web", set_titles[0].trim())
    } else {
        format!("{} sets Study Web", set_titles.len())
    };
    transaction.execute("INSERT INTO study_webs (id, class_id, flashcard_set_id, name, source_hash) VALUES (?1,?2,?3,?4,?5)", params![&web_id, class_id, primary_set_id, name, study_web_source_hash(cards)]).map_err(|error| error.to_string())?;
    for (position, set_id) in set_ids.iter().enumerate() {
        transaction.execute("INSERT INTO study_web_sources (study_web_id, flashcard_set_id, position) VALUES (?1,?2,?3)", params![&web_id, set_id, position as i32]).map_err(|error| error.to_string())?;
    }
    let mut saved_group_ids = HashMap::new();
    for (semantic_id, label, _, members) in &groups {
        let group_id = Uuid::new_v4().to_string();
        saved_group_ids.insert(semantic_id.clone(), group_id.clone());
        transaction.execute("INSERT INTO study_web_groups (id, study_web_id, label, parent_group_id) VALUES (?1,?2,?3,NULL)", params![&group_id, &web_id, label]).map_err(|error| error.to_string())?;
        for card_id in members {
            transaction.execute("INSERT INTO study_web_group_members (study_web_id, group_id, flashcard_id) VALUES (?1,?2,?3)", params![&web_id, &group_id, card_id]).map_err(|error| error.to_string())?;
        }
    }
    for (semantic_id, _, parent_semantic_id, _) in &groups {
        let Some(parent_semantic_id) = parent_semantic_id else {
            continue;
        };
        let (Some(group_id), Some(parent_group_id)) = (
            saved_group_ids.get(semantic_id),
            saved_group_ids.get(parent_semantic_id),
        ) else {
            continue;
        };
        transaction
            .execute(
                "UPDATE study_web_groups SET parent_group_id=?1 WHERE id=?2",
                params![parent_group_id, group_id],
            )
            .map_err(|error| error.to_string())?;
    }
    for card in cards {
        let (x, y) = positions.get(&card.id).copied().unwrap_or((0.0, 0.0));
        transaction.execute("INSERT INTO study_web_nodes (study_web_id, flashcard_id, x, y) VALUES (?1,?2,?3,?4)", params![&web_id, &card.id, x, y]).map_err(|error| error.to_string())?;
    }
    for (source, target, relationship_type, strength) in edges {
        transaction.execute("INSERT INTO study_web_relationships (id, study_web_id, source_flashcard_id, target_flashcard_id, relationship_type, strength) VALUES (?1,?2,?3,?4,?5,?6)", params![Uuid::new_v4().to_string(), &web_id, source, target, relationship_type, strength]).map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    read_study_web_detail(&database.open()?, &web_id)
}

fn study_web_hierarchy_layout_edges(
    groups: &[(String, String, Option<String>, Vec<String>)],
) -> Vec<(String, String, String, f64)> {
    let members = groups
        .iter()
        .map(|(id, _, _, cards)| (id.clone(), cards.clone()))
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<String, Vec<String>>::new();
    let mut roots = Vec::new();
    for (id, _, parent_id, _) in groups {
        if let Some(parent_id) = parent_id
            .as_ref()
            .filter(|parent| members.contains_key(*parent))
        {
            children.entry(parent_id.clone()).or_default().push(id.clone());
        } else {
            roots.push(id.clone());
        }
    }
    fn anchor(
        group_id: &str,
        members: &HashMap<String, Vec<String>>,
        children: &HashMap<String, Vec<String>>,
        visiting: &mut HashSet<String>,
    ) -> Option<String> {
        if !visiting.insert(group_id.to_string()) {
            return None;
        }
        let result = members
            .get(group_id)
            .and_then(|cards| cards.first().cloned())
            .or_else(|| {
                children.get(group_id).and_then(|child_ids| {
                    child_ids
                        .iter()
                        .find_map(|child_id| anchor(child_id, members, children, visiting))
                })
            });
        visiting.remove(group_id);
        result
    }
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |source: Option<String>, target: Option<String>, name: String| {
        let (Some(source), Some(target)) = (source, target) else {
            return;
        };
        if source == target {
            return;
        }
        let key = if source < target {
            (source.clone(), target.clone())
        } else {
            (target.clone(), source.clone())
        };
        if seen.insert(key.clone()) {
            edges.push((key.0, key.1, name, 0.9));
        }
    };
    for (group_id, _, _, cards) in groups {
        let own_anchor = cards.first().cloned();
        for card_id in cards.iter().skip(1) {
            add(own_anchor.clone(), Some(card_id.clone()), "hierarchy_leaf".into());
        }
        let child_anchors = children
            .get(group_id)
            .into_iter()
            .flatten()
            .filter_map(|child_id| anchor(child_id, &members, &children, &mut HashSet::new()))
            .collect::<Vec<_>>();
        let group_anchor = own_anchor.or_else(|| child_anchors.first().cloned());
        for child_anchor in child_anchors {
            add(group_anchor.clone(), Some(child_anchor), "hierarchy_group".into());
        }
    }
    let root_anchors = roots
        .iter()
        .filter_map(|root_id| anchor(root_id, &members, &children, &mut HashSet::new()))
        .collect::<Vec<_>>();
    for pair in root_anchors.windows(2) {
        add(Some(pair[0].clone()), Some(pair[1].clone()), "hierarchy_root".into());
    }
    edges
}

fn layout_study_web_nodes(
    cards: &[StudyWebSourceCard],
    groups: &[(String, String, Option<String>, Vec<String>)],
    edges: &[(String, String, String, f64)],
) -> HashMap<String, (f64, f64)> {
    let mut layout_edges = study_web_hierarchy_layout_edges(groups);
    layout_edges.extend(edges.iter().cloned());
    let parent_ids = groups
        .iter()
        .filter_map(|(_, _, parent_id, _)| parent_id.clone())
        .collect::<HashSet<_>>();
    let mut leaf_indices = groups
        .iter()
        .enumerate()
        .filter_map(|(index, (id, _, _, _))| (!parent_ids.contains(id)).then_some(index))
        .collect::<Vec<_>>();
    if leaf_indices.is_empty() {
        leaf_indices = (0..groups.len()).collect();
    }
    let mut parent_clusters = Vec::<(String, Vec<usize>)>::new();
    for group_index in &leaf_indices {
        let parent_key = groups[*group_index]
            .2
            .clone()
            .unwrap_or_else(|| format!("root-{group_index}"));
        if let Some((_, children)) = parent_clusters.iter_mut().find(|(id, _)| id == &parent_key) {
            children.push(*group_index);
        } else {
            parent_clusters.push((parent_key, vec![*group_index]));
        }
    }
    // Give broad themes a compact ring rather than distant grid cells. The
    // subgroup tree and its card links then keep the whole web coherent.
    let parent_count = parent_clusters.len().max(1);
    let parent_radius = if parent_count <= 1 {
        0.0
    } else {
        360.0 + (parent_count.saturating_sub(2) as f64 * 62.0)
    };
    let mut leaf_centers = HashMap::<usize, (f64, f64)>::new();
    for (parent_index, (_, children)) in parent_clusters.iter().enumerate() {
        let parent_angle = if parent_count <= 1 {
            0.0
        } else {
            parent_index as f64 / parent_count as f64 * std::f64::consts::TAU
                - std::f64::consts::FRAC_PI_2
        };
        let parent_x = parent_angle.cos() * parent_radius;
        let parent_y = parent_angle.sin() * parent_radius * 0.74;
        for (child_index, group_index) in children.iter().enumerate() {
            let count = children.len();
            let angle = if count <= 1 {
                0.0
            } else {
                child_index as f64 / count as f64 * std::f64::consts::TAU
                    - std::f64::consts::FRAC_PI_2
            };
            let radius = if count <= 1 {
                0.0
            } else if count <= 4 {
                210.0
            } else {
                255.0 + ((child_index / 5) as f64 * 58.0)
            };
            leaf_centers.insert(
                *group_index,
                (
                    parent_x + angle.cos() * radius,
                    parent_y + angle.sin() * radius,
                ),
            );
        }
    }
    let mut group_members = HashMap::<String, Vec<(f64, f64, usize, usize)>>::new();
    for group_index in &leaf_indices {
        let members = &groups[*group_index].3;
        let (center_x, center_y) = leaf_centers.get(group_index).copied().unwrap_or_default();
        for (member_index, card_id) in members.iter().enumerate() {
            group_members.entry(card_id.clone()).or_default().push((
                center_x,
                center_y,
                member_index,
                members.len(),
            ));
        }
    }
    let mut positions = HashMap::new();
    for card in cards {
        let memberships = group_members
            .get(&card.id)
            .cloned()
            .unwrap_or_else(|| vec![(0.0, 0.0, positions.len(), cards.len())]);
        let (mut x, mut y) = (0.0, 0.0);
        for (center_x, center_y, member_index, member_count) in &memberships {
            let angle = if *member_count <= 1 {
                0.0
            } else {
                *member_index as f64 / *member_count as f64 * std::f64::consts::TAU
                    - std::f64::consts::FRAC_PI_2
            };
            let local_radius = if *member_count <= 1 {
                0.0
            } else if *member_count <= 4 {
                112.0
            } else {
                136.0 + ((*member_index / 6) as f64 * 42.0)
            };
            x += *center_x + angle.cos() * local_radius;
            y += *center_y + angle.sin() * local_radius;
        }
        positions.insert(
            card.id.clone(),
            (x / memberships.len() as f64, y / memberships.len() as f64),
        );
    }
    for _ in 0..180 {
        let mut delta = cards
            .iter()
            .map(|card| (card.id.clone(), (0.0_f64, 0.0_f64)))
            .collect::<HashMap<_, _>>();
        for left in 0..cards.len() {
            for right in left + 1..cards.len() {
                let a = positions[&cards[left].id];
                let b = positions[&cards[right].id];
                let dx = a.0 - b.0;
                let dy = a.1 - b.1;
                let distance = (dx * dx + dy * dy).sqrt().max(1.0);
                let force = 24_000.0 / (distance * distance)
                    + (278.0 - distance).max(0.0) * 0.17;
                let unit = (dx / distance * force, dy / distance * force);
                if let Some(value) = delta.get_mut(&cards[left].id) {
                    value.0 += unit.0;
                    value.1 += unit.1;
                }
                if let Some(value) = delta.get_mut(&cards[right].id) {
                    value.0 -= unit.0;
                    value.1 -= unit.1;
                }
            }
        }
        for (source, target, _, strength) in &layout_edges {
            if let (Some(a), Some(b)) = (positions.get(source), positions.get(target)) {
                let dx = b.0 - a.0;
                let dy = b.1 - a.1;
                let distance = (dx * dx + dy * dy).sqrt().max(1.0);
                let force = (distance - 260.0) * 0.052 * strength;
                let unit = (dx / distance * force, dy / distance * force);
                if let Some(value) = delta.get_mut(source) {
                    value.0 += unit.0;
                    value.1 += unit.1;
                }
                if let Some(value) = delta.get_mut(target) {
                    value.0 -= unit.0;
                    value.1 -= unit.1;
                }
            }
        }
        for (id, movement) in delta {
            if let Some(position) = positions.get_mut(&id) {
                position.0 += movement.0.clamp(-18.0, 18.0);
                position.1 += movement.1.clamp(-18.0, 18.0);
            }
        }
    }
    let min_x = positions
        .values()
        .map(|position| position.0)
        .fold(f64::INFINITY, f64::min);
    let min_y = positions
        .values()
        .map(|position| position.1)
        .fold(f64::INFINITY, f64::min);
    for position in positions.values_mut() {
        position.0 = (position.0 - min_x + 240.0).round();
        position.1 = (position.1 - min_y + 220.0).round();
    }
    positions
}

#[tauri::command]
pub fn record_card_response(
    database: State<'_, Database>,
    input: RecordCardResponseInput,
) -> CommandResult<CardProgress> {
    let connection = database.open()?;
    let existing: Option<CardProgress> = connection.query_row("SELECT card_id, mastery, correct_count, incorrect_count, consecutive_correct, last_seen_at, due_at FROM card_progress WHERE card_id=?1", [&input.card_id], read_card_progress).ok();
    let progress = existing.unwrap_or(CardProgress {
        card_id: input.card_id.clone(),
        mastery: "new".into(),
        correct_count: 0,
        incorrect_count: 0,
        consecutive_correct: 0,
        last_seen_at: None,
        due_at: None,
    });
    let (correct, incorrect, streak) = if input.is_correct {
        (
            progress.correct_count + 1,
            progress.incorrect_count,
            progress.consecutive_correct + 1,
        )
    } else {
        (progress.correct_count, progress.incorrect_count + 1, 0)
    };
    let mastery = if !input.is_correct && incorrect >= 3 && incorrect > correct {
        "needsWork"
    } else if !input.is_correct {
        "learning"
    } else if streak >= 5 {
        "mastered"
    } else if streak >= 3 {
        "familiar"
    } else {
        "learning"
    };
    let review_days = if input.is_correct {
        match streak {
            0 | 1 => 1,
            2 => 3,
            3 => 7,
            4 => 14,
            5 => 30,
            _ => 45,
        }
    } else {
        1
    };
    // Keep this in SQLite's native timestamp form so the due-card query can compare
    // values correctly without a timezone-string lexical mismatch.
    let due_at = (chrono::Utc::now() + chrono::Duration::days(review_days))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    connection.execute("INSERT INTO card_progress (card_id, mastery, correct_count, incorrect_count, consecutive_correct, last_seen_at, due_at) VALUES (?1,?2,?3,?4,?5,CURRENT_TIMESTAMP,?6) ON CONFLICT(card_id) DO UPDATE SET mastery=excluded.mastery, correct_count=excluded.correct_count, incorrect_count=excluded.incorrect_count, consecutive_correct=excluded.consecutive_correct, last_seen_at=excluded.last_seen_at, due_at=excluded.due_at", params![input.card_id, mastery, correct, incorrect, streak, due_at]).map_err(|error| error.to_string())?;
    if let Some(session_id) = input.session_id.as_deref() {
        connection.execute("INSERT INTO study_responses (id, session_id, card_id, question_type, is_correct, answer) VALUES (?1,?2,?3,?4,?5,?6)", params![Uuid::new_v4().to_string(), session_id, input.card_id, input.question_type.unwrap_or_else(|| input.mode.unwrap_or_else(|| "review".into())), input.is_correct as i32, input.answer]).map_err(|error| error.to_string())?;
    }
    Ok(CardProgress {
        card_id: progress.card_id,
        mastery: mastery.into(),
        correct_count: correct,
        incorrect_count: incorrect,
        consecutive_correct: streak,
        last_seen_at: Some(chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()),
        due_at: Some(due_at),
    })
}

#[tauri::command]
pub fn start_study_session(
    database: State<'_, Database>,
    input: StartStudySessionInput,
) -> CommandResult<StudySessionSummary> {
    let connection = database.open()?;
    let class_id: String = connection
        .query_row(
            "SELECT class_id FROM flashcard_sets WHERE id=?1",
            [&input.set_id],
            |row| row.get(0),
        )
        .map_err(|_| "That study set could not be found.".to_string())?;
    let id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT INTO study_sessions (id, set_id, class_id, mode) VALUES (?1,?2,?3,?4)",
            params![id, input.set_id, class_id, input.mode],
        )
        .map_err(|error| error.to_string())?;
    connection.query_row("SELECT id, set_id, class_id, mode, started_at, completed_at FROM study_sessions WHERE id=?1", [&id], |row| Ok(StudySessionSummary { id: row.get(0)?, set_id: row.get(1)?, class_id: row.get(2)?, mode: row.get(3)?, started_at: row.get(4)?, completed_at: row.get(5)? })).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn complete_study_session(
    database: State<'_, Database>,
    input: CompleteStudySessionInput,
) -> CommandResult<()> {
    database
        .open()?
        .execute(
            "UPDATE study_sessions SET completed_at=CURRENT_TIMESTAMP WHERE id=?1",
            [&input.id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_study_insights(
    database: State<'_, Database>,
    class_id: String,
) -> CommandResult<StudyInsights> {
    let connection = database.open()?;
    let mut counts = [0_i32; 6];
    let mut statement = connection.prepare("SELECT COALESCE(p.mastery, 'new'), COUNT(*) FROM flashcards c INNER JOIN flashcard_sets s ON s.id=c.set_id LEFT JOIN card_progress p ON p.card_id=c.id WHERE s.class_id=?1 AND s.is_study_web_private=0 AND s.deleted_at IS NULL GROUP BY COALESCE(p.mastery, 'new')").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([&class_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (mastery, count) = row.map_err(|error| error.to_string())?;
        match mastery.as_str() {
            "learning" => counts[1] = count,
            "familiar" => counts[2] = count,
            "mastered" => counts[3] = count,
            "needsWork" => counts[4] = count,
            _ => counts[0] = count,
        }
    }
    counts[5] = connection.query_row("SELECT COUNT(*) FROM card_progress p INNER JOIN flashcards c ON c.id=p.card_id INNER JOIN flashcard_sets s ON s.id=c.set_id WHERE s.class_id=?1 AND s.is_study_web_private=0 AND s.deleted_at IS NULL AND datetime(p.due_at) <= CURRENT_TIMESTAMP", [&class_id], |row| row.get(0)).unwrap_or(0);
    let mut card_statement = connection.prepare("SELECT c.id, c.set_id, c.front, COALESCE(p.mastery,'new'), COALESCE(p.correct_count,0), COALESCE(p.incorrect_count,0), p.due_at FROM flashcards c INNER JOIN flashcard_sets s ON s.id=c.set_id LEFT JOIN card_progress p ON p.card_id=c.id WHERE s.class_id=?1 AND s.is_study_web_private=0 AND s.deleted_at IS NULL ORDER BY CASE COALESCE(p.mastery,'new') WHEN 'needsWork' THEN 0 WHEN 'learning' THEN 1 WHEN 'new' THEN 2 WHEN 'familiar' THEN 3 ELSE 4 END, (COALESCE(p.incorrect_count,0) - COALESCE(p.correct_count,0)) DESC, COALESCE(p.last_seen_at,'') ASC LIMIT 8").map_err(|error| error.to_string())?;
    let weak_cards = card_statement
        .query_map([&class_id], |row| {
            Ok(StudyInsightCard {
                card_id: row.get(0)?,
                set_id: row.get(1)?,
                term: row.get(2)?,
                mastery: row.get(3)?,
                correct_count: row.get(4)?,
                incorrect_count: row.get(5)?,
                due_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut strong_statement = connection.prepare("SELECT c.id, c.set_id, c.front, p.mastery, p.correct_count, p.incorrect_count, p.due_at FROM flashcards c INNER JOIN flashcard_sets s ON s.id=c.set_id INNER JOIN card_progress p ON p.card_id=c.id WHERE s.class_id=?1 AND s.is_study_web_private=0 AND s.deleted_at IS NULL AND p.mastery IN ('mastered', 'familiar') ORDER BY CASE p.mastery WHEN 'mastered' THEN 0 ELSE 1 END, p.consecutive_correct DESC LIMIT 3").map_err(|error| error.to_string())?;
    let strong_cards = strong_statement
        .query_map([&class_id], |row| {
            Ok(StudyInsightCard {
                card_id: row.get(0)?,
                set_id: row.get(1)?,
                term: row.get(2)?,
                mastery: row.get(3)?,
                correct_count: row.get(4)?,
                incorrect_count: row.get(5)?,
                due_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(StudyInsights {
        total_cards: counts[0] + counts[1] + counts[2] + counts[3] + counts[4],
        new_cards: counts[0],
        learning_cards: counts[1],
        familiar_cards: counts[2],
        mastered_cards: counts[3],
        needs_work_cards: counts[4],
        due_cards: counts[5],
        weak_cards,
        strong_cards,
    })
}

#[tauri::command]
pub fn save_test_attempt(
    database: State<'_, Database>,
    input: SaveTestAttemptInput,
) -> CommandResult<TestAttemptSummary> {
    let connection = database.open()?;
    let id = Uuid::new_v4().to_string();
    connection.execute("INSERT INTO test_attempts (id, set_id, score, correct_count, question_count, answers_json) VALUES (?1,?2,?3,?4,?5,?6)", params![id, input.set_id, input.score, input.correct_count, input.question_count, input.answers_json]).map_err(|error| error.to_string())?;
    connection.query_row("SELECT id, set_id, score, correct_count, question_count, created_at FROM test_attempts WHERE id=?1", [&id], |row| Ok(TestAttemptSummary { id: row.get(0)?, set_id: row.get(1)?, score: row.get(2)?, correct_count: row.get(3)?, question_count: row.get(4)?, created_at: row.get(5)? })).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_match_best_time(
    database: State<'_, Database>,
    set_id: String,
) -> CommandResult<Option<i32>> {
    database
        .open()?
        .query_row(
            "SELECT best_seconds FROM match_records WHERE set_id=?1",
            [&set_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_match_time(
    database: State<'_, Database>,
    set_id: String,
    seconds: i32,
) -> CommandResult<i32> {
    if seconds < 1 {
        return Err("A Match time must be at least one second.".into());
    }
    let connection = database.open()?;
    connection
        .execute(
            "INSERT INTO match_records (set_id, best_seconds, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP) ON CONFLICT(set_id) DO UPDATE SET best_seconds=MIN(match_records.best_seconds, excluded.best_seconds), updated_at=CASE WHEN excluded.best_seconds < match_records.best_seconds THEN CURRENT_TIMESTAMP ELSE match_records.updated_at END",
            params![&set_id, seconds],
        )
        .map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT best_seconds FROM match_records WHERE set_id=?1",
            [&set_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_settings_command(database: State<'_, Database>) -> CommandResult<AppSettings> {
    let connection = database.open()?;
    let installer_model_path = database.installer_model_path();
    let settings = get_settings(&connection, installer_model_path.as_deref())?;
    if installer_model_path.is_some() {
        database.clear_installer_model_path()?;
    }
    Ok(settings)
}

#[tauri::command]
pub fn update_settings(
    database: State<'_, Database>,
    mut input: UpdateSettingsInput,
) -> CommandResult<AppSettings> {
    if !input.settings.ai_enabled {
        input.settings.ai_grammar = false;
    }
    let connection = database.open()?;
    let serialized = serde_json::to_string(&input.settings).map_err(|error| error.to_string())?;
    connection.execute("INSERT INTO app_settings (key, value, updated_at) VALUES ('settings', ?1, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP", [&serialized]).map_err(|error| error.to_string())?;
    Ok(input.settings)
}

#[tauri::command]
pub fn empty_trash(database: State<'_, Database>) -> CommandResult<()> {
    let connection = database.open()?;
    connection
        .execute("DELETE FROM documents WHERE deleted_at IS NOT NULL", [])
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM flashcard_sets WHERE deleted_at IS NOT NULL",
            [],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM study_webs WHERE deleted_at IS NOT NULL", [])
        .map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM flashcard_sets WHERE is_study_web_private=1 AND id NOT IN (SELECT flashcard_set_id FROM study_web_sources)", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn search_library(
    database: State<'_, Database>,
    query: String,
) -> CommandResult<Vec<SearchResult>> {
    let connection = database.open()?;
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", needle);
    let mut results = Vec::new();
    let mut statements = vec![
        ("SELECT id, NULL, name, COALESCE(course_code, '') FROM classes WHERE archived_at IS NULL AND (name LIKE ?1 OR course_code LIKE ?1) LIMIT 8", "class"),
        ("SELECT id, class_id, title, substr(content_plain, 1, 100) FROM documents WHERE deleted_at IS NULL AND (title LIKE ?1 OR content_plain LIKE ?1) LIMIT 12", "document"),
        ("SELECT id, class_id, title, substr(content_plain, 1, 100) FROM lectures WHERE title LIKE ?1 OR content_plain LIKE ?1 LIMIT 12", "lecture"),
        ("SELECT id, class_id, title, COALESCE(description, '') FROM flashcard_sets WHERE is_study_web_private=0 AND deleted_at IS NULL AND (title LIKE ?1 OR description LIKE ?1) LIMIT 8", "set"),
        ("SELECT f.id, s.class_id, f.front, f.back FROM flashcards f INNER JOIN flashcard_sets s ON s.id=f.set_id WHERE s.is_study_web_private=0 AND s.deleted_at IS NULL AND (f.front LIKE ?1 OR f.back LIKE ?1) LIMIT 12", "card"),
    ];
    for (sql, kind) in statements.drain(..) {
        let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([&pattern], |row| {
                Ok(SearchResult {
                    kind: kind.into(),
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    title: row.get(2)?,
                    subtitle: row.get(3)?,
                })
            })
            .map_err(|error| error.to_string())?;
        results.extend(
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?,
        );
    }
    Ok(results)
}

#[tauri::command]
pub fn backup_library(database: State<'_, Database>, destination: String) -> CommandResult<()> {
    database.backup_to(Path::new(&destination))
}

#[tauri::command]
pub fn restore_library(database: State<'_, Database>, source: String) -> CommandResult<()> {
    let source = Path::new(&source);
    if !source.is_file() {
        return Err("The selected backup file could not be found.".into());
    }
    database.restore_from(source)
}

#[tauri::command]
pub fn default_soflo_export_path() -> CommandResult<String> {
    let base = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|error| error.to_string())?);
    let downloads = base.join("Downloads");
    Ok(downloads
        .join(format!(
            "SoFlo Library {}.soflo",
            chrono::Local::now().format("%Y-%m-%d")
        ))
        .display()
        .to_string())
}

#[tauri::command]
pub fn export_soflo_data(database: State<'_, Database>, destination: String) -> CommandResult<()> {
    database.export_archive(Path::new(&destination))
}

#[tauri::command]
pub fn import_soflo_data_and_restart(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    source: String,
) -> CommandResult<()> {
    database.import_archive(Path::new(&source))?;
    app.restart()
}

#[tauri::command]
pub fn wipe_soflo_data_and_restart(
    app: tauri::AppHandle,
    database: State<'_, Database>,
) -> CommandResult<()> {
    database.wipe_library()?;
    app.restart()
}

#[tauri::command]
pub fn get_security_status(database: State<'_, Database>) -> CommandResult<SecurityStatus> {
    database.security_status()
}

#[tauri::command]
pub fn unlock_library(
    database: State<'_, Database>,
    input: UnlockLibraryInput,
) -> CommandResult<SecurityStatus> {
    database.unlock(input)
}

#[tauri::command]
pub fn update_library_security(
    database: State<'_, Database>,
    input: UpdateLibrarySecurityInput,
) -> CommandResult<SecurityStatus> {
    database.update_security(input)
}

#[tauri::command]
pub fn sync_encrypted_library(database: State<'_, Database>) -> CommandResult<()> {
    database.sync_encrypted()
}

#[cfg(test)]
mod tests {
    use super::{
        available_loopback_port, fallback_study_web_plan, flashcard_system_instruction,
        flashcard_cards_from_response, is_visual_line_echo, looks_like_math_material,
        course_calendar_plan_uses_source_dates, explicit_course_dates, has_fragmented_pdf_spacing, powerpoint_slide_text, repairs_fragmented_pdf_spacing,
        json_array_from_response, json_object_from_response, semester_end_date,
        lecture_markdown_to_editor_content, normalize_lecture_notes_part, quick_mechanics_prepass,
        should_retry_flashcard_batch_on_cpu,
        usable_lecture_notes,
        study_web_hierarchy_layout_edges,
        study_web_plan_has_hierarchy, thesaurus_json_from_response, StudyWebSemanticGroup,
        StudyWebSemanticPlan, StudyWebSourceCard, CourseCalendarAiItem, CourseCalendarAiPlan, CourseCalendarSource,
    };

    #[test]
    fn reserves_a_fresh_loopback_port_for_each_model_server() {
        let port = available_loopback_port().expect("a private loopback port");
        assert!(port > 0);
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    }

    #[test]
    fn detects_widespread_pdf_word_fragmentation_without_flagging_normal_prose() {
        let fragmented = "Ma th em at ics in ter val no ta tion re qui res care ful read ing of each ex am ple be fore prac tic ing";
        assert!(has_fragmented_pdf_spacing(fragmented));
        assert!(!has_fragmented_pdf_spacing("This ordinary paragraph uses short words in a normal way, but it still has complete words and readable sentences throughout the document."));
    }

    #[test]
    fn accepts_only_a_meaningful_fragmented_pdf_repair() {
        let fragmented = "Ma th em at ics in ter val no ta tion re qui res care ful read ing of each ex am ple be fore prac tic ing";
        assert!(repairs_fragmented_pdf_spacing(fragmented, "Mathematics interval notation requires careful reading of each example before practicing."));
        assert!(!repairs_fragmented_pdf_spacing(fragmented, fragmented));
    }

    #[test]
    fn reads_explicit_course_dates_without_inventing_dates() {
        let dates = explicit_course_dates("Exam 1: Due 09/20/2026. Final: 2026-12-09. Chapter 1 has no date.");
        assert_eq!(dates, vec![("2026-09-20".into(), "09/20/2026".into()), ("2026-12-09".into(), "2026-12-09".into())]);
    }

    #[test]
    fn rejects_calendar_dates_the_source_does_not_contain() {
        let sources = vec![CourseCalendarSource { id: "source".into(), class_id: "class".into(), title: "Syllabus".into(), content_plain: "Exam 1: 09/20/2026".into(), source_path: None, created_at: String::new() }];
        let valid = CourseCalendarAiPlan { items: vec![CourseCalendarAiItem { source_title: "Syllabus".into(), title: "Exam 1".into(), due_date: "2026-09-20".into(), description: String::new(), urgency: String::new(), source_excerpt: String::new() }], game_plan: vec![] };
        let fabricated = CourseCalendarAiPlan { items: vec![CourseCalendarAiItem { source_title: "Syllabus".into(), title: "Exam 1".into(), due_date: "2026-08-21".into(), description: String::new(), urgency: String::new(), source_excerpt: String::new() }], game_plan: vec![] };
        assert!(course_calendar_plan_uses_source_dates(&valid, &sources));
        assert!(!course_calendar_plan_uses_source_dates(&fabricated, &sources));
    }


    #[test]
    fn reads_powerpoint_slide_text_without_splitting_a_single_paragraph_run() {
        let slide = r#"<p:sld><a:p><a:r><a:t>Exam</a:t></a:r><a:r><a:t> Review</a:t></a:r></a:p><a:p><a:r><a:t>Bring notes &amp; calculator</a:t></a:r></a:p></p:sld>"#;
        assert_eq!(powerpoint_slide_text(slide), "Exam Review\nBring notes & calculator");
    }

    #[test]
    fn quick_mechanics_prepass_catches_general_obvious_errors() {
        let issues = quick_mechanics_prepass("i dont need alot, but many writers was definately more easier to read when it seperated.");
        let corrections = issues
            .iter()
            .filter_map(|issue| issue.get("replacement").and_then(|value| value.as_str()))
            .collect::<Vec<_>>();
        assert!(corrections.contains(&"I"));
        assert!(corrections.contains(&"don't"));
        assert!(corrections.contains(&"a lot"));
        assert!(corrections.contains(&"definitely"));
        assert!(corrections.contains(&"separated"));
        assert!(issues.iter().any(|issue| issue["original"] == "writers was" && issue["replacement"] == "writers were"));
        assert!(issues.iter().any(|issue| issue["original"] == "more easier" && issue["replacement"] == "easier"));
    }

    #[test]
    fn detects_a_raw_visual_line_echo_without_rejecting_markdown_structure() {
        let source = "Course packet\nThis paragraph was split\nacross visual lines\nin the PDF\nSchedule\nMonday reading\nWednesday discussion\nFriday quiz\nGrading\nParticipation 20 percent\nProjects 40 percent\nFinal 40 percent";
        assert!(is_visual_line_echo(source, source));
        assert!(!is_visual_line_echo(source, "# Course packet\n\nThis paragraph was split across visual lines in the PDF.\n\n## Schedule\n- Monday reading\n- Wednesday discussion\n- Friday quiz\n\n## Grading\n| Item | Weight |\n| --- | --- |\n| Participation | 20 percent |\n| Projects | 40 percent |\n| Final | 40 percent |"));
    }

    #[test]
    fn extracts_only_the_valid_flashcard_json_array_from_a_model_response() {
        let response = "Here are the cards:\n```json\n[{\"front\":\"Term\",\"back\":\"Definition with [brackets]\"}]\n```";
        assert_eq!(
            json_array_from_response(response).as_deref(),
            Some("[{\"front\":\"Term\",\"back\":\"Definition with [brackets]\"}]")
        );
    }

    #[test]
    fn keeps_only_complete_cards_from_a_small_flashcard_batch() {
        let response = "[{\"front\":\"2 + 2\",\"back\":\"4\"},{\"front\":\"\",\"back\":\"skip\"},{\"front\":\"term\",\"back\":\"meaning\"}]";
        let cards = flashcard_cards_from_response(response);
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0]["front"], "2 + 2");
        assert_eq!(cards[1]["back"], "meaning");
    }

    #[test]
    fn only_retries_flashcard_batches_on_cpu_for_runtime_failures() {
        assert!(should_retry_flashcard_batch_on_cpu(
            "SoFlo's local AI model did not respond: connection reset"
        ));
        assert!(should_retry_flashcard_batch_on_cpu(
            "local model returned HTTP 500: backend error"
        ));
        assert!(!should_retry_flashcard_batch_on_cpu(
            "local model returned HTTP 400: invalid request"
        ));
        assert!(!should_retry_flashcard_batch_on_cpu(
            "the local model returned incomplete flashcard JSON"
        ));
    }

    #[test]
    fn identifies_math_material_and_uses_problem_first_instructions() {
        assert!(looks_like_math_material("Solve 3x² - 12 = 0 and show the work."));
        assert!(looks_like_math_material("f(x) = 2x + 7; evaluate f(4)."));
        assert!(!looks_like_math_material("Explain the historical causes of the Boston Tea Party."));
        let instruction = flashcard_system_instruction(true);
        assert!(instruction.contains("problem-first cards"));
        assert!(instruction.contains("do not invent work"));
    }

    #[test]
    fn extracts_a_complete_word_reference_object_from_a_model_response() {
        let response =
            "```json\n{\"word\":\"test\",\"senses\":[{\"definition\":\"A trial\"}]}\n```";
        assert_eq!(
            json_object_from_response(response).as_deref(),
            Some("{\"word\":\"test\",\"senses\":[{\"definition\":\"A trial\"}]}")
        );
    }

    #[test]
    fn joins_ai_lecture_parts_without_repeated_document_titles() {
        let part = "# CSCI 130 — August 14\n\n## String indexing\n- Strings use zero-based positions\n\n---\n\n# Repeated title\n\n### Example\n- s[0] returns the first character";
        let normalized = normalize_lecture_notes_part(part);
        assert!(!normalized.contains("# CSCI"));
        assert!(!normalized.contains("# Repeated"));
        assert!(!normalized.contains("---"));
        assert!(normalized.contains("## String indexing"));
        assert!(normalized.contains("### Example"));

        let content = lecture_markdown_to_editor_content("# A title\n\n## A real section\n\n**Worked example**\n\n```python\nprint(\"hello\")\n```");
        assert!(!content.contains("\"level\":1"));
        assert!(content.contains("\"level\":2"));
        assert!(content.contains("\"type\":\"codeBlock\""));
        assert!(content.contains("print"));
    }

    #[test]
    fn rejects_a_transcript_echo_as_lecture_notes() {
        let transcript = "00:00–00:20 · Professor · Today we will review strings.\n00:20–00:40 · Professor · Strings are immutable.\n00:40–01:00 · Professor · Use indexes to access characters.\n01:00–01:20 · Professor · Slicing creates substrings.";
        assert!(usable_lecture_notes(transcript, transcript).is_none());
        assert!(usable_lecture_notes("## Strings\n- Strings are immutable.\n- Indexes access characters.", transcript).is_some());
        let timestamped_notes = "## Strings\n\n#### [00:00–00:20 · Professor]\nStrings are immutable.\n\n#### [00:20–00:40 · Professor]\nIndexes access characters.\n\n#### [00:40–01:00 · Professor]\nSlicing returns a substring.";
        assert!(usable_lecture_notes(timestamped_notes, "A brief transcript excerpt.").is_none());
    }

    #[test]
    fn uses_the_requested_spring_and_fall_archive_dates() {
        assert_eq!(
            semester_end_date("Spring", 2027).unwrap().to_string(),
            "2027-05-12"
        );
        assert_eq!(
            semester_end_date("Fall", 2026).unwrap().to_string(),
            "2026-12-12"
        );
        assert!(semester_end_date("Summer", 2027).is_none());
    }

    #[test]
    fn study_web_fallback_never_invents_relationships() {
        let cards = vec![
            StudyWebSourceCard {
                id: "one".into(),
                front: "First topic".into(),
                back: "A definition.".into(),
                updated_at: "now".into(),
            },
            StudyWebSourceCard {
                id: "two".into(),
                front: "Second topic".into(),
                back: "Another definition.".into(),
                updated_at: "now".into(),
            },
        ];
        let plan = fallback_study_web_plan(&cards);
        assert!(plan.relationships.is_empty());
        assert_eq!(
            plan.groups
                .iter()
                .flat_map(|group| group.members.iter())
                .count(),
            2
        );
    }

    #[test]
    fn hierarchy_layout_edges_connect_every_grouped_card() {
        let groups = vec![
            ("root-a".into(), "First theme".into(), None, vec![]),
            (
                "leaf-a".into(),
                "First subgroup".into(),
                Some("root-a".into()),
                vec!["a".into(), "b".into()],
            ),
            ("root-b".into(), "Second theme".into(), None, vec![]),
            (
                "leaf-b".into(),
                "Second subgroup".into(),
                Some("root-b".into()),
                vec!["c".into(), "d".into()],
            ),
        ];
        let edges = study_web_hierarchy_layout_edges(&groups);
        let connected = edges
            .iter()
            .flat_map(|(source, target, _, _)| [source.as_str(), target.as_str()])
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(connected, ["a", "b", "c", "d"].into_iter().collect());
        assert_eq!(edges.len(), 3);
    }

    #[test]
    fn study_web_hierarchy_requires_parent_and_leaf_layers() {
        let cards = vec![
            StudyWebSourceCard {
                id: "one".into(),
                front: "One".into(),
                back: "Definition.".into(),
                updated_at: "now".into(),
            },
            StudyWebSourceCard {
                id: "two".into(),
                front: "Two".into(),
                back: "Definition.".into(),
                updated_at: "now".into(),
            },
            StudyWebSourceCard {
                id: "three".into(),
                front: "Three".into(),
                back: "Definition.".into(),
                updated_at: "now".into(),
            },
            StudyWebSourceCard {
                id: "four".into(),
                front: "Four".into(),
                back: "Definition.".into(),
                updated_at: "now".into(),
            },
        ];
        let flat = StudyWebSemanticPlan {
            groups: cards
                .iter()
                .enumerate()
                .map(|(index, card)| StudyWebSemanticGroup {
                    id: format!("g-{index}"),
                    label: card.front.clone(),
                    members: vec![card.id.clone()],
                    parent_id: None,
                })
                .collect(),
            relationships: Vec::new(),
        };
        assert!(!study_web_plan_has_hierarchy(&flat, &cards));

        let layered = StudyWebSemanticPlan {
            groups: vec![
                StudyWebSemanticGroup {
                    id: "parent".into(),
                    label: "Larger theme".into(),
                    members: Vec::new(),
                    parent_id: None,
                },
                StudyWebSemanticGroup {
                    id: "left".into(),
                    label: "First subgroup".into(),
                    members: vec!["one".into(), "two".into()],
                    parent_id: Some("parent".into()),
                },
                StudyWebSemanticGroup {
                    id: "right".into(),
                    label: "Second subgroup".into(),
                    members: vec!["three".into(), "four".into()],
                    parent_id: Some("parent".into()),
                },
            ],
            relationships: Vec::new(),
        };
        assert!(study_web_plan_has_hierarchy(&layered, &cards));
    }

    #[test]
    fn salvages_plain_grouped_thesaurus_output() {
        let raw = "CLOSE: essential, significant, vital\nRELATED: consequential, notable, meaningful\nBROAD: central, influential, weighty";
        let parsed: serde_json::Value = serde_json::from_str(
            &thesaurus_json_from_response(raw, "important").expect("grouped thesaurus JSON"),
        )
        .expect("valid JSON");
        assert_eq!(parsed["close"][0], "essential");
        assert_eq!(parsed["related"][1], "notable");
        assert_eq!(parsed["broad"][2], "weighty");

        let unlabeled = "1. essential\n2. significant\n3. consequential\n4. notable\n5. central\n6. influential";
        let parsed: serde_json::Value = serde_json::from_str(
            &thesaurus_json_from_response(unlabeled, "important")
                .expect("unlabeled thesaurus JSON"),
        )
        .expect("valid JSON");
        assert_eq!(parsed["close"].as_array().map(Vec::len), Some(2));
        assert_eq!(parsed["related"].as_array().map(Vec::len), Some(2));
        assert_eq!(parsed["broad"].as_array().map(Vec::len), Some(2));
    }
}
