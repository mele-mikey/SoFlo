use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Semester {
    pub id: String,
    pub name: String,
    pub term: String,
    pub year: i32,
    pub position: i32,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CourseClass {
    pub id: String,
    pub semester_id: String,
    pub name: String,
    pub course_code: String,
    pub professor: Option<String>,
    pub location: Option<String>,
    pub schedule: Option<String>,
    pub icon: String,
    pub accent_color: String,
    pub position: i32,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSummary {
    pub id: String,
    pub class_id: String,
    pub title: String,
    pub excerpt: String,
    pub is_favorite: bool,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub is_syllabus: bool,
    pub folder_id: Option<String>,
    pub linked_pdf_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDetail {
    pub id: String,
    pub class_id: String,
    pub title: String,
    pub content: String,
    pub content_plain: String,
    pub is_favorite: bool,
    pub revision: i32,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub is_syllabus: bool,
    pub folder_id: Option<String>,
    pub linked_pdf_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RevisionHistoryEntry {
    pub id: String,
    pub revision: i32,
    pub title: String,
    pub content: String,
    pub content_plain: String,
    pub created_at: String,
    pub name: Option<String>,
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFolder {
    pub id: String,
    pub class_id: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LectureSummary {
    pub id: String,
    pub class_id: String,
    pub course_code: String,
    pub course_name: String,
    pub lecture_date: String,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub professor_snapshot: Option<String>,
    pub title: String,
    pub excerpt: String,
    pub updated_at: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LectureDetail {
    pub id: String,
    pub class_id: String,
    pub course_code: String,
    pub course_name: String,
    pub lecture_date: String,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub professor_snapshot: Option<String>,
    pub title: String,
    pub content: String,
    pub content_plain: String,
    pub revision: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LectureRecording {
    pub lecture_id: String,
    pub state: String,
    pub source_kind: String,
    pub audio_path: Option<String>,
    pub raw_audio_path: Option<String>,
    pub duration_ms: i64,
    pub captured_ms: i64,
    pub transcribed_ms: i64,
    pub pending_chunks: i32,
    pub status_message: String,
    pub started_at: Option<String>,
    pub stopped_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LectureTranscriptSegment {
    pub id: String,
    pub lecture_id: String,
    pub chunk_index: i32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker: String,
    pub text: String,
    pub is_final: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LectureAnalysis {
    pub lecture_id: String,
    pub status: String,
    pub overview: String,
    pub key_points: Vec<String>,
    pub concepts: Vec<String>,
    pub questions: Vec<String>,
    pub next_steps: Vec<String>,
    pub raw_transcript: String,
    pub cleaned_transcript: String,
    pub detailed_notes: String,
    pub note_suggestions: Vec<LectureNoteSuggestion>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LectureNoteSuggestion {
    pub original: String,
    pub replacement: String,
    pub reason: String,
    pub timestamp: String,
    pub kind: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FlashcardSetSummary {
    pub id: String,
    pub class_id: String,
    pub title: String,
    pub description: Option<String>,
    pub card_count: i32,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Flashcard {
    pub id: String,
    pub set_id: String,
    pub front: String,
    pub back: String,
    pub notes: Option<String>,
    pub image_path: Option<String>,
    pub position: i32,
    pub is_starred: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CardProgress {
    pub card_id: String,
    pub mastery: String,
    pub correct_count: i32,
    pub incorrect_count: i32,
    pub consecutive_correct: i32,
    pub last_seen_at: Option<String>,
    pub due_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FlashcardSetDetail {
    pub id: String,
    pub class_id: String,
    pub title: String,
    pub description: Option<String>,
    pub cards: Vec<Flashcard>,
    #[serde(default)]
    pub progress: Vec<CardProgress>,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudyWebSummary {
    pub id: String,
    pub class_id: String,
    pub flashcard_set_id: String,
    pub flashcard_set_ids: Vec<String>,
    pub name: String,
    pub card_count: i32,
    pub group_count: i32,
    pub generated_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub out_of_date: bool,
    pub is_manual: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudyWebGroup {
    pub id: String,
    pub label: String,
    pub color: String,
    pub parent_group_id: Option<String>,
    pub card_ids: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudyWebNode {
    pub card_id: String,
    pub x: f64,
    pub y: f64,
    pub manually_positioned: bool,
    pub pinned: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudyWebRelationship {
    pub id: String,
    pub source_card_id: String,
    pub target_card_id: String,
    pub relationship_type: String,
    pub strength: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudyWebDetail {
    pub id: String,
    pub class_id: String,
    pub flashcard_set_id: String,
    pub flashcard_set_ids: Vec<String>,
    pub name: String,
    pub generated_at: String,
    pub updated_at: String,
    pub out_of_date: bool,
    pub is_manual: bool,
    pub nodes: Vec<StudyWebNode>,
    pub groups: Vec<StudyWebGroup>,
    pub relationships: Vec<StudyWebRelationship>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub user_name: String,
    pub spellcheck: bool,
    pub reduce_motion: bool,
    pub editor_font_size: i32,
    #[serde(default)]
    pub editor_defaults_version: u8,
    #[serde(default = "default_editor_canvas")]
    pub editor_canvas: String,
    #[serde(default = "default_theme_color")]
    pub theme_color: String,
    #[serde(default)]
    pub onboarding_completed: bool,
    #[serde(default)]
    pub walkthrough_completed: bool,
    #[serde(default)]
    pub walkthrough_skipped: bool,
    #[serde(default)]
    pub walkthrough_step: String,
    #[serde(default)]
    pub walkthrough_example_class_id: String,
    #[serde(default)]
    pub walkthrough_example_semester_id: String,
    #[serde(default)]
    pub hide_overview_banner: bool,
    #[serde(default = "default_ai_enabled")]
    pub ai_enabled: bool,
    #[serde(default = "default_ai_grammar")]
    pub ai_grammar: bool,
    #[serde(default = "default_ask_for_ai_use")]
    pub ask_for_ai_use: bool,
    #[serde(default)]
    pub ai_model_path: String,
    #[serde(default)]
    pub ai_writing_model_path: String,
    #[serde(default = "default_ai_model_tier")]
    pub ai_general_model_tier: String,
    #[serde(default = "default_ai_model_tier")]
    pub ai_writing_model_tier: String,
    #[serde(default)]
    pub ai_voice_model_path: String,
    #[serde(default = "default_ai_model_tier")]
    pub ai_voice_model_tier: String,
    #[serde(default)]
    pub lecture_microphone_id: String,
    #[serde(default)]
    pub study_web_auto_pin: bool,
    #[serde(default)]
    pub study_web_group_highlights: bool,
    pub default_question_types: Vec<String>,
}

fn default_editor_canvas() -> String {
    "paper".to_string()
}
fn default_theme_color() -> String {
    "purple".to_string()
}
fn default_ai_enabled() -> bool {
    true
}
fn default_ai_grammar() -> bool {
    true
}
fn default_ask_for_ai_use() -> bool {
    true
}
fn default_ai_model_tier() -> String {
    "medium".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            user_name: String::new(),
            spellcheck: true,
            reduce_motion: false,
            editor_font_size: 11,
            editor_defaults_version: 1,
            editor_canvas: default_editor_canvas(),
            theme_color: default_theme_color(),
            onboarding_completed: false,
            walkthrough_completed: false,
            walkthrough_skipped: false,
            walkthrough_step: String::new(),
            walkthrough_example_class_id: String::new(),
            walkthrough_example_semester_id: String::new(),
            hide_overview_banner: false,
            ai_enabled: true,
            ai_grammar: true,
            ask_for_ai_use: true,
            ai_model_path: String::new(),
            ai_writing_model_path: String::new(),
            ai_general_model_tier: default_ai_model_tier(),
            ai_writing_model_tier: default_ai_model_tier(),
            ai_voice_model_path: String::new(),
            ai_voice_model_tier: default_ai_model_tier(),
            lecture_microphone_id: String::new(),
            study_web_auto_pin: false,
            study_web_group_highlights: false,
            default_question_types: vec![
                "multipleChoice".into(),
                "written".into(),
                "trueFalse".into(),
            ],
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMetadata {
    pub salt: String,
    #[serde(default)]
    pub pin_digits: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SecurityMetadata {
    pub version: u8,
    pub pin: Option<CredentialMetadata>,
    pub password: Option<CredentialMetadata>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    pub configured: bool,
    pub locked: bool,
    pub has_pin: bool,
    pub has_password: bool,
    pub pin_digits: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapData {
    pub semesters: Vec<Semester>,
    pub classes: Vec<CourseClass>,
    pub settings: AppSettings,
    pub data_location: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSemesterInput {
    pub name: String,
    pub term: String,
    pub year: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSemesterInput {
    pub id: String,
    pub name: String,
    pub term: String,
    pub year: i32,
    pub archived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClassInput {
    pub semester_id: String,
    pub name: String,
    pub course_code: String,
    pub professor: Option<String>,
    pub location: Option<String>,
    pub schedule: Option<String>,
    pub icon: Option<String>,
    pub accent_color: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateClassInput {
    pub id: String,
    pub semester_id: String,
    pub name: String,
    pub course_code: String,
    pub professor: Option<String>,
    pub location: Option<String>,
    pub schedule: Option<String>,
    pub icon: String,
    pub accent_color: String,
    pub archived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDocumentInput {
    pub class_id: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentInput {
    pub id: String,
    pub title: String,
    pub content: String,
    pub content_plain: String,
    pub is_favorite: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLectureInput {
    pub class_id: String,
    pub course_code: String,
    pub course_name: String,
    pub lecture_date: String,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub professor_snapshot: Option<String>,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLectureInput {
    pub id: String,
    pub title: String,
    pub content: String,
    pub content_plain: String,
    #[serde(default)]
    pub force_checkpoint: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordLectureNoteCheckpointInput {
    pub lecture_id: String,
    pub content: String,
    pub content_plain: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameDocumentEntry {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameDocumentsInput {
    pub documents: Vec<RenameDocumentEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFlashcardSetInput {
    pub class_id: String,
    pub title: String,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFlashcardSetInput {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFlashcardInput {
    pub id: Option<String>,
    pub set_id: String,
    pub front: String,
    pub back: String,
    pub notes: Option<String>,
    pub image_path: Option<String>,
    pub position: i32,
    pub is_starred: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveStudyWebNodePositionInput {
    pub study_web_id: String,
    pub card_id: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub pinned: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleStudyWebRelationshipInput {
    pub study_web_id: String,
    pub source_card_id: String,
    pub target_card_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStudyWebGroupMembershipInput {
    pub study_web_id: String,
    pub group_id: String,
    pub card_id: String,
    pub included: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStudyWebGroupInput {
    pub study_web_id: String,
    pub card_id: String,
    pub label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStudyWebGroupColorInput {
    pub study_web_id: String,
    pub group_id: String,
    pub color: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsInput {
    pub settings: AppSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockLibraryInput {
    pub pin: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLibrarySecurityInput {
    pub current_pin: Option<String>,
    pub current_password: Option<String>,
    pub new_pin: Option<String>,
    pub new_password: Option<String>,
    pub remove_pin: bool,
    pub remove_password: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordCardResponseInput {
    pub card_id: String,
    pub is_correct: bool,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub question_type: Option<String>,
    #[serde(default)]
    pub answer: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartStudySessionInput {
    pub set_id: String,
    pub mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteStudySessionInput {
    pub id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudySessionSummary {
    pub id: String,
    pub set_id: Option<String>,
    pub class_id: Option<String>,
    pub mode: String,
    pub started_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudyInsightCard {
    pub card_id: String,
    pub set_id: String,
    pub term: String,
    pub mastery: String,
    pub correct_count: i32,
    pub incorrect_count: i32,
    pub due_at: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StudyInsights {
    pub total_cards: i32,
    pub new_cards: i32,
    pub learning_cards: i32,
    pub familiar_cards: i32,
    pub mastered_cards: i32,
    pub needs_work_cards: i32,
    pub due_cards: i32,
    pub weak_cards: Vec<StudyInsightCard>,
    pub strong_cards: Vec<StudyInsightCard>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTestAttemptInput {
    pub set_id: String,
    pub score: f64,
    pub correct_count: i32,
    pub question_count: i32,
    pub answers_json: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TestAttemptSummary {
    pub id: String,
    pub set_id: String,
    pub score: f64,
    pub correct_count: i32,
    pub question_count: i32,
    pub created_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub kind: String,
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub subtitle: String,
}
