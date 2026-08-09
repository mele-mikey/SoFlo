# SoFlo

SoFlo is a private, local-first study workspace for Windows. Keep your classes, papers, syllabi, schedules, flashcards, and study sessions together without creating an account or sending your library to a cloud service.

## Download

Download the latest `SoFlo-Setup-<version>.exe` from the repository's **Releases** page, run it, and open SoFlo from the Start menu. The installer can add a desktop shortcut and optionally prepare the local AI-model location without downloading the model.

The setup executable is standalone: people installing SoFlo do **not** need Node.js, Rust, Tauri, Visual Studio, or any other development tools. It supports Windows 10 and 11. If Microsoft Edge WebView2 is not already present, setup downloads and installs that Microsoft runtime automatically, so only that uncommon case needs an internet connection during installation.

Your library is stored on your own PC and remains there across normal updates. Use **Settings → Danger zone → Export .soflo data** to make one portable library file whenever you want an extra copy or need to move to another computer.

## What you can do

- Organize papers, lectures, syllabi, and flashcard sets by semester and class.
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
5. Export your library from **Settings → Danger zone** before making major changes or moving computers.

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
npm run build:installer
```

The installer is written to `src-tauri/target/release/bundle/nsis-custom/`.

## Credits and license

Created by Mikey M. Copyright © 2026 Mikey M.

SoFlo is source-available under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). You may use, modify, and redistribute it for non-commercial purposes, provided you preserve the required credit and license notice. Commercial use requires permission from Mikey M.

This is deliberately **not** described as OSI open source: an open-source license cannot prohibit commercial use.
