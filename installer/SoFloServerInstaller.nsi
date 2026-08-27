; SoFlo Server's visible setup is the same branded Tauri experience as SoFlo.
; NSIS is deliberately only the silent per-user installation worker.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
RequestExecutionLevel user
; Keep the Server payload inspectable instead of using a solid-packed archive.
SetCompressor /FINAL zlib
SetDatablockOptimize off
ShowInstDetails nevershow
ShowUninstDetails nevershow
SilentInstall silent
AutoCloseWindow true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"

!ifndef APP_EXE
  !error "APP_EXE must point to the release SoFlo Server executable."
!endif
!ifndef LLAMA_DIR
  !error "LLAMA_DIR must point to the llama.cpp runtime directory."
!endif
!ifndef CLOUDFLARED_EXE
  !error "CLOUDFLARED_EXE must point to cloudflared.exe."
!endif
!ifndef APP_VERSION
  !error "APP_VERSION must be supplied."
!endif
!ifndef OUTFILE
  !error "OUTFILE must be supplied."
!endif

!define PRODUCT "SoFlo Server"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SoFlo Server"
!define PRODUCT_KEY "Software\SoFlo Server"
!define APP_DATA "$APPDATA\edu.soflo.server"
!define MUI_ICON "..\src-tauri\icons\icon.ico"
!define MUI_UNICON "..\src-tauri\icons\icon.ico"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
Caption "SoFlo Server Setup"
BrandingText "SoFlo Server"
InstallDir "$LOCALAPPDATA\Programs\SoFlo Server"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "SoFlo Server Setup"
VIAddVersionKey "FileDescription" "SoFlo Server Windows Installer"
VIAddVersionKey "CompanyName" "Mikey M."
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 Mikey M."
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

Var WorkerMode
Var ReplacePid

Function .onInit
  StrCpy $WorkerMode 0
  ${GetParameters} $0
  ${GetOptions} $0 "--perform-silent-install=" $1
  ${If} $1 != "1"
    SetSilent silent
    Return
  ${EndIf}
  StrCpy $WorkerMode 1
  SetSilent silent
  ${GetOptions} $0 "--replace-pid=" $ReplacePid
  ${If} $ReplacePid != ""
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /PID $ReplacePid /T /F'
  ${EndIf}
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "DisplayVersion"
  ${If} $0 != ""
    ${VersionCompare} "$0" "${APP_VERSION}" $1
    ${If} $1 != 2
      SetErrorLevel 1
      Quit
    ${EndIf}
    ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Install SoFlo Server"
  ${If} $WorkerMode == 0
    ; Keep the branded UI in a stable folder: NSIS plug-in temp folders vanish
    ; as the bootstrapper exits and can race the UI process.
    CreateDirectory "$LOCALAPPDATA\SoFlo Server\InstallerUI"
    SetOutPath "$LOCALAPPDATA\SoFlo Server\InstallerUI"
    File /oname=SoFlo-Server-SetupUI.exe "${APP_EXE}"
    ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "DisplayVersion"
    ExecShell "open" "$LOCALAPPDATA\SoFlo Server\InstallerUI\SoFlo-Server-SetupUI.exe" '--installer --setup-exe="$EXEPATH" --current-version="$0" --target-version="${APP_VERSION}"'
    Quit
  ${EndIf}
  SetOutPath "$INSTDIR"
  Call EnsureWebView2
  SetOverwrite on
  File /oname=SoFloServer.exe "${APP_EXE}"
  File /oname=cloudflared.exe "${CLOUDFLARED_EXE}"
  SetOutPath "$INSTDIR\llama"
  File /r "${LLAMA_DIR}\*.*"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall SoFlo Server.exe"
  CreateDirectory "$SMPROGRAMS\SoFlo"
  CreateShortcut "$SMPROGRAMS\SoFlo\SoFlo Server.lnk" "$INSTDIR\SoFloServer.exe"
  CreateShortcut "$SMPROGRAMS\SoFlo\Uninstall SoFlo Server.lnk" "$INSTDIR\Uninstall SoFlo Server.exe"
  CreateDirectory "${APP_DATA}"
  IfFileExists "${APP_DATA}\server.json" server_config_exists
  FileOpen $0 "${APP_DATA}\server.json" w
  FileWrite $0 "{\r$\n  $\"startWithWindows$\": false,\r$\n  $\"autoStart$\": false,\r$\n  $\"checkForUpdates$\": true\r$\n}\r$\n"
  FileClose $0
  server_config_exists:
  WriteRegStr HKCU "${PRODUCT_KEY}" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "SoFlo Server"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "SoFlo"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" '"$INSTDIR\SoFloServer.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall SoFlo Server.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Function EnsureWebView2
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 != ""
    Return
  ${EndIf}
  webview_retry:
  InitPluginsDir
  NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$PLUGINSDIR\MicrosoftEdgeWebView2Setup.exe"
  Pop $0
  ${If} $0 != "success"
    MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "SoFlo Server needs Microsoft WebView2. The download could not start. Check your connection and try again." IDRETRY webview_retry IDCANCEL webview_cancel
    Return
    webview_cancel:
      Abort
  ${EndIf}
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2Setup.exe" /silent /install' $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Microsoft WebView2 could not be installed. SoFlo Server cannot open without it."
    Abort
  ${EndIf}
FunctionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\SoFlo\SoFlo Server.lnk"
  Delete "$SMPROGRAMS\SoFlo\Uninstall SoFlo Server.lnk"
  RMDir "$SMPROGRAMS\SoFlo"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SoFlo Server"
  Delete "$DESKTOP\SoFlo Server.lnk"
  Delete "$INSTDIR\SoFloServer.exe"
  Delete "$INSTDIR\cloudflared.exe"
  Delete "$INSTDIR\Uninstall SoFlo Server.exe"
  RMDir /r "$INSTDIR\llama"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${PRODUCT_KEY}"
SectionEnd
