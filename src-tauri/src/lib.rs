mod commands;
mod database;
mod models;

use std::path::PathBuf;

use database::Database;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let setup_mode = std::env::args().any(|argument| argument == "--installer" || argument == "--uninstaller");
            if !setup_mode {
                let data_directory: PathBuf = app
                    .path()
                    .app_data_dir()
                    .expect("could not determine app-data directory");
                let database = Database::new(data_directory.join("soflo.sqlite3"))
                    .expect("could not initialize SoFlo database");
                app.manage(database);
            }
            if std::env::args().any(|argument| argument == "--minimized") {
                if let Some(window) = app.get_webview_window("main") {
                    window.minimize()?;
                }
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_window_dragging,
            commands::minimize_window,
            commands::toggle_maximize_window,
            commands::close_window,
            commands::force_close_window,
            commands::is_installer_launch,
            commands::is_uninstaller_launch,
            commands::installer_version_info,
            commands::run_installer_worker,
            commands::launch_installed_soflo_and_close,
            commands::run_uninstaller_worker,
            commands::launch_uninstaller_and_close,
            commands::import_pdf_text,
            commands::import_syllabus_pdf_text,
            commands::import_word_text,
            commands::import_powerpoint_text,
            commands::import_google_doc,
            commands::export_document_docx,
            commands::check_for_app_update,
            commands::download_and_launch_app_update,
            commands::refine_document_text,
            commands::generate_flashcards_text,
            commands::generate_teach_it_back_question,
            commands::grade_teach_it_back_answer,
            commands::review_grammar_text,
            commands::research_and_grade_text,
            commands::define_word,
            commands::ai_thesaurus,
            commands::general_ai_model_ready,
            commands::word_ai_model_ready,
            commands::voice_ai_model_ready,
            commands::prepare_ai_for_session,
            commands::stop_ai_server,
            commands::download_default_ai_model,
            commands::install_ai_model,
            commands::get_ai_model_inventory,
            commands::delete_unused_ai_models,
            commands::delete_local_ai_models,
            commands::bootstrap,
            commands::list_semesters,
            commands::create_semester,
            commands::update_semester,
            commands::list_classes,
            commands::create_class,
            commands::update_class,
            commands::delete_class,
            commands::delete_semester,
            commands::list_documents,
            commands::list_document_revisions,
            commands::name_document_revision,
            commands::restore_document_revision,
            commands::list_recent_documents,
            commands::get_document,
            commands::get_syllabus,
            commands::create_document,
            commands::save_document,
            commands::list_lectures,
            commands::list_lecture_revisions,
            commands::name_lecture_revision,
            commands::restore_lecture_revision,
            commands::get_lecture,
            commands::create_lecture,
            commands::save_lecture,
            commands::record_lecture_note_checkpoint,
            commands::delete_lecture,
            commands::get_lecture_recording,
            commands::list_lecture_transcript_segments,
            commands::get_lecture_analysis,
            commands::retry_lecture_analysis,
            commands::start_lecture_recording,
            commands::append_lecture_audio_chunk,
            commands::import_lecture_audio,
            commands::queue_lecture_transcription,
            commands::finish_lecture_recording,
            commands::recover_interrupted_lecture_recordings,
            commands::set_document_syllabus,
            commands::set_document_deleted,
            commands::duplicate_document,
            commands::rename_documents,
            commands::set_document_pdf_link,
            commands::list_document_folders,
            commands::rename_document_folder,
            commands::group_documents,
            commands::remove_document_from_folder,
            commands::move_document,
            commands::get_course_calendar,
            commands::add_course_calendar_source,
            commands::remove_course_calendar_source,
            commands::set_course_calendar_item_completed,
            commands::save_course_calendar_manual_item,
            commands::archive_course_calendar_manual_item,
            commands::refresh_course_calendar,
            commands::ask_study_tutor,
            commands::generate_study_tutor_practice,
            commands::list_flashcard_sets,
            commands::create_flashcard_set,
            commands::create_flashcard_set_with_cards,
            commands::get_flashcard_set,
            commands::save_flashcard_set,
            commands::set_flashcard_set_study_kind,
            commands::set_flashcard_set_deleted,
            commands::export_flashcard_set_text,
            commands::read_text_file,
            commands::duplicate_flashcard_set,
            commands::save_flashcard,
            commands::delete_flashcard,
            commands::list_all_cards,
            commands::list_study_webs,
            commands::list_trashed_study_webs,
            commands::get_study_web,
            commands::set_study_web_deleted,
            commands::create_empty_study_web,
            commands::export_study_web_json,
            commands::import_study_web_json,
            commands::generate_study_web,
            commands::save_study_web_node_position,
            commands::toggle_study_web_relationship,
            commands::update_study_web_group_membership,
            commands::create_study_web_group,
            commands::update_study_web_group_color,
            commands::record_card_response,
            commands::start_study_session,
            commands::complete_study_session,
            commands::get_study_insights,
            commands::save_test_attempt,
            commands::get_match_best_time,
            commands::save_match_time,
            commands::get_settings_command,
            commands::update_settings,
            commands::empty_trash,
            commands::get_security_status,
            commands::unlock_library,
            commands::update_library_security,
            commands::sync_encrypted_library,
            commands::search_library,
            commands::backup_library,
            commands::restore_library,
            commands::default_soflo_export_path,
            commands::export_soflo_data,
            commands::import_soflo_data_and_restart,
            commands::wipe_soflo_data_and_restart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
