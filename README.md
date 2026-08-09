# SoFlo

SoFlo is a private, local-first study workspace for Windows. Keep your classes, papers, syllabi, schedules, flashcards, and study sessions together without creating an account or sending your library to a cloud service.

## Download

Download SoFlo from the repository’s **Releases** page. Install the latest `.msi` file, then open SoFlo from the Start menu.

Your library is stored on your own PC and remains there across normal updates. Use **Settings → Library data → Create backup** to save a portable backup whenever you want an extra copy.

## What you can do

- Organize papers, syllabi, and flashcard sets by semester and class.
- Write in a US Letter, Google Docs-style rich-text paper editor with automatic local saves.
- Import editable text from PDF and Word documents.
- Study with Flashcards, Learn, Test, Match, and an all-cards class view.
- Set a PIN and/or password to encrypt the library stored on your PC.
- Optionally use a compact local AI model for document formatting and flashcard generation. It downloads only when requested and runs locally.

## Getting started

1. Open SoFlo and complete the brief welcome setup.
2. Create a semester, then add your classes.
3. Create or import papers in a class.
4. Add flashcards manually or use **Create with AI** when local AI is enabled.
5. Back up your library from Settings before making major changes or moving computers.

## Development

Requirements: Node.js, Rust, and the Windows build tools required by Tauri.

```powershell
npm install
npm run tauri dev
```

Useful checks:

```powershell
npm run build
npm test
cd src-tauri; cargo check
```

Create the Windows release installer:

```powershell
npm run tauri build
```

The MSI is written to `src-tauri/target/release/bundle/msi/`.
