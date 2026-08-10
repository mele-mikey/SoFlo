use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    ptr::NonNull,
    sync::{Arc, Mutex},
};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{serialize::OwnedData, Connection, DatabaseName, OpenFlags};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::models::{
    CredentialMetadata, SecurityMetadata, SecurityStatus, UnlockLibraryInput,
    UpdateLibrarySecurityInput,
};

const KDF_MEMORY_KIB: u32 = 19 * 1024;
const KDF_ITERATIONS: u32 = 2;
const ENCRYPTED_HEADER: &[u8] = b"SOFLOENC1";
const NONCE_LENGTH: usize = 24;

#[derive(Debug, Serialize, Deserialize)]
struct SofloArchiveManifest {
    format: String,
    version: u8,
    encrypted: bool,
}

#[derive(Clone)]
pub struct Database {
    path: PathBuf,
    encrypted_path: PathBuf,
    security_path: PathBuf,
    memory_uri: String,
    security: Arc<Mutex<Option<SecurityMetadata>>>,
    session_key: Arc<Mutex<Option<Vec<u8>>>>,
    memory_anchor: Arc<Mutex<Option<Connection>>>,
}

impl Database {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let security_path = path.with_file_name("soflo.security.json");
        let encrypted_path = path.with_file_name("soflo.library.enc");
        let security = if security_path.exists() {
            let raw = fs::read_to_string(&security_path)
                .map_err(|_| "SoFlo could not read the security configuration.".to_string())?;
            Some(
                serde_json::from_str(&raw)
                    .map_err(|_| "SoFlo's security configuration is invalid.".to_string())?,
            )
        } else {
            None
        };
        if security.is_some() && !encrypted_path.exists() {
            return Err("SoFlo's encrypted library could not be found.".into());
        }
        let database = Self {
            path,
            encrypted_path,
            security_path,
            memory_uri: format!(
                "file:soflo-{}?mode=memory&cache=shared",
                uuid::Uuid::new_v4()
            ),
            security: Arc::new(Mutex::new(security)),
            session_key: Arc::new(Mutex::new(None)),
            memory_anchor: Arc::new(Mutex::new(None)),
        };
        if database
            .security
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .is_none()
        {
            let mut connection = database.open_disk()?;
            database.migrate(&mut connection)?;
        }
        Ok(database)
    }

    pub fn data_path(&self) -> PathBuf {
        self.security
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|_| self.encrypted_path.clone()))
            .unwrap_or_else(|| self.path.clone())
    }

    pub fn installer_model_path(&self) -> Option<String> {
        let marker = self.path.parent()?.join("installer.model-path");
        fs::read_to_string(marker).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
    }

    pub fn clear_installer_model_path(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            remove_file_if_present(&parent.join("installer.model-path"))?;
        }
        Ok(())
    }

    pub fn security_status(&self) -> Result<SecurityStatus, String> {
        let security = self
            .security
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?;
        let unlocked = self
            .session_key
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .is_some();
        Ok(SecurityStatus {
            configured: security.is_some(),
            locked: security.is_some() && !unlocked,
            has_pin: security
                .as_ref()
                .and_then(|config| config.pin.as_ref())
                .is_some(),
            has_password: security
                .as_ref()
                .and_then(|config| config.password.as_ref())
                .is_some(),
            pin_digits: security
                .as_ref()
                .and_then(|config| config.pin.as_ref())
                .and_then(|credential| credential.pin_digits)
                .filter(|digits| *digits == 4 || *digits == 6),
        })
    }

    pub fn unlock(&self, input: UnlockLibraryInput) -> Result<SecurityStatus, String> {
        let mut config = self
            .security
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .clone()
            .ok_or_else(|| "This library does not have security configured.".to_string())?;
        let key = derive_key(&config, input.pin.as_deref(), input.password.as_deref())?;
        let encrypted = fs::read(&self.encrypted_path)
            .map_err(|_| "SoFlo's encrypted library could not be read.".to_string())?;
        let bytes = decrypt_bytes(&encrypted, &key)
            .map_err(|_| "That PIN or password is not correct.".to_string())?;
        self.load_memory_database(bytes)
            .map_err(|_| "That PIN or password is not correct.".to_string())?;
        if let (Some(pin), Some(credential)) = (input.pin.as_deref(), config.pin.as_mut()) {
            if credential.pin_digits.is_none() && (pin.len() == 4 || pin.len() == 6) {
                credential.pin_digits = Some(pin.len() as u8);
                self.write_security_metadata(&config)?;
                *self
                    .security
                    .lock()
                    .map_err(|_| "SoFlo's security state is unavailable.".to_string())? =
                    Some(config.clone());
            }
        }
        *self
            .session_key
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())? = Some(key);
        self.security_status()
    }

    pub fn update_security(
        &self,
        input: UpdateLibrarySecurityInput,
    ) -> Result<SecurityStatus, String> {
        validate_secret_input(input.new_pin.as_deref(), input.new_password.as_deref())?;
        let current = self
            .security
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .clone();
        match current {
            None => {
                let config =
                    new_security_metadata(input.new_pin.as_deref(), input.new_password.as_deref())?;
                let key = derive_key(
                    &config,
                    input.new_pin.as_deref(),
                    input.new_password.as_deref(),
                )?;
                let bytes = self.read_plaintext_database()?;
                self.load_memory_database(bytes.clone())?;
                self.write_encrypted_bytes(&bytes, &key)?;
                remove_file_if_present(&self.path)?;
                remove_sidecars(&self.path)?;
                self.write_security_metadata(&config)?;
                *self
                    .security
                    .lock()
                    .map_err(|_| "SoFlo's security state is unavailable.".to_string())? =
                    Some(config);
                *self
                    .session_key
                    .lock()
                    .map_err(|_| "SoFlo's security state is unavailable.".to_string())? = Some(key);
            }
            Some(config) => {
                let old_key = derive_key(
                    &config,
                    input.current_pin.as_deref(),
                    input.current_password.as_deref(),
                )?;
                let active_key = self
                    .session_key
                    .lock()
                    .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
                    .clone()
                    .ok_or_else(|| "Unlock SoFlo before changing security settings.".to_string())?;
                if active_key != old_key {
                    return Err("Your current PIN or password is not correct.".into());
                }
                let final_pin = if input.remove_pin {
                    None
                } else {
                    input.new_pin.as_deref().or(input.current_pin.as_deref())
                };
                let final_password = if input.remove_password {
                    None
                } else {
                    input
                        .new_password
                        .as_deref()
                        .or(input.current_password.as_deref())
                };
                if final_pin.is_none() && final_password.is_none() {
                    let bytes = self.serialize_memory_database()?;
                    self.write_plaintext_bytes(&bytes)?;
                    remove_file_if_present(&self.encrypted_path)?;
                    if self.security_path.exists() {
                        fs::remove_file(&self.security_path).map_err(|error| error.to_string())?;
                    }
                    *self
                        .security
                        .lock()
                        .map_err(|_| "SoFlo's security state is unavailable.".to_string())? = None;
                    *self
                        .session_key
                        .lock()
                        .map_err(|_| "SoFlo's security state is unavailable.".to_string())? = None;
                    *self
                        .memory_anchor
                        .lock()
                        .map_err(|_| "SoFlo's security state is unavailable.".to_string())? = None;
                } else {
                    validate_secret_input(final_pin, final_password)?;
                    let next_config = new_security_metadata(final_pin, final_password)?;
                    let next_key = derive_key(&next_config, final_pin, final_password)?;
                    let bytes = self.serialize_memory_database()?;
                    self.write_encrypted_bytes(&bytes, &next_key)?;
                    self.write_security_metadata(&next_config)?;
                    *self
                        .security
                        .lock()
                        .map_err(|_| "SoFlo's security state is unavailable.".to_string())? =
                        Some(next_config);
                    *self
                        .session_key
                        .lock()
                        .map_err(|_| "SoFlo's security state is unavailable.".to_string())? =
                        Some(next_key);
                }
            }
        }
        self.security_status()
    }

    pub fn open(&self) -> Result<Connection, String> {
        if self
            .security
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .is_some()
        {
            if self
                .session_key
                .lock()
                .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
                .is_none()
            {
                return Err("SoFlo is locked. Enter your PIN or password to continue.".into());
            }
            self.open_memory()
        } else {
            self.open_disk()
        }
    }

    pub fn sync_encrypted(&self) -> Result<(), String> {
        let security = self
            .security
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .is_some();
        if !security {
            return Ok(());
        }
        let key = self
            .session_key
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .clone()
            .ok_or_else(|| {
                "SoFlo is locked. Enter your PIN or password to continue.".to_string()
            })?;
        let bytes = self.serialize_memory_database()?;
        self.write_encrypted_bytes(&bytes, &key)
    }

    pub fn backup_to(&self, destination: &Path) -> Result<(), String> {
        self.sync_encrypted()?;
        let source = self.data_path();
        if source == destination {
            return Err("Choose a different destination for the backup.".into());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&source, destination).map_err(|error| error.to_string())?;
        if self
            .security
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .is_some()
        {
            let metadata_destination = destination.with_extension("soflo-security.json");
            fs::copy(&self.security_path, metadata_destination)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn export_archive(&self, destination: &Path) -> Result<(), String> {
        self.sync_encrypted()?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let encrypted = self
            .security
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .is_some();
        let data = if encrypted {
            fs::read(self.data_path()).map_err(|_| "SoFlo could not read its local library.".to_string())?
        } else {
            // SQLite may have current writes in its WAL sidecar. Export a checkpointed
            // main database so one .soflo file always contains the complete library.
            self.read_plaintext_database()?
        };
        let file = fs::File::create(destination).map_err(|error| error.to_string())?;
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let manifest = SofloArchiveManifest { format: "soflo-library".into(), version: 1, encrypted };
        archive.start_file("manifest.json", options).map_err(|error| error.to_string())?;
        archive.write_all(&serde_json::to_vec(&manifest).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
        archive.start_file(if encrypted { "library.enc" } else { "library.sqlite3" }, options).map_err(|error| error.to_string())?;
        archive.write_all(&data).map_err(|error| error.to_string())?;
        if encrypted {
            archive.start_file("security.json", options).map_err(|error| error.to_string())?;
            archive.write_all(&fs::read(&self.security_path).map_err(|_| "SoFlo could not read its security configuration.".to_string())?).map_err(|error| error.to_string())?;
        }
        archive.finish().map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn import_archive(&self, source: &Path) -> Result<(), String> {
        let file = fs::File::open(source).map_err(|_| "The selected SoFlo data file could not be read.".to_string())?;
        let mut archive = ZipArchive::new(file).map_err(|_| "That file is not a valid SoFlo data export.".to_string())?;
        let manifest: SofloArchiveManifest = {
            let mut entry = archive.by_name("manifest.json").map_err(|_| "That file is missing SoFlo export details.".to_string())?;
            let mut raw = Vec::new();
            entry.read_to_end(&mut raw).map_err(|error| error.to_string())?;
            serde_json::from_slice(&raw).map_err(|_| "That file is not a valid SoFlo data export.".to_string())?
        };
        if manifest.format != "soflo-library" || manifest.version != 1 {
            return Err("That file is not a compatible SoFlo data export.".into());
        }
        let mut data = Vec::new();
        archive.by_name(if manifest.encrypted { "library.enc" } else { "library.sqlite3" }).map_err(|_| "That export is missing its library data.".to_string())?.read_to_end(&mut data).map_err(|error| error.to_string())?;
        if manifest.encrypted {
            if !data.starts_with(ENCRYPTED_HEADER) {
                return Err("That encrypted export is invalid.".into());
            }
            let mut security = Vec::new();
            archive.by_name("security.json").map_err(|_| "That encrypted export is missing its security details.".to_string())?.read_to_end(&mut security).map_err(|error| error.to_string())?;
            serde_json::from_slice::<SecurityMetadata>(&security).map_err(|_| "That encrypted export has invalid security details.".to_string())?;
            write_atomically(&self.encrypted_path, &data)?;
            write_atomically(&self.security_path, &security)?;
            remove_file_if_present(&self.path)?;
            remove_sidecars(&self.path)?;
        } else {
            let connection = connection_from_bytes(data.clone()).map_err(|_| "That export does not contain a valid SoFlo library.".to_string())?;
            validate_schema(&connection)?;
            self.write_plaintext_bytes(&data)?;
            remove_sidecars(&self.path)?;
            remove_file_if_present(&self.encrypted_path)?;
            remove_file_if_present(&self.security_path)?;
        }
        Ok(())
    }

    pub fn wipe_library(&self) -> Result<(), String> {
        remove_file_if_present(&self.path)?;
        remove_sidecars(&self.path)?;
        remove_file_if_present(&self.encrypted_path)?;
        remove_file_if_present(&self.security_path)?;
        *self.security.lock().map_err(|_| "SoFlo's security state is unavailable.".to_string())? = None;
        *self.session_key.lock().map_err(|_| "SoFlo's security state is unavailable.".to_string())? = None;
        *self.memory_anchor.lock().map_err(|_| "SoFlo's security state is unavailable.".to_string())? = None;
        Ok(())
    }

    pub fn restore_from(&self, source: &Path) -> Result<(), String> {
        self.validate_backup(source)?;
        if self
            .security
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .is_some()
        {
            let key = self
                .session_key
                .lock()
                .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
                .clone()
                .ok_or_else(|| {
                    "SoFlo is locked. Enter your PIN or password to continue.".to_string()
                })?;
            let raw = fs::read(source).map_err(|error| error.to_string())?;
            let bytes = decrypt_bytes(&raw, &key)?;
            self.load_memory_database(bytes)?;
            fs::copy(source, &self.encrypted_path).map_err(|error| error.to_string())?;
        } else {
            fs::copy(source, &self.path).map_err(|error| error.to_string())?;
            remove_sidecars(&self.path)?;
        }
        Ok(())
    }

    pub fn validate_backup(&self, source: &Path) -> Result<(), String> {
        if self
            .security
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .is_some()
        {
            let key = self
                .session_key
                .lock()
                .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
                .clone()
                .ok_or_else(|| {
                    "SoFlo is locked. Enter your PIN or password to continue.".to_string()
                })?;
            let raw = fs::read(source)
                .map_err(|_| "The selected backup file could not be read.".to_string())?;
            let bytes = decrypt_bytes(&raw, &key)
                .map_err(|_| "This backup belongs to a different PIN or password.".to_string())?;
            let connection = connection_from_bytes(bytes)?;
            validate_schema(&connection)
        } else {
            let connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| "This file is not a valid SoFlo backup.".to_string())?;
            validate_schema(&connection)
        }
    }

    fn open_disk(&self) -> Result<Connection, String> {
        let connection = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|error| error.to_string())?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;").map_err(|error| error.to_string())?;
        Ok(connection)
    }

    fn open_memory(&self) -> Result<Connection, String> {
        if self
            .memory_anchor
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?
            .is_none()
        {
            return Err("SoFlo is locked. Enter your PIN or password to continue.".into());
        }
        let connection = Connection::open_with_flags(
            &self.memory_uri,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|error| error.to_string())?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;").map_err(|error| error.to_string())?;
        Ok(connection)
    }

    fn read_plaintext_database(&self) -> Result<Vec<u8>, String> {
        let connection = self.open_disk()?;
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")
            .map_err(|error| error.to_string())?;
        drop(connection);
        fs::read(&self.path).map_err(|error| error.to_string())
    }

    fn load_memory_database(&self, bytes: Vec<u8>) -> Result<(), String> {
        let source = connection_from_bytes(bytes)?;
        let mut anchor = Connection::open_with_flags(
            &self.memory_uri,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_URI
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )
        .map_err(|error| error.to_string())?;
        {
            let backup = rusqlite::backup::Backup::new(&source, &mut anchor)
                .map_err(|error| error.to_string())?;
            backup
                .run_to_completion(128, std::time::Duration::ZERO, None)
                .map_err(|error| error.to_string())?;
        }
        anchor.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;").map_err(|error| error.to_string())?;
        self.migrate(&mut anchor)?;
        *self
            .memory_anchor
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())? = Some(anchor);
        Ok(())
    }

    fn serialize_memory_database(&self) -> Result<Vec<u8>, String> {
        let anchor = self
            .memory_anchor
            .lock()
            .map_err(|_| "SoFlo's security state is unavailable.".to_string())?;
        let connection = anchor.as_ref().ok_or_else(|| {
            "SoFlo is locked. Enter your PIN or password to continue.".to_string()
        })?;
        let data = connection
            .serialize(DatabaseName::Main)
            .map_err(|error| error.to_string())?;
        Ok(data.to_vec())
    }

    fn write_encrypted_bytes(&self, bytes: &[u8], key: &[u8]) -> Result<(), String> {
        let encrypted = encrypt_bytes(bytes, key)?;
        write_atomically(&self.encrypted_path, &encrypted)
    }

    fn write_plaintext_bytes(&self, bytes: &[u8]) -> Result<(), String> {
        write_atomically(&self.path, bytes)
    }

    fn write_security_metadata(&self, metadata: &SecurityMetadata) -> Result<(), String> {
        let raw = serde_json::to_vec(metadata).map_err(|error| error.to_string())?;
        write_atomically(&self.security_path, &raw)
    }

    pub fn migrate(&self, connection: &mut Connection) -> Result<(), String> {
        let version: i32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if version >= 9 {
            return Ok(());
        }
        if version < 1 {
            let transaction = connection
                .transaction()
                .map_err(|error| error.to_string())?;
            transaction.execute_batch(r#"
                CREATE TABLE IF NOT EXISTS semesters ( id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, term TEXT NOT NULL, year INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0, archived_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
                CREATE TABLE IF NOT EXISTS classes ( id TEXT PRIMARY KEY NOT NULL, semester_id TEXT NOT NULL REFERENCES semesters(id) ON DELETE RESTRICT, name TEXT NOT NULL, course_code TEXT NOT NULL DEFAULT '', professor TEXT, location TEXT, schedule TEXT, icon TEXT NOT NULL DEFAULT 'book-open', accent_color TEXT NOT NULL DEFAULT '#8B7CF6', position INTEGER NOT NULL DEFAULT 0, archived_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
                CREATE TABLE IF NOT EXISTS documents ( id TEXT PRIMARY KEY NOT NULL, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE RESTRICT, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}', content_plain TEXT NOT NULL DEFAULT '', is_favorite INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
                CREATE TABLE IF NOT EXISTS document_revisions ( id TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, title TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
                CREATE TABLE IF NOT EXISTS flashcard_sets ( id TEXT PRIMARY KEY NOT NULL, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE RESTRICT, title TEXT NOT NULL, description TEXT, deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
                CREATE TABLE IF NOT EXISTS flashcards ( id TEXT PRIMARY KEY NOT NULL, set_id TEXT NOT NULL REFERENCES flashcard_sets(id) ON DELETE CASCADE, front TEXT NOT NULL DEFAULT '', back TEXT NOT NULL DEFAULT '', notes TEXT, image_path TEXT, position INTEGER NOT NULL DEFAULT 0, is_starred INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
                CREATE TABLE IF NOT EXISTS card_progress ( card_id TEXT PRIMARY KEY NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE, mastery TEXT NOT NULL DEFAULT 'new', correct_count INTEGER NOT NULL DEFAULT 0, incorrect_count INTEGER NOT NULL DEFAULT 0, consecutive_correct INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, due_at TEXT );
                CREATE TABLE IF NOT EXISTS study_sessions ( id TEXT PRIMARY KEY NOT NULL, set_id TEXT REFERENCES flashcard_sets(id) ON DELETE SET NULL, class_id TEXT REFERENCES classes(id) ON DELETE SET NULL, mode TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, metadata TEXT NOT NULL DEFAULT '{}' );
                CREATE TABLE IF NOT EXISTS study_responses ( id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE, card_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE, question_type TEXT NOT NULL, is_correct INTEGER NOT NULL, answer TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
                CREATE TABLE IF NOT EXISTS test_attempts ( id TEXT PRIMARY KEY NOT NULL, set_id TEXT NOT NULL REFERENCES flashcard_sets(id) ON DELETE RESTRICT, score REAL NOT NULL, correct_count INTEGER NOT NULL, question_count INTEGER NOT NULL, answers_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
                CREATE TABLE IF NOT EXISTS app_settings ( key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
                CREATE INDEX IF NOT EXISTS idx_classes_semester ON classes(semester_id, position); CREATE INDEX IF NOT EXISTS idx_documents_class ON documents(class_id, updated_at DESC); CREATE INDEX IF NOT EXISTS idx_flashcard_sets_class ON flashcard_sets(class_id, updated_at DESC); CREATE INDEX IF NOT EXISTS idx_flashcards_set ON flashcards(set_id, position);
                CREATE VIRTUAL TABLE IF NOT EXISTS documents_search USING fts5(document_id UNINDEXED, title, content); CREATE VIRTUAL TABLE IF NOT EXISTS flashcards_search USING fts5(card_id UNINDEXED, front, back);
                CREATE TRIGGER IF NOT EXISTS documents_search_insert AFTER INSERT ON documents BEGIN INSERT INTO documents_search(rowid, document_id, title, content) VALUES (new.rowid, new.id, new.title, new.content_plain); END;
                CREATE TRIGGER IF NOT EXISTS documents_search_update AFTER UPDATE OF title, content_plain ON documents BEGIN UPDATE documents_search SET document_id = new.id, title = new.title, content = new.content_plain WHERE rowid = new.rowid; END;
                CREATE TRIGGER IF NOT EXISTS documents_search_delete AFTER DELETE ON documents BEGIN DELETE FROM documents_search WHERE rowid = old.rowid; END;
                CREATE TRIGGER IF NOT EXISTS flashcards_search_insert AFTER INSERT ON flashcards BEGIN INSERT INTO flashcards_search(rowid, card_id, front, back) VALUES (new.rowid, new.id, new.front, new.back); END;
                CREATE TRIGGER IF NOT EXISTS flashcards_search_update AFTER UPDATE OF front, back ON flashcards BEGIN UPDATE flashcards_search SET card_id = new.id, front = new.front, back = new.back WHERE rowid = new.rowid; END;
                CREATE TRIGGER IF NOT EXISTS flashcards_search_delete AFTER DELETE ON flashcards BEGIN DELETE FROM flashcards_search WHERE rowid = old.rowid; END;
                PRAGMA user_version = 1;
            "#).map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
        }
        if version < 2 {
            connection.execute_batch("ALTER TABLE documents ADD COLUMN is_syllabus INTEGER NOT NULL DEFAULT 0; CREATE UNIQUE INDEX IF NOT EXISTS idx_one_syllabus_per_class ON documents(class_id) WHERE is_syllabus=1; PRAGMA user_version = 2;").map_err(|error| error.to_string())?;
        }
        if version < 3 {
            connection.execute_batch("CREATE TABLE IF NOT EXISTS document_folders (id TEXT PRIMARY KEY NOT NULL, class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT 'Paper group', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); ALTER TABLE documents ADD COLUMN folder_id TEXT REFERENCES document_folders(id) ON DELETE SET NULL; CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id); PRAGMA user_version = 3;").map_err(|error| error.to_string())?;
        }
        if version < 4 {
            connection.execute_batch("ALTER TABLE documents ADD COLUMN linked_pdf_path TEXT; PRAGMA user_version = 4;").map_err(|error| error.to_string())?;
        }
        if version < 5 {
            connection.execute_batch(r#"
                CREATE TABLE IF NOT EXISTS lectures (
                    id TEXT PRIMARY KEY NOT NULL,
                    class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
                    course_code TEXT NOT NULL DEFAULT '',
                    course_name TEXT NOT NULL DEFAULT '',
                    lecture_date TEXT NOT NULL,
                    scheduled_start TEXT,
                    scheduled_end TEXT,
                    professor_snapshot TEXT,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}',
                    content_plain TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_lectures_class_date ON lectures(class_id, lecture_date DESC, created_at DESC);
                PRAGMA user_version = 5;
            "#).map_err(|error| error.to_string())?;
        }
        if version < 6 {
            connection.execute_batch(r#"
                CREATE TABLE IF NOT EXISTS match_records (
                    set_id TEXT PRIMARY KEY NOT NULL REFERENCES flashcard_sets(id) ON DELETE CASCADE,
                    best_seconds INTEGER NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                PRAGMA user_version = 6;
            "#).map_err(|error| error.to_string())?;
        }
        if version < 7 {
            connection.execute_batch(r#"
                ALTER TABLE document_revisions ADD COLUMN content_plain TEXT NOT NULL DEFAULT '';
                CREATE TABLE IF NOT EXISTS lecture_revisions (
                    id TEXT PRIMARY KEY NOT NULL,
                    lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    content_plain TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_document_revisions_document ON document_revisions(document_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_lecture_revisions_lecture ON lecture_revisions(lecture_id, created_at DESC);
                PRAGMA user_version = 7;
            "#).map_err(|error| error.to_string())?;
        }
        if version < 8 {
            connection.execute_batch(r#"
                ALTER TABLE document_revisions ADD COLUMN name TEXT;
                ALTER TABLE document_revisions ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
                ALTER TABLE lecture_revisions ADD COLUMN name TEXT;
                ALTER TABLE lecture_revisions ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
                PRAGMA user_version = 8;
            "#).map_err(|error| error.to_string())?;
        }
        if version < 9 {
            connection.execute_batch(r#"
                CREATE TABLE IF NOT EXISTS study_webs (
                    id TEXT PRIMARY KEY NOT NULL,
                    class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
                    flashcard_set_id TEXT NOT NULL REFERENCES flashcard_sets(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    source_hash TEXT NOT NULL DEFAULT '',
                    generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS study_web_groups (
                    id TEXT PRIMARY KEY NOT NULL,
                    study_web_id TEXT NOT NULL REFERENCES study_webs(id) ON DELETE CASCADE,
                    label TEXT NOT NULL,
                    parent_group_id TEXT
                );
                CREATE TABLE IF NOT EXISTS study_web_nodes (
                    study_web_id TEXT NOT NULL REFERENCES study_webs(id) ON DELETE CASCADE,
                    flashcard_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
                    x REAL NOT NULL,
                    y REAL NOT NULL,
                    manually_positioned INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (study_web_id, flashcard_id)
                );
                CREATE TABLE IF NOT EXISTS study_web_group_members (
                    study_web_id TEXT NOT NULL REFERENCES study_webs(id) ON DELETE CASCADE,
                    group_id TEXT NOT NULL REFERENCES study_web_groups(id) ON DELETE CASCADE,
                    flashcard_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
                    PRIMARY KEY (study_web_id, group_id, flashcard_id)
                );
                CREATE TABLE IF NOT EXISTS study_web_relationships (
                    id TEXT PRIMARY KEY NOT NULL,
                    study_web_id TEXT NOT NULL REFERENCES study_webs(id) ON DELETE CASCADE,
                    source_flashcard_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
                    target_flashcard_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
                    relationship_type TEXT NOT NULL DEFAULT 'related_to',
                    strength REAL NOT NULL DEFAULT 0.5
                );
                CREATE INDEX IF NOT EXISTS idx_study_webs_class ON study_webs(class_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_study_web_nodes_web ON study_web_nodes(study_web_id);
                CREATE INDEX IF NOT EXISTS idx_study_web_relationships_web ON study_web_relationships(study_web_id);
                PRAGMA user_version = 9;
            "#).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn validate_secret_input(pin: Option<&str>, password: Option<&str>) -> Result<(), String> {
    if let Some(pin) = pin {
        if !((pin.len() == 4 || pin.len() == 6) && pin.bytes().all(|byte| byte.is_ascii_digit())) {
            return Err("A PIN must be exactly 4 or 6 digits.".into());
        }
    }
    if let Some(password) = password {
        if password.len() < 8 {
            return Err("A password must be at least 8 characters.".into());
        }
    }
    Ok(())
}

fn new_security_metadata(
    pin: Option<&str>,
    password: Option<&str>,
) -> Result<SecurityMetadata, String> {
    validate_secret_input(pin, password)?;
    if pin.is_none() && password.is_none() {
        return Err("Choose a PIN, a password, or both before enabling security.".into());
    }
    Ok(SecurityMetadata {
        version: 2,
        pin: pin.map(|value| new_credential(Some(value.len() as u8))),
        password: password.map(|_| new_credential(None)),
    })
}
fn new_credential(pin_digits: Option<u8>) -> CredentialMetadata {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    CredentialMetadata {
        salt: hex_encode(&salt),
        pin_digits,
    }
}

fn derive_key(
    config: &SecurityMetadata,
    pin: Option<&str>,
    password: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut digest = Sha256::new();
    digest.update(b"SoFlo encrypted library key v1");
    if let Some(credential) = &config.pin {
        let secret = pin
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Enter your PIN to continue.".to_string())?;
        digest.update(b"pin");
        digest.update(derive_component(secret, credential)?);
    }
    if let Some(credential) = &config.password {
        let secret = password
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Enter your password to continue.".to_string())?;
        digest.update(b"password");
        digest.update(derive_component(secret, credential)?);
    }
    Ok(digest.finalize().to_vec())
}
fn derive_component(secret: &str, credential: &CredentialMetadata) -> Result<[u8; 32], String> {
    let salt = hex_decode(&credential.salt)?;
    let parameters = Params::new(KDF_MEMORY_KIB, KDF_ITERATIONS, 1, Some(32))
        .map_err(|error| error.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, parameters);
    let mut output = [0u8; 32];
    argon2
        .hash_password_into(secret.as_bytes(), &salt, &mut output)
        .map_err(|_| "SoFlo could not derive the encryption key.".to_string())?;
    Ok(output)
}

fn encrypt_bytes(bytes: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    if key.len() != 32 {
        return Err("SoFlo could not derive the encryption key.".into());
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "SoFlo could not initialize encryption.".to_string())?;
    let mut nonce = [0u8; NONCE_LENGTH];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), bytes)
        .map_err(|_| "SoFlo could not encrypt the library.".to_string())?;
    let mut output = Vec::with_capacity(ENCRYPTED_HEADER.len() + NONCE_LENGTH + ciphertext.len());
    output.extend_from_slice(ENCRYPTED_HEADER);
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}
fn decrypt_bytes(bytes: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() <= ENCRYPTED_HEADER.len() + NONCE_LENGTH || !bytes.starts_with(ENCRYPTED_HEADER)
    {
        return Err("SoFlo's encrypted library is invalid.".into());
    }
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "SoFlo could not initialize encryption.".to_string())?;
    cipher
        .decrypt(
            XNonce::from_slice(
                &bytes[ENCRYPTED_HEADER.len()..ENCRYPTED_HEADER.len() + NONCE_LENGTH],
            ),
            &bytes[ENCRYPTED_HEADER.len() + NONCE_LENGTH..],
        )
        .map_err(|_| "SoFlo could not decrypt the library.".into())
}

fn owned_sqlite_bytes(bytes: Vec<u8>) -> Result<OwnedData, String> {
    if bytes.is_empty() {
        return Err("SoFlo's library is empty.".into());
    }
    let raw = unsafe { rusqlite::ffi::sqlite3_malloc64(bytes.len() as u64) }.cast::<u8>();
    let pointer = NonNull::new(raw)
        .ok_or_else(|| "SoFlo could not allocate secure library memory.".to_string())?;
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.as_ptr(), bytes.len());
        Ok(OwnedData::from_raw_nonnull(pointer, bytes.len()))
    }
}
fn connection_from_bytes(bytes: Vec<u8>) -> Result<Connection, String> {
    let mut connection = Connection::open_in_memory().map_err(|error| error.to_string())?;
    connection
        .deserialize(DatabaseName::Main, owned_sqlite_bytes(bytes)?, false)
        .map_err(|error| error.to_string())?;
    Ok(connection)
}
fn validate_schema(connection: &Connection) -> Result<(), String> {
    let count: i32 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='semesters'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "This file is not a valid SoFlo backup.".to_string())?;
    if count == 1 {
        Ok(())
    } else {
        Err("This file is not a valid SoFlo backup.".into())
    }
}
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}
fn remove_file_if_present(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}
fn remove_sidecars(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .ok_or_else(|| "Could not locate the SoFlo database.".to_string())?
        .to_string_lossy();
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = path.with_file_name(format!("{name}{suffix}"));
        remove_file_if_present(&sidecar)?;
    }
    Ok(())
}
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("SoFlo's security configuration is invalid.".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "SoFlo's security configuration is invalid.".to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_structured_version_history_columns() {
        let directory = std::env::temp_dir().join(format!("soflo-history-test-{}", uuid::Uuid::new_v4()));
        let database = Database::new(directory.join("soflo.sqlite3")).expect("create database");
        let connection = database.open().expect("open database");
        let version: i32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).expect("schema version");
        assert_eq!(version, 9);
        for table in ["document_revisions", "lecture_revisions"] {
            let mut statement = connection.prepare(&format!("PRAGMA table_info({table})")).expect("revision columns");
            let columns = statement.query_map([], |row| row.get::<_, String>(1)).expect("column rows").collect::<Result<Vec<_>, _>>().expect("column names");
            assert!(columns.contains(&"content".to_string()));
            assert!(columns.contains(&"content_plain".to_string()));
            assert!(columns.contains(&"name".to_string()));
            assert!(columns.contains(&"source".to_string()));
        }
        for table in ["study_webs", "study_web_groups", "study_web_nodes", "study_web_group_members", "study_web_relationships"] {
            let exists: i64 = connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [table], |row| row.get(0)).expect("study web table lookup");
            assert_eq!(exists, 1, "missing {table}");
        }
        drop(connection);
        drop(database);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn encrypts_the_library_and_requires_the_configured_credentials() {
        let directory =
            std::env::temp_dir().join(format!("soflo-security-test-{}", uuid::Uuid::new_v4()));
        let path = directory.join("soflo.sqlite3");
        let database = Database::new(path.clone()).expect("create database");
        database.open().expect("open plaintext").execute("INSERT INTO semesters (id, name, term, year) VALUES ('semester', 'Fall 2026', 'Fall', 2026)", []).expect("insert data");
        database
            .update_security(UpdateLibrarySecurityInput {
                current_pin: None,
                current_password: None,
                new_pin: Some("123456".into()),
                new_password: Some("correct horse battery staple".into()),
                remove_pin: false,
                remove_password: false,
            })
            .expect("enable encryption");
        assert_eq!(
            database
                .security_status()
                .expect("security status")
                .pin_digits,
            Some(6)
        );
        database.sync_encrypted().expect("sync encrypted data");
        assert!(!path.exists());
        let encrypted = fs::read(directory.join("soflo.library.enc")).expect("encrypted bytes");
        assert!(encrypted.starts_with(ENCRYPTED_HEADER));
        assert!(!String::from_utf8_lossy(&encrypted).contains("Fall 2026"));
        drop(database);

        let locked = Database::new(path.clone()).expect("reopen database");
        assert!(locked.security_status().expect("status").locked);
        assert!(locked
            .unlock(UnlockLibraryInput {
                pin: Some("000000".into()),
                password: Some("correct horse battery staple".into())
            })
            .is_err());
        locked
            .unlock(UnlockLibraryInput {
                pin: Some("123456".into()),
                password: Some("correct horse battery staple".into()),
            })
            .expect("unlock database");
        let count: i32 = locked
            .open()
            .expect("open unlocked database")
            .query_row("SELECT COUNT(*) FROM semesters", [], |row| row.get(0))
            .expect("read data");
        assert_eq!(count, 1);
        drop(locked);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn soflo_archive_round_trips_plaintext_and_encrypted_libraries() {
        let directory = std::env::temp_dir().join(format!("soflo-archive-test-{}", uuid::Uuid::new_v4()));
        let source_path = directory.join("source").join("soflo.sqlite3");
        let archive_path = directory.join("export.soflo");
        let source = Database::new(source_path.clone()).expect("create source database");
        source.open().expect("open source").execute("INSERT INTO semesters (id, name, term, year) VALUES ('semester', 'Fall 2026', 'Fall', 2026)", []).expect("insert source data");
        source.export_archive(&archive_path).expect("export plaintext archive");

        let plain_target_path = directory.join("plain-target").join("soflo.sqlite3");
        let plain_target = Database::new(plain_target_path.clone()).expect("create plain target");
        plain_target.import_archive(&archive_path).expect("import plaintext archive");
        let count: i32 = plain_target.open().expect("open imported plaintext").query_row("SELECT COUNT(*) FROM semesters WHERE id='semester'", [], |row| row.get(0)).expect("read plaintext import");
        assert_eq!(count, 1);

        source.update_security(UpdateLibrarySecurityInput { current_pin: None, current_password: None, new_pin: Some("1234".into()), new_password: None, remove_pin: false, remove_password: false }).expect("encrypt source");
        source.export_archive(&archive_path).expect("export encrypted archive");
        let encrypted_target_path = directory.join("encrypted-target").join("soflo.sqlite3");
        let encrypted_target = Database::new(encrypted_target_path.clone()).expect("create encrypted target");
        encrypted_target.import_archive(&archive_path).expect("import encrypted archive");
        drop(encrypted_target);
        let locked = Database::new(encrypted_target_path).expect("reopen encrypted target");
        assert!(locked.security_status().expect("encrypted status").locked);
        locked.unlock(UnlockLibraryInput { pin: Some("1234".into()), password: None }).expect("unlock imported archive");
        let count: i32 = locked.open().expect("open imported encrypted library").query_row("SELECT COUNT(*) FROM semesters WHERE id='semester'", [], |row| row.get(0)).expect("read encrypted import");
        assert_eq!(count, 1);
        drop(locked);
        drop(plain_target);
        drop(source);
        let _ = fs::remove_dir_all(directory);
    }
}
