use std::{
    fs,
    io::Read,
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use rusqlite::{params, Connection, OptionalExtension, Row};
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
        let size = font_size.abs().max(1.0);
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
        self.last_end = x + width * size;
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
    Ok(())
}

const AI_WARM_WINDOW: Duration = Duration::from_secs(30);
const AI_CONTEXT_SIZE: &str = "8192";
const WORD_AI_CONTEXT_SIZE: &str = "4096";
// Keep a few layers on the CPU so SoFlo remains responsive, while avoiding
// the very slow half-CPU/half-GPU split that made generation drag on.
const AI_GPU_LAYERS: &str = "32";
const AI_PARALLEL_REQUESTS: &str = "1";
const AI_SOURCE_CHUNK_CHARS: usize = 12_000;
const DEFAULT_AI_MODEL_NAME: &str = "Qwen3-4B-Q4_K_M.gguf";
const WORD_AI_MODEL_NAME: &str = "Qwen3-1.7B-Q4_K_M.gguf";
const WORD_AI_MINIMUM_BYTES: u64 = 1_000_000_000;
const LEGACY_DEFAULT_AI_MODEL_NAME: &str = "qwen2.5-3b-instruct-q4_k_m.gguf";
struct AiServer {
    child: Child,
    model_path: String,
    port: u16,
    last_used: Instant,
}
static AI_SERVER: OnceLock<Mutex<Option<AiServer>>> = OnceLock::new();
static WORD_AI_SERVER: OnceLock<Mutex<Option<AiServer>>> = OnceLock::new();

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
    if size > 5_000_000_000 {
        return Err("Choose a compact local model (4B parameters or less).".into());
    }
    Ok(model.to_string_lossy().to_string())
}

fn resolve_word_ai_model_path(app: &tauri::AppHandle) -> CommandResult<String> {
    let model = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("models")
        .join(WORD_AI_MODEL_NAME);
    if !is_complete_word_ai_model(&model) {
        return Err("SoFlo's fast word-reference model is not downloaded yet. Download the AI model package in Settings, then try again.".into());
    }
    Ok(model.to_string_lossy().to_string())
}

fn is_complete_word_ai_model(path: &Path) -> bool {
    path.is_file()
        && fs::metadata(path).is_ok_and(|metadata| metadata.len() >= WORD_AI_MINIMUM_BYTES)
}

#[tauri::command]
pub fn word_ai_model_ready(app: tauri::AppHandle) -> CommandResult<bool> {
    let model = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("models")
        .join(WORD_AI_MODEL_NAME);
    Ok(is_complete_word_ai_model(&model))
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
    window.destroy().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn is_installer_launch() -> bool {
    std::env::args().any(|argument| argument == "--installer")
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

#[tauri::command]
pub fn run_installer_worker() -> CommandResult<()> {
    let setup = setup_executable_argument()?;
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
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|_| "That file is not a supported .docx Word document.".to_string())?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|_| "That Word document does not contain readable text.".to_string())?;
    let mut xml = String::new();
    document
        .read_to_string(&mut xml)
        .map_err(|_| "SoFlo could not read the text in that Word document.".to_string())?;
    let text = word_xml_to_text(&xml);
    if text.trim().is_empty() {
        return Err("That Word document has no readable text to import.".into());
    }
    Ok(text)
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
    let source_text = text.chars().take(80_000).collect::<String>();
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
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        generate_flashcards_text_blocking(app, model_path, materials, guidance)
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
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        review_grammar_text_blocking(app, model_path, text, quick)
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

fn review_grammar_text_blocking(
    app: tauri::AppHandle,
    model_path: String,
    text: String,
    quick: bool,
) -> CommandResult<String> {
    // The editor sends a rotating excerpt for quiet checks so long papers are
    // covered over time instead of silently dropping the latter half.
    let source = text
        .chars()
        .take(if quick { 2_400 } else { 6_000 })
        .collect::<String>();
    if source.trim().len() < 3 {
        return Ok("[]".into());
    }
    let system_instruction = if quick {
        "You are SoFlo's fast English spelling checker. Return only one complete valid JSON array: no Markdown, code fences, or commentary. Return up to 3 clear spelling errors. Every object must have exactly these six keys: kind, original, replacement, reason, category, alternatives. kind must be mechanic and category must be spelling. Copy original exactly from the input and make replacement the smallest correction. alternatives must be an empty JSON array. Prioritize obvious misspellings and split-word errors. Report one error per object. Do not report grammar, style, punctuation, proper names, or text that is already correct. Return [] only when there are no clear spelling errors."
    } else {
        "You are SoFlo's rigorous academic writing reviewer. Return only one complete valid JSON array: no Markdown, no code fences, and no commentary outside the array. Return 3 to 8 useful suggestions whenever the input contains a complete rough-draft paragraph; do not return [] merely because spelling is acceptable. For an obviously rough draft, aim for 5 to 8 distinct suggestions. Every array object must use ONLY these five keys: kind, original, replacement, reason, alternatives. kind is either mechanic or style. original must be copied exactly from the input. replacement must be a clear optional improvement that preserves the writer's meaning. reason must say specifically why the replacement is more formal, precise, clear, or grammatically correct. alternatives is an array with zero to two short alternatives. First include clear mechanics for spelling, apostrophes, capitalization, hyphenation, duplicated spaces, and punctuation. Then actively find several distinct style improvements. Prioritize weak sentence starters and openers, conversational or vague phrases, weak verbs, transitions, short closing phrases, fragments, run-ons, unclear conclusions, and needless wordiness. For every style object, both original and replacement should normally be a focused 1 to 9 word phrase; use at most 18 words only when a short clause truly needs it, never an entire sentence. Never invent facts, alter citations, flag proper names merely for being unfamiliar, or make empty thesaurus substitutions."
    };
    emit_ai_progress(&app, 12, "Reading your writing");
    let server_port = if quick {
        let writing_model_path = resolve_word_ai_model_path(&app)?;
        ensure_word_ai_server(&writing_model_path, &app)?
    } else {
        let general_model_path = resolve_ai_model_path(&app, &model_path)?;
        ensure_ai_server(&general_model_path, &app)?
    };
    emit_ai_progress(&app, 45, "Checking spelling and grammar");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(if quick { 15 } else { 50 }))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    let review_sources = if quick {
        split_source_for_ai(&source, 750)
            .into_iter()
            .take(3)
            .collect::<Vec<_>>()
    } else {
        vec![source]
    };
    let mut suggestions = Vec::new();
    for (index, review_source) in review_sources.iter().enumerate() {
        let progress = 45 + ((index as u8).saturating_mul(38) / review_sources.len().max(1) as u8);
        emit_ai_progress(
            &app,
            progress,
            if quick {
                "Checking spelling and grammar"
            } else {
                "Reviewing another section"
            },
        );
        let request = if quick {
            format!(
                "Review this writing. Return JSON only.\n\n{}",
                review_source
            )
        } else {
            format!("Review this passage. Return 4 to 7 focused suggestions from this passage only. Return JSON only.\n\n{}", review_source)
        };
        let output = local_chat_text(
            &client,
            server_port,
            system_instruction,
            &request,
            if quick { 320 } else { 800 },
        )?;
        if let Some(array) = json_array_from_response(&output) {
            if let Ok(serde_json::Value::Array(items)) =
                serde_json::from_str::<serde_json::Value>(&array)
            {
                suggestions.extend(items.into_iter().take(if quick { 3 } else { 7 }));
            }
        }
    }
    if quick {
        touch_word_ai_server();
    } else {
        touch_ai_server();
    }
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
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        research_and_grade_text_blocking(app, model_path, text)
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
            "chat_template_kwargs": { "enable_thinking": false },
            "max_tokens": max_tokens,
            "temperature": 0.1
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
) -> CommandResult<String> {
    let source = text.chars().take(18_000).collect::<String>();
    if source.trim().chars().count() < 80 {
        return Err(
            "Write a little more before asking SoFlo to research and grade this paper.".into(),
        );
    }
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
        &format!("Create two research queries for this paper:\n\n{}", source.chars().take(7_000).collect::<String>()),
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
        "You are a constructive college writing instructor. Grade a student paper approximately, not officially. Use the supplied scholarly research leads only as leads: never claim a source proves something unless its metadata makes that clear. Return only a JSON object with keys grade, overview, strengths, improvements, evidence, reasoning, writingCraft, and researchAdvice. strengths, improvements, and researchAdvice must be arrays of 2 to 5 short strings. writingCraft must be an object with sentenceOpeners, topicSentences, organization, creativity, and length; each is a concise sentence. Clearly discuss the paper's claim, evidence, reasoning, counterarguments or missing perspectives, and practical ways to improve it. Do not write the paper for the student.",
        &format!("PAPER:\n{}\n\nSCHOLARLY RESEARCH LEADS (metadata only):\n{}", source, source_context),
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
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || define_word_blocking(app, model_path, word))
        .await
        .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

fn define_word_blocking(
    app: tauri::AppHandle,
    model_path: String,
    word: String,
) -> CommandResult<String> {
    let word = word.trim();
    if word.is_empty() || word.chars().count() > 80 {
        return Err("Select one ordinary word to look it up.".into());
    }
    let _ = model_path;
    let word_model_path = resolve_word_ai_model_path(&app)?;
    let word_ai_port = ensure_word_ai_server(&word_model_path, &app)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    let response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", word_ai_port))
        .json(&serde_json::json!({
            "messages": [
                {"role":"system","content":"You are a concise, reliable English dictionary for a college writing app. Return only one complete valid JSON object with keys word, pronunciation, senses, and synonyms. senses must be an array of one to three objects, each with string keys partOfSpeech, definition, and example. Give distinct common meanings, numbered by array order, with clear precise definitions and a short natural example where useful. synonyms must be an array of 5 to 10 single-word or hyphenated formal, academic, or more precise related alternatives; do not include the queried word itself, duplicate words, or phrases. Do not use Markdown, commentary, or code fences."},
                {"role":"user","content":format!("Define this one word: {}", word)}
            ],
            "chat_template_kwargs": { "enable_thinking": false },
            "max_tokens": 900,
            "temperature": 0.1
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
    touch_word_ai_server();
    json_object_from_response(output)
        .ok_or_else(|| "SoFlo could not prepare a word reference.".into())
}

#[tauri::command]
pub async fn ai_thesaurus(
    app: tauri::AppHandle,
    model_path: String,
    word: String,
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || ai_thesaurus_blocking(app, model_path, word))
        .await
        .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

fn ai_thesaurus_blocking(
    app: tauri::AppHandle,
    model_path: String,
    word: String,
) -> CommandResult<String> {
    let query = word.trim();
    if query.is_empty() || query.chars().count() > 120 {
        return Err("Enter a word or short phrase to explore.".into());
    }
    let _ = model_path;
    let word_model_path = resolve_word_ai_model_path(&app)?;
    let word_ai_port = ensure_word_ai_server(&word_model_path, &app)?;
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
                    {"role":"user","content":format!("Find grouped alternatives for: {}", query)}
                ],
                "chat_template_kwargs": { "enable_thinking": false },
                "max_tokens": max_tokens,
                "temperature": 0.1
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
    touch_word_ai_server();
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
) -> CommandResult<String> {
    let model_path = resolve_ai_model_path(&app, &model_path)?;
    emit_ai_progress(&app, 6, "Starting your private local model");
    let ai_port = ensure_ai_server(&model_path, &app)?;
    emit_ai_progress(&app, 42, "Reading your study materials");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    let source = materials.chars().take(120_000).collect::<String>();
    if source.trim().is_empty() {
        return Err(
            "Add a topic, pasted study text, or an uploaded document before creating flashcards."
                .into(),
        );
    }
    let source_kind = if materials.trim_start().starts_with("TOPIC OR PROMPT:") {
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
    let response = client.post(format!("http://127.0.0.1:{}/v1/chat/completions", ai_port)).json(&serde_json::json!({
        "messages": [
          {"role":"system","content":"You create concise college flashcards. Return only valid JSON: an array of 12 to 40 objects, each with non-empty string keys front and back. The front must be a precise question or term under 16 words. The back must be a direct answer under 36 words; use short phrases or compact bullet-like clauses, never a paragraph. Focus on definitions, claims, events, formulas, and distinctions in the supplied materials. When the material or request contains a finite enumerated set (for example, amendments, steps, terms, or rules), include every distinct member of that set up to 40 cards rather than stopping at a round number. If the user supplies only a topic or instruction, use accurate general academic knowledge and make the cards directly about that request. Do not use Markdown or commentary."},
          {"role":"user","content": format!("{} Create the most useful flashcards. Extra study guidance: {}\n\nINPUT:\n{}", request_instruction, guidance, source)}
        ], "chat_template_kwargs": { "enable_thinking": false }, "max_tokens": 6144, "temperature": 0.2
    })).send().map_err(|error| format!("SoFlo's local AI model did not respond: {}", error))?.error_for_status().map_err(|error| format!("SoFlo's local AI model could not create flashcards: {}", error))?;
    emit_ai_progress(&app, 86, "Checking the generated flashcards");
    let body: serde_json::Value = response
        .json()
        .map_err(|_| "SoFlo could not read the local AI response.".to_string())?;
    let output = body
        .get("choices")
        .and_then(|value| value.get(0))
        .and_then(|value| value.get("message"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    let output = json_array_from_response(&output).unwrap_or_default();
    touch_ai_server();
    if output.is_empty() {
        return Err("The local AI model returned no flashcards.".into());
    }
    emit_ai_progress(&app, 100, "Finishing your flashcard set");
    Ok(output)
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
    ensure_model_server(&AI_SERVER, model_path, app, AI_CONTEXT_SIZE, "on")
}

fn ensure_word_ai_server(model_path: &str, app: &tauri::AppHandle) -> CommandResult<u16> {
    ensure_model_server(
        &WORD_AI_SERVER,
        model_path,
        app,
        WORD_AI_CONTEXT_SIZE,
        "off",
    )
}

fn ensure_model_server(
    server_state: &'static OnceLock<Mutex<Option<AiServer>>>,
    model_path: &str,
    app: &tauri::AppHandle,
    context_size: &str,
    reasoning: &str,
) -> CommandResult<u16> {
    let state = server_state.get_or_init(|| Mutex::new(None));
    let mut guard = state
        .lock()
        .map_err(|_| "SoFlo's local AI state is unavailable.".to_string())?;
    if let Some(server) = guard.as_mut() {
        if server.model_path == model_path
            && server.last_used.elapsed() < AI_WARM_WINDOW
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
    let port_number = available_loopback_port()?;
    let port = port_number.to_string();
    let mut command = Command::new("llama-server");
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
        AI_GPU_LAYERS,
        "--reasoning",
        reasoning,
        "--reasoning-budget",
        "1024",
        "--no-webui",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command.spawn().map_err(|_| {
        "SoFlo could not start llama.cpp. Install llama.cpp to use local AI.".to_string()
    })?;
    *guard = Some(AiServer {
        child,
        model_path: model_path.to_string(),
        port: port_number,
        last_used: Instant::now(),
    });
    drop(guard);
    let address: SocketAddr = format!("127.0.0.1:{}", port_number)
        .parse()
        .map_err(|_| "SoFlo could not start the local AI connection.".to_string())?;
    // A cold 4B model can take well over 20 seconds to become ready on a
    // laptop even though the helper process itself started correctly. Keep
    // waiting for that owned child instead of treating a normal cold load as
    // a failed review.
    emit_ai_progress(app, 22, "Loading your private local model");
    let startup_started = Instant::now();
    let startup_deadline = startup_started + Duration::from_secs(75);
    while Instant::now() < startup_deadline {
        if let Some(state) = server_state.get() {
            let mut server = state
                .lock()
                .map_err(|_| "SoFlo's local AI state is unavailable.".to_string())?;
            if let Some(active) = server.as_mut() {
                if active
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    *server = None;
                    return Err("SoFlo's local AI helper stopped while loading.".into());
                }
            }
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
            && ai_server_ready(port_number)
        {
            emit_ai_progress(app, 32, "Your local model is ready");
            return Ok(port_number);
        }
        if startup_started.elapsed() >= Duration::from_secs(30) {
            emit_ai_progress(app, 28, "Still loading your private local model");
        }
        thread::sleep(Duration::from_millis(400));
    }
    stop_model_server(server_state);
    Err("The local AI model took too long to start.".into())
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
fn touch_ai_server() {
    touch_model_server(&AI_SERVER)
}

fn touch_word_ai_server() {
    touch_model_server(&WORD_AI_SERVER)
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
                if guard
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
    stop_model_server(&AI_SERVER);
    stop_model_server(&WORD_AI_SERVER);
    Ok(())
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
    let total = response
        .content_length()
        .ok_or_else(|| "The AI model download did not report its size.".to_string())?;
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
        let span = u64::from(progress_end.saturating_sub(progress_start));
        let progress = u64::from(progress_start) + downloaded.saturating_mul(span) / total;
        let _ = app.emit("ai-download-progress", progress.min(100) as u8);
    }
    drop(output);
    fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn download_default_ai_model(
    app: tauri::AppHandle,
    database: State<'_, Database>,
) -> CommandResult<String> {
    let configured_model_path = get_settings(&database.open()?, None)?.ai_model_path;
    let download_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        const MAIN_MODEL_URL: &str = "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true";
        const WORD_MODEL_URL: &str = "https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf?download=true";
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
        let word_destination = download_app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("models")
            .join(WORD_AI_MODEL_NAME);
        if use_existing_custom_model || destination.is_file() {
            download_ai_model_file(&download_app, WORD_MODEL_URL, &word_destination, 0, 100, Some(WORD_AI_MINIMUM_BYTES))?;
        } else {
            download_ai_model_file(&download_app, MAIN_MODEL_URL, &destination, 0, 68, None)?;
            download_ai_model_file(&download_app, WORD_MODEL_URL, &word_destination, 68, 100, Some(WORD_AI_MINIMUM_BYTES))?;
        }
        let _ = download_app.emit("ai-download-progress", 100u8);
        let _ = download_app.emit("ai-download-finished", ());
        Ok(destination.to_string_lossy().to_string())
    }).await.map_err(|_| "SoFlo could not start the local AI download.".to_string())?;
    if result.is_err() {
        let _ = app.emit("ai-download-finished", ());
    }
    result
}

fn word_xml_to_text(xml: &str) -> String {
    let with_breaks = xml
        .replace("</w:p>", "\n")
        .replace("</w:tr>", "\n")
        .replace("<w:tab/>", "\t")
        .replace("<w:br/>", "\n")
        .replace("<w:br />", "\n");
    let mut output = String::new();
    let mut inside_tag = false;
    for character in with_breaks.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => output.push(character),
            _ => {}
        }
    }
    output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
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
    let changed = database.open()?.execute(
        "UPDATE document_revisions SET name=?1 WHERE id=?2",
        params![if trimmed.is_empty() { None::<String> } else { Some(trimmed.to_string()) }, revision_id],
    ).map_err(|error| error.to_string())?;
    if changed == 0 { return Err("That saved version could not be found.".into()); }
    Ok(())
}

#[tauri::command]
pub fn restore_document_revision(
    database: State<'_, Database>,
    id: String,
    revision_id: String,
) -> CommandResult<DocumentDetail> {
    let mut connection = database.open()?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let (restore_title, restore_content, restore_plain): (String, String, String) = transaction.query_row(
        "SELECT title, content, content_plain FROM document_revisions WHERE id=?1 AND document_id=?2",
        params![revision_id, id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "That saved version could not be found.".to_string())?;
    let (current_title, current_content, current_plain, revision): (String, String, String, i32) = transaction.query_row(
        "SELECT title, content, content_plain, revision FROM documents WHERE id=?1",
        [&id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(|error| error.to_string())?;
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
    let changed = database.open()?.execute(
        "UPDATE lecture_revisions SET name=?1 WHERE id=?2",
        params![if trimmed.is_empty() { None::<String> } else { Some(trimmed.to_string()) }, revision_id],
    ).map_err(|error| error.to_string())?;
    if changed == 0 { return Err("That saved lecture version could not be found.".into()); }
    Ok(())
}

#[tauri::command]
pub fn restore_lecture_revision(
    database: State<'_, Database>,
    id: String,
    revision_id: String,
) -> CommandResult<LectureDetail> {
    let mut connection = database.open()?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    let (restore_title, restore_content, restore_plain): (String, String, String) = transaction.query_row(
        "SELECT title, content, content_plain FROM lecture_revisions WHERE id=?1 AND lecture_id=?2",
        params![revision_id, id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| "That saved lecture version could not be found.".to_string())?;
    let (current_title, current_content, current_plain, revision): (String, String, String, i32) = transaction.query_row(
        "SELECT title, content, content_plain, revision FROM lectures WHERE id=?1",
        [&id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(|error| error.to_string())?;
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
    let checkpoint = changed && latest_checkpoint_age.is_none_or(|seconds| seconds >= 180);
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
    let mut statement = connection.prepare("SELECT s.id, s.class_id, s.title, s.description, COUNT(c.id), s.updated_at, s.deleted_at FROM flashcard_sets s LEFT JOIN flashcards c ON c.set_id=s.id WHERE s.class_id=?1 AND (?2=1 OR s.deleted_at IS NULL) GROUP BY s.id ORDER BY s.updated_at DESC").map_err(|error| error.to_string())?;
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
    let mut statement = connection.prepare("SELECT c.id, c.set_id, c.front, c.back, c.notes, c.image_path, c.position, c.is_starred, c.created_at, c.updated_at FROM flashcards c INNER JOIN flashcard_sets s ON s.id=c.set_id WHERE s.class_id=?1 AND s.deleted_at IS NULL ORDER BY s.updated_at DESC, c.position ASC").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([class_id], read_card)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
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
    let mut statement = connection.prepare("SELECT COALESCE(p.mastery, 'new'), COUNT(*) FROM flashcards c INNER JOIN flashcard_sets s ON s.id=c.set_id LEFT JOIN card_progress p ON p.card_id=c.id WHERE s.class_id=?1 AND s.deleted_at IS NULL GROUP BY COALESCE(p.mastery, 'new')").map_err(|error| error.to_string())?;
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
    counts[5] = connection.query_row("SELECT COUNT(*) FROM card_progress p INNER JOIN flashcards c ON c.id=p.card_id INNER JOIN flashcard_sets s ON s.id=c.set_id WHERE s.class_id=?1 AND s.deleted_at IS NULL AND datetime(p.due_at) <= CURRENT_TIMESTAMP", [&class_id], |row| row.get(0)).unwrap_or(0);
    let mut card_statement = connection.prepare("SELECT c.id, c.set_id, c.front, COALESCE(p.mastery,'new'), COALESCE(p.correct_count,0), COALESCE(p.incorrect_count,0), p.due_at FROM flashcards c INNER JOIN flashcard_sets s ON s.id=c.set_id LEFT JOIN card_progress p ON p.card_id=c.id WHERE s.class_id=?1 AND s.deleted_at IS NULL ORDER BY CASE COALESCE(p.mastery,'new') WHEN 'needsWork' THEN 0 WHEN 'learning' THEN 1 WHEN 'new' THEN 2 WHEN 'familiar' THEN 3 ELSE 4 END, (COALESCE(p.incorrect_count,0) - COALESCE(p.correct_count,0)) DESC, COALESCE(p.last_seen_at,'') ASC LIMIT 8").map_err(|error| error.to_string())?;
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
    let mut strong_statement = connection.prepare("SELECT c.id, c.set_id, c.front, p.mastery, p.correct_count, p.incorrect_count, p.due_at FROM flashcards c INNER JOIN flashcard_sets s ON s.id=c.set_id INNER JOIN card_progress p ON p.card_id=c.id WHERE s.class_id=?1 AND s.deleted_at IS NULL AND p.mastery IN ('mastered', 'familiar') ORDER BY CASE p.mastery WHEN 'mastered' THEN 0 ELSE 1 END, p.consecutive_correct DESC LIMIT 3").map_err(|error| error.to_string())?;
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
    input: UpdateSettingsInput,
) -> CommandResult<AppSettings> {
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
        ("SELECT id, class_id, title, COALESCE(description, '') FROM flashcard_sets WHERE deleted_at IS NULL AND (title LIKE ?1 OR description LIKE ?1) LIMIT 8", "set"),
        ("SELECT f.id, s.class_id, f.front, f.back FROM flashcards f INNER JOIN flashcard_sets s ON s.id=f.set_id WHERE s.deleted_at IS NULL AND (f.front LIKE ?1 OR f.back LIKE ?1) LIMIT 12", "card"),
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
        available_loopback_port, is_visual_line_echo, json_array_from_response,
        json_object_from_response, semester_end_date, thesaurus_json_from_response,
    };

    #[test]
    fn reserves_a_fresh_loopback_port_for_each_model_server() {
        let port = available_loopback_port().expect("a private loopback port");
        assert!(port > 0);
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
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
    fn extracts_a_complete_word_reference_object_from_a_model_response() {
        let response =
            "```json\n{\"word\":\"test\",\"senses\":[{\"definition\":\"A trial\"}]}\n```";
        assert_eq!(
            json_object_from_response(response).as_deref(),
            Some("{\"word\":\"test\",\"senses\":[{\"definition\":\"A trial\"}]}")
        );
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
