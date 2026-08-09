# SoFlo

© 2026 Mikey M. — shared under the PolyForm Noncommercial 1.0.0 license.

I made SoFlo because I wanted one calm place to keep up with college: classes, papers, lecture notes, syllabi, flashcards, and study sessions. It is built for Windows and keeps your library on your own computer. There is no account to make and no required cloud service.

## Download and install

Head to this repository's **Releases** page and download the latest `SoFlo-Setup-<version>.exe`. Run it, then open SoFlo from the Start menu. The installer can also create a desktop shortcut.

Your library stays on your PC through normal app updates. To make a portable backup or move your work to another device, use **Settings → Danger zone → Export SoFlo data**. That creates one `.soflo` file with your library.

## What you can do

- Keep papers, lectures, syllabi, flashcard sets, and classes together by semester.
- Write on a US Letter paper layout with a Google Docs-style rich-text editor and automatic local saving.
- Import editable text from PDF and Word documents.
- Study with Flashcards, Learn, Test, Match, and an all-cards view for each class.
- Protect your local library with a PIN, password, or both.
- Use an optional compact local AI model for formatting documents and creating flashcards. I made it download only when you choose an AI action, and it runs on your computer.

## Getting started

1. Open SoFlo and go through the quick welcome setup.
2. Create a semester and add your classes.
3. Create a paper or import one into a class.
4. Add flashcards yourself, or use **Create with AI** if local AI is enabled.
5. Export a `.soflo` backup from **Settings → Danger zone** before a big change or when moving to another computer.

## Building SoFlo yourself

If you want to contribute or build it from source, you will need Node.js, Rust, and the Windows build tools required by Tauri.

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

To create the Windows installer:

```powershell
npm run build:installer
```

You will find the finished installer in `src-tauri/target/release/bundle/nsis-custom/`.

## Credit and license

I’m Mikey M., and I made SoFlo. © 2026 Mikey M.

I’m sharing SoFlo under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). You’re welcome to use it, learn from it, modify it, and share your changes for non-commercial purposes—just keep my credit and the license notice with it. If you want to use SoFlo commercially, reach out to me first.
