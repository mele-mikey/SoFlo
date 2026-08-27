; SoFlo Server's per-user Windows installer. It deliberately contains no model
; and no Cloudflare credential: both are selected locally after installation.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetDatablockOptimize on
ShowInstDetails nevershow
ShowUninstDetails nevershow

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef APP_EXE
  !error "APP_EXE must point to the release SoFlo Server executable."
!endif
!ifndef LLAMA_DIR
  !error "LLAMA_DIR must point to the llama.cpp runtime directory."
!endif
!ifndef APP_VERSION
  !error "APP_VERSION must be supplied."
!endif
!ifndef OUTFILE
  !error "OUTFILE must point to the generated setup executable."
!endif

!define PRODUCT "SoFlo Server"
!define APP_ID "edu.soflo.server"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SoFlo Server"
!define MUI_ICON "..\src-tauri\icons\icon.ico"
!define MUI_UNICON "..\src-tauri\icons\icon.ico"
!define MUI_BGCOLOR "1D1B24"
!define MUI_TEXTCOLOR "F4F1FA"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
Caption "SoFlo Server Setup"
BrandingText "SoFlo Server · private AI over Cloudflare"
InstallDir "$LOCALAPPDATA\Programs\SoFlo Server"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "SoFlo Server Setup"
VIAddVersionKey "FileDescription" "SoFlo Server Windows Installer"
VIAddVersionKey "CompanyName" "Mikey M."
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_HEADER_TEXT "Installing SoFlo Server"
!define MUI_PAGE_HEADER_SUBTEXT "Your model, Cloudflare Tunnel, and paired SoFlo app stay under your control."
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\SoFloServer.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open SoFlo Server"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "SoFlo Server" SEC01
  SetOutPath "$INSTDIR"
  File /oname=SoFloServer.exe "${APP_EXE}"
  SetOutPath "$INSTDIR\llama"
  File /r "${LLAMA_DIR}\*.*"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall SoFlo Server.exe"
  CreateDirectory "$SMPROGRAMS\SoFlo"
  CreateShortcut "$SMPROGRAMS\SoFlo\SoFlo Server.lnk" "$INSTDIR\SoFloServer.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "SoFlo Server"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\SoFloServer.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall SoFlo Server.exe$\""
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\SoFlo\SoFlo Server.lnk"
  RMDir "$SMPROGRAMS\SoFlo"
  Delete "$INSTDIR\SoFloServer.exe"
  Delete "$INSTDIR\Uninstall SoFlo Server.exe"
  RMDir /r "$INSTDIR\llama"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SoFlo Server"
SectionEnd
