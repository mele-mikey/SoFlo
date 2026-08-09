use std::{
    fs,
    io::Read,
    net::{SocketAddr, TcpStream},
    path::Path,
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

fn purge_expired_trash(connection: &Connection) -> CommandResult<()> {
    connection.execute("DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', '-30 days')", []).map_err(|error| error.to_string())?;
    connection.execute("DELETE FROM flashcard_sets WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', '-30 days')", []).map_err(|error| error.to_string())?;
    Ok(())
}

const AI_SERVER_PORT: u16 = 19393;
const AI_WARM_WINDOW: Duration = Duration::from_secs(30);
struct AiServer {
    child: Child,
    model_path: String,
    last_used: Instant,
}
static AI_SERVER: OnceLock<Mutex<Option<AiServer>>> = OnceLock::new();

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
pub fn import_pdf_text(path: String) -> CommandResult<String> {
    let bytes = fs::read(path).map_err(|_| "SoFlo could not read that PDF file.".to_string())?;
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|_| "SoFlo could not extract editable text from that PDF.".to_string())?;
    if text.trim().is_empty() {
        return Err("That PDF has no selectable text. Scanned PDFs need OCR before they can be imported as editable notes.".into());
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
) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        refine_document_text_blocking(app, model_path, text)
    })
    .await
    .map_err(|_| "SoFlo's local AI task stopped unexpectedly.".to_string())?
}

fn refine_document_text_blocking(
    app: tauri::AppHandle,
    model_path: String,
    text: String,
) -> CommandResult<String> {
    let model = Path::new(&model_path);
    if model.extension().and_then(|value| value.to_str()) != Some("gguf") || !model.exists() {
        return Err("Choose a local .gguf AI model in Settings first.".into());
    }
    let size = fs::metadata(model)
        .map_err(|_| "SoFlo could not read that AI model.".to_string())?
        .len();
    if size > 5_000_000_000 {
        return Err("Choose a compact local model (4B parameters or less).".into());
    }
    let source = text.chars().take(80_000).collect::<String>();
    let system = "You are SoFlo's careful local document formatter. Preserve every factual detail and never invent text. Return only clean Markdown—never wrap it in ```markdown fences. For an essay or paper: preserve the MLA heading block exactly as separate normal lines (student, instructor, course, date); then use # for the one actual title; preserve the original paragraph boundaries and body text. Never turn a name, date, or ordinary sentence into a heading. For a syllabus, accuracy and readable hierarchy are critical: include every policy, deadline, contact detail, grading rule, assignment, and schedule item from the source. Use # only for its actual title, ## or ### for real section headings, bullets for lists, and tables only when the source is truly tabular. Use **bold** only for essential labels, deadlines, percentages, and warnings. Never use more than ###. Do not add commentary or explanations.";
    emit_ai_progress(&app, 6, "Starting your private local model");
    ensure_ai_server(&model_path, &app)?;
    emit_ai_progress(&app, 42, "Reading and organizing the document");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    let response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", AI_SERVER_PORT))
        .json(&serde_json::json!({
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": format!("Format this extracted document:\n\n{}", source) }
            ],
            "max_tokens": 8192,
            "temperature": 0.1
        }))
        .send()
        .map_err(|error| format!("SoFlo's local AI model did not respond: {}", error))?
        .error_for_status()
        .map_err(|error| format!("SoFlo's local AI model could not finish this import: {}", error))?;
    emit_ai_progress(&app, 86, "Turning the result into your editable paper");
    let body: serde_json::Value = response
        .json()
        .map_err(|_| "SoFlo could not read the local AI response.".to_string())?;
    let formatted = body
        .get("choices")
        .and_then(|value| value.get(0))
        .and_then(|value| value.get("message"))
        .and_then(|value| value.get("content"))
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    touch_ai_server();
    if formatted.is_empty() {
        return Err("The local AI model returned no formatted text.".into());
    }
    emit_ai_progress(&app, 100, "Finishing up");
    Ok(formatted)
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

fn generate_flashcards_text_blocking(
    app: tauri::AppHandle,
    model_path: String,
    materials: String,
    guidance: String,
) -> CommandResult<String> {
    let model = Path::new(&model_path);
    if model.extension().and_then(|value| value.to_str()) != Some("gguf") || !model.exists() {
        return Err("Choose a local .gguf AI model in Settings first.".into());
    }
    emit_ai_progress(&app, 6, "Starting your private local model");
    ensure_ai_server(&model_path, &app)?;
    emit_ai_progress(&app, 42, "Reading your study materials");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "SoFlo could not connect to its local AI model.".to_string())?;
    let source = materials.chars().take(120_000).collect::<String>();
    let response = client.post(format!("http://127.0.0.1:{}/v1/chat/completions", AI_SERVER_PORT)).json(&serde_json::json!({
        "messages": [
          {"role":"system","content":"You create concise college flashcards. Return only valid JSON: an array of 12 to 40 objects, each with non-empty string keys front and back. The front must be a precise question or term under 16 words. The back must be a direct answer under 36 words; use short phrases or compact bullet-like clauses, never a paragraph. Focus on definitions, claims, events, formulas, and distinctions in the supplied materials. Do not use Markdown or commentary."},
          {"role":"user","content": format!("Create the most useful flashcards from these materials. Extra study guidance: {}\n\nMATERIALS:\n{}", guidance, source)}
        ], "max_tokens": 8192, "temperature": 0.2
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
    touch_ai_server();
    if output.is_empty() {
        return Err("The local AI model returned no flashcards.".into());
    }
    emit_ai_progress(&app, 100, "Finishing your flashcard set");
    Ok(output)
}

fn emit_ai_progress(app: &tauri::AppHandle, progress: u8, message: &str) {
    let _ = app.emit(
        "ai-generation-progress",
        serde_json::json!({ "progress": progress, "message": message }),
    );
}

fn ensure_ai_server(model_path: &str, app: &tauri::AppHandle) -> CommandResult<()> {
    let state = AI_SERVER.get_or_init(|| Mutex::new(None));
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
            && ai_server_ready()
        {
            server.last_used = Instant::now();
            emit_ai_progress(app, 32, "Your local model is ready");
            return Ok(());
        }
        let _ = server.child.kill();
        let _ = server.child.wait();
        *guard = None;
    }
    let port = AI_SERVER_PORT.to_string();
    let mut command = Command::new("llama-server");
    command.args([
        "-m",
        model_path,
        "--host",
        "127.0.0.1",
        "--port",
        &port,
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
        last_used: Instant::now(),
    });
    drop(guard);
    let address: SocketAddr = format!("127.0.0.1:{}", AI_SERVER_PORT)
        .parse()
        .map_err(|_| "SoFlo could not start the local AI connection.".to_string())?;
    for _ in 0..45 {
        if TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
            && ai_server_ready()
        {
            emit_ai_progress(app, 32, "Your local model is ready");
            return Ok(());
        }
        thread::sleep(Duration::from_millis(400));
    }
    Err("The local AI model took too long to start.".into())
}

fn ai_server_ready() -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(900))
        .build()
        .and_then(|client| {
            client
                .get(format!("http://127.0.0.1:{}/v1/models", AI_SERVER_PORT))
                .send()
        })
        .is_ok_and(|response| response.status().is_success())
}
fn touch_ai_server() {
    if let Some(state) = AI_SERVER.get() {
        if let Ok(mut guard) = state.lock() {
            if let Some(server) = guard.as_mut() {
                server.last_used = Instant::now();
            }
        }
    }
    thread::spawn(|| {
        thread::sleep(AI_WARM_WINDOW);
        if let Some(state) = AI_SERVER.get() {
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

#[tauri::command]
pub async fn download_default_ai_model(app: tauri::AppHandle) -> CommandResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        const MODEL_URL: &str = "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf?download=true";
        const MODEL_NAME: &str = "qwen2.5-3b-instruct-q4_k_m.gguf";
        let directory = app.path().app_data_dir().map_err(|error| error.to_string())?.join("models");
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let destination = directory.join(MODEL_NAME);
        if destination.exists() { return Ok(destination.to_string_lossy().to_string()); }
        let temporary = directory.join(format!("{}.download", MODEL_NAME));
        let mut response = reqwest::blocking::get(MODEL_URL).map_err(|_| "SoFlo could not start the local AI model download.".to_string())?.error_for_status().map_err(|_| "SoFlo could not download the local AI model.".to_string())?;
        let total = response.content_length().ok_or_else(|| "The AI model download did not report its size.".to_string())?;
        let mut output = fs::File::create(&temporary).map_err(|error| error.to_string())?;
        let mut downloaded = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = response.read(&mut buffer).map_err(|_| "The local AI model download was interrupted.".to_string())?;
            if count == 0 { break; }
            use std::io::Write;
            output.write_all(&buffer[..count]).map_err(|error| error.to_string())?;
            downloaded += count as u64;
            let _ = app.emit("ai-download-progress", ((downloaded.saturating_mul(100) / total).min(100)) as u8);
        }
        drop(output);
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        let _ = app.emit("ai-download-progress", 100u8);
        Ok(destination.to_string_lossy().to_string())
    }).await.map_err(|_| "SoFlo could not start the local AI download.".to_string())?
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

fn get_settings(connection: &Connection) -> CommandResult<AppSettings> {
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
    let semesters = list_semesters_from(&connection, false)?;
    let classes = list_classes_from(&connection, false)?;
    Ok(BootstrapData {
        semesters,
        classes,
        settings: get_settings(&connection)?,
        data_location: database.data_path().display().to_string(),
    })
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
pub fn save_document(
    database: State<'_, Database>,
    input: SaveDocumentInput,
) -> CommandResult<DocumentDetail> {
    let mut connection = database.open()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let (existing, revision): (String, i32) = transaction
        .query_row(
            "SELECT content, revision FROM documents WHERE id=?1",
            [&input.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let changed = existing != input.content;
    let next_revision = if changed { revision + 1 } else { revision };
    transaction.execute("UPDATE documents SET title=?1, content=?2, content_plain=?3, is_favorite=?4, revision=?5, updated_at=CURRENT_TIMESTAMP WHERE id=?6", params![input.title.trim(), input.content, input.content_plain, input.is_favorite as i32, next_revision, input.id]).map_err(|error| error.to_string())?;
    if changed && next_revision % 15 == 0 {
        transaction.execute("INSERT INTO document_revisions (id, document_id, title, content, revision) SELECT ?1, id, title, content, revision FROM documents WHERE id=?2", params![Uuid::new_v4().to_string(), input.id]).map_err(|error| error.to_string())?;
        transaction.execute("DELETE FROM document_revisions WHERE id IN (SELECT id FROM document_revisions WHERE document_id=?1 ORDER BY created_at DESC LIMIT -1 OFFSET 30)", [&input.id]).map_err(|error| error.to_string())?;
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
    Ok(FlashcardSetDetail {
        id,
        class_id,
        title,
        description,
        cards,
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
    let existing: Option<CardProgress> = connection.query_row("SELECT card_id, mastery, correct_count, incorrect_count, consecutive_correct, last_seen_at, due_at FROM card_progress WHERE card_id=?1", [&input.card_id], |row| Ok(CardProgress { card_id: row.get(0)?, mastery: row.get(1)?, correct_count: row.get(2)?, incorrect_count: row.get(3)?, consecutive_correct: row.get(4)?, last_seen_at: row.get(5)?, due_at: row.get(6)? })).ok();
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
    let mastery = if !input.is_correct {
        "learning"
    } else if streak >= 5 {
        "mastered"
    } else if streak >= 3 {
        "familiar"
    } else {
        "learning"
    };
    connection.execute("INSERT INTO card_progress (card_id, mastery, correct_count, incorrect_count, consecutive_correct, last_seen_at) VALUES (?1,?2,?3,?4,?5,CURRENT_TIMESTAMP) ON CONFLICT(card_id) DO UPDATE SET mastery=excluded.mastery, correct_count=excluded.correct_count, incorrect_count=excluded.incorrect_count, consecutive_correct=excluded.consecutive_correct, last_seen_at=excluded.last_seen_at", params![input.card_id, mastery, correct, incorrect, streak]).map_err(|error| error.to_string())?;
    Ok(CardProgress {
        card_id: progress.card_id,
        mastery: mastery.into(),
        correct_count: correct,
        incorrect_count: incorrect,
        consecutive_correct: streak,
        last_seen_at: Some(chrono::Utc::now().to_rfc3339()),
        due_at: None,
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
pub fn get_settings_command(database: State<'_, Database>) -> CommandResult<AppSettings> {
    get_settings(&database.open()?)
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
