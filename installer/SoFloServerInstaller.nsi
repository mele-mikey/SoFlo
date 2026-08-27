; Branded, per-user installer for the standalone SoFlo Server application.
; It preserves the Server's model, pairing, and Cloudflare configuration on update.
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
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "WinMessages.nsh"

!ifndef APP_EXE
  !error "APP_EXE must point to the release SoFlo Server executable."
!endif
!ifndef LLAMA_DIR
  !error "LLAMA_DIR must point to the llama.cpp runtime directory."
!endif
!ifndef CLOUDFLARED_EXE
  !error "CLOUDFLARED_EXE must point to the signed cloudflared.exe runtime."
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
!define MUI_BGCOLOR "1D1B24"
!define MUI_TEXTCOLOR "F4F1FA"
!define MUI_CUSTOMFUNCTION_GUIINIT SoFloServerMUIInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.SoFloServerMUIInit

Name "${PRODUCT}"
OutFile "${OUTFILE}"
Caption "SoFlo Server Setup"
BrandingText "SoFlo Server - private AI over Cloudflare"
InstallDir "$LOCALAPPDATA\Programs\SoFlo Server"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "SoFlo Server Setup"
VIAddVersionKey "FileDescription" "SoFlo Server Windows Installer"
VIAddVersionKey "CompanyName" "Mikey M."
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 Mikey M."
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

Var StartAtLogin
Var DesktopShortcut
Var LaunchNow
Var OptionsStartup
Var OptionsDesktop
Var LocationPath
Var LocationBrowse
Var FinishLaunch
Var ReplacePid

!macro ServerDarkCanvas
  ${NSD_CreateLabel} 0 0 100% 100% ""
  Pop $2
  SetCtlColors $2 0xEDEAF4 0x1D1B24
!macroend

!macro ServerText HANDLE COLOR SIZE WEIGHT
  SetCtlColors ${HANDLE} ${COLOR} 0x1D1B24
  CreateFont $0 "$(^Font)" "${SIZE}" "${WEIGHT}"
  SendMessage ${HANDLE} ${WM_SETFONT} $0 1
!macroend

Page custom WelcomePage
Page custom OptionsPage OptionsLeave
Page custom InstallLocationPage InstallLocationLeave
!define MUI_PAGE_HEADER_TEXT "Installing SoFlo Server"
!define MUI_PAGE_HEADER_SUBTEXT "A private General AI service for your SoFlo laptop."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW InstallProgressShow
!insertmacro MUI_PAGE_INSTFILES
Page custom FinishPage FinishLeave
UninstPage custom un.ConfirmPage
!define MUI_PAGE_HEADER_TEXT "Removing SoFlo Server"
!define MUI_PAGE_HEADER_SUBTEXT "Your Server configuration stays safe unless you remove it yourself."
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  StrCpy $StartAtLogin 1
  StrCpy $DesktopShortcut 1
  StrCpy $LaunchNow 1
  ${GetParameters} $0
  ${GetOptions} $0 "--replace-pid=" $ReplacePid

  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "DisplayVersion"
  ${If} $0 != ""
    ${VersionCompare} "$0" "${APP_VERSION}" $1
    ${If} $1 != 2
      MessageBox MB_ICONINFORMATION "SoFlo Server v$0 is already installed. This setup is v${APP_VERSION}, so no files were changed."
      Abort
    ${EndIf}
    ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndIf}

  ${If} $ReplacePid != ""
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /PID $ReplacePid /T /F'
  ${EndIf}
FunctionEnd

Function SoFloServerMUIInit
  SetCtlColors $HWNDPARENT 0xF4F1FA 0x1D1B24
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Continue"
  SetCtlColors $0 0x1D1B24 0xB6AEFF
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Cancel"
  SetCtlColors $0 0xF4F1FA 0x2A2733
  GetDlgItem $0 $HWNDPARENT 3
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Back"
  SetCtlColors $0 0xF4F1FA 0x2A2733
FunctionEnd

Function un.SoFloServerMUIInit
  SetCtlColors $HWNDPARENT 0xF4F1FA 0x1D1B24
FunctionEnd

Function WelcomePage
  !insertmacro MUI_HEADER_TEXT "SoFlo Server" "Run General AI on this Windows PC."
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}
  !insertmacro ServerDarkCanvas
  ${NSD_CreateLabel} 0 8u 100% 18u "SOFLO SERVER FOR WINDOWS"
  Pop $1
  !insertmacro ServerText $1 0xB6AEFF "9" "700"
  ${NSD_CreateLabel} 0 36u 96% 35u "Your private AI,\ron your hardware."
  Pop $1
  !insertmacro ServerText $1 0xF4F1FA "20" "700"
  ${NSD_CreateLabel} 0 89u 96% 44u "SoFlo Server runs one General AI model on this PC. It is reached only through your Cloudflare Tunnel and the pairing key you generate after installation."
  Pop $1
  !insertmacro ServerText $1 0xC2BDCC "10" "400"
  ${NSD_CreateLabel} 0 142u 96% 22u "No account or model is bundled. Your Server setup stays under your control."
  Pop $1
  !insertmacro ServerText $1 0x918A9B "9" "400"
  nsDialogs::Show
FunctionEnd

Function OptionsPage
  !insertmacro MUI_HEADER_TEXT "Server preferences" "Choose how the Server stays available."
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}
  !insertmacro ServerDarkCanvas
  ${NSD_CreateLabel} 0 8u 100% 18u "SERVER PREFERENCES"
  Pop $1
  !insertmacro ServerText $1 0xB6AEFF "9" "700"
  ${NSD_CreateLabel} 0 36u 96% 24u "Keep your desktop ready when you are away."
  Pop $1
  !insertmacro ServerText $1 0xF4F1FA "16" "700"
  ${NSD_CreateCheckbox} 0 79u 100% 13u "Start SoFlo Server when I sign in to Windows"
  Pop $OptionsStartup
  SetCtlColors $OptionsStartup 0xEDEAF4 0x1D1B24
  ${If} $StartAtLogin == 1
    ${NSD_Check} $OptionsStartup
  ${EndIf}
  ${NSD_CreateCheckbox} 0 105u 100% 13u "Create a desktop shortcut"
  Pop $OptionsDesktop
  SetCtlColors $OptionsDesktop 0xEDEAF4 0x1D1B24
  ${If} $DesktopShortcut == 1
    ${NSD_Check} $OptionsDesktop
  ${EndIf}
  ${NSD_CreateLabel} 0 137u 96% 27u "The Server will still pause if Windows sleeps. Monitors can turn off normally."
  Pop $1
  !insertmacro ServerText $1 0x918A9B "9" "400"
  nsDialogs::Show
FunctionEnd

Function OptionsLeave
  ${NSD_GetState} $OptionsStartup $StartAtLogin
  ${NSD_GetState} $OptionsDesktop $DesktopShortcut
FunctionEnd

Function InstallLocationPage
  !insertmacro MUI_HEADER_TEXT "Install location" "SoFlo Server installs only for this Windows account."
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}
  !insertmacro ServerDarkCanvas
  ${NSD_CreateLabel} 0 8u 100% 18u "INSTALL LOCATION"
  Pop $1
  !insertmacro ServerText $1 0xB6AEFF "9" "700"
  ${NSD_CreateLabel} 0 36u 96% 24u "Keep the Server somewhere easy to update."
  Pop $1
  !insertmacro ServerText $1 0xF4F1FA "16" "700"
  ${NSD_CreateText} 0 82u 77% 13u "$INSTDIR"
  Pop $LocationPath
  SetCtlColors $LocationPath 0xF2EFF8 0x2A2733
  ${NSD_CreateButton} 80% 82u 20% 13u "Browse"
  Pop $LocationBrowse
  ${NSD_OnClick} $LocationBrowse BrowseInstallFolder
  ${NSD_CreateLabel} 0 111u 96% 27u "Your AI model, Cloudflare token, and laptop pairing configuration are saved separately and survive upgrades."
  Pop $1
  !insertmacro ServerText $1 0x918A9B "8" "400"
  nsDialogs::Show
FunctionEnd

Function BrowseInstallFolder
  ${NSD_GetText} $LocationPath $0
  nsDialogs::SelectFolderDialog "Choose where SoFlo Server is installed" "$0"
  Pop $0
  ${If} $0 != "error"
  ${AndIf} $0 != ""
    StrCpy $INSTDIR "$0"
    ${NSD_SetText} $LocationPath "$INSTDIR"
  ${EndIf}
FunctionEnd

Function InstallLocationLeave
  ${NSD_GetText} $LocationPath $INSTDIR
  ${If} $INSTDIR == ""
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\SoFlo Server"
  ${EndIf}
FunctionEnd

Function InstallProgressShow
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 0xF4F1FA 0x1D1B24
FunctionEnd

Section "Install SoFlo Server" InstallSection
  SetOutPath "$INSTDIR"
  Call EnsureWebView2
  DetailPrint "Installing SoFlo Server..."
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
  ${If} $DesktopShortcut == 1
    CreateShortcut "$DESKTOP\SoFlo Server.lnk" "$INSTDIR\SoFloServer.exe"
  ${Else}
    Delete "$DESKTOP\SoFlo Server.lnk"
  ${EndIf}
  ${If} $StartAtLogin == 1
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SoFlo Server" '"$INSTDIR\SoFloServer.exe" --minimized'
  ${Else}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SoFlo Server"
  ${EndIf}
  IfFileExists "${APP_DATA}\server.json" server_config_exists
  CreateDirectory "${APP_DATA}"
  FileOpen $0 "${APP_DATA}\server.json" w
  FileWrite $0 "{\r$\n  $\"startWithWindows$\": $StartAtLogin,\r$\n  $\"autoStart$\": false,\r$\n  $\"checkForUpdates$\": true\r$\n}\r$\n"
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
  DetailPrint "Preparing Microsoft WebView2..."
  NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$PLUGINSDIR\MicrosoftEdgeWebView2Setup.exe"
  Pop $0
  ${If} $0 != "success"
    MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "SoFlo Server needs Microsoft WebView2. The download could not start. Check your connection and try again." IDRETRY webview_retry IDCANCEL webview_cancel
    Return
    webview_cancel:
      Abort
  ${EndIf}
  DetailPrint "Installing Microsoft WebView2..."
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2Setup.exe" /silent /install' $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Microsoft WebView2 could not be installed. SoFlo Server cannot open without it."
    Abort
  ${EndIf}
FunctionEnd

Function FinishPage
  !insertmacro MUI_HEADER_TEXT "SoFlo Server is ready" "Choose your model and Cloudflare Tunnel next."
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}
  !insertmacro ServerDarkCanvas
  ${NSD_CreateLabel} 0 8u 100% 18u "SOFLO SERVER IS READY"
  Pop $1
  !insertmacro ServerText $1 0xB6AEFF "9" "700"
  ${NSD_CreateLabel} 0 36u 96% 24u "Your private AI server is installed."
  Pop $1
  !insertmacro ServerText $1 0xF4F1FA "16" "700"
  ${NSD_CreateLabel} 0 68u 96% 34u "Open SoFlo Server to choose a General AI model, enter your Cloudflare Tunnel token, and generate the one-time pairing key for your laptop."
  Pop $1
  !insertmacro ServerText $1 0xC2BDCC "10" "400"
  ${NSD_CreateCheckbox} 0 126u 100% 13u "Open SoFlo Server now"
  Pop $FinishLaunch
  SetCtlColors $FinishLaunch 0xEDEAF4 0x1D1B24
  ${NSD_Check} $FinishLaunch
  nsDialogs::Show
FunctionEnd

Function FinishLeave
  ${NSD_GetState} $FinishLaunch $LaunchNow
  ${If} $LaunchNow == 1
    Exec '"$INSTDIR\SoFloServer.exe"'
  ${EndIf}
FunctionEnd

Function un.ConfirmPage
  !insertmacro MUI_HEADER_TEXT "Remove SoFlo Server" "Your model and Cloudflare configuration are preserved."
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}
  !insertmacro ServerDarkCanvas
  ${NSD_CreateLabel} 0 8u 100% 18u "REMOVE SOFLO SERVER"
  Pop $1
  !insertmacro ServerText $1 0xE88B94 "9" "700"
  ${NSD_CreateLabel} 0 36u 96% 24u "Remove the Server application."
  Pop $1
  !insertmacro ServerText $1 0xF4F1FA "16" "700"
  ${NSD_CreateLabel} 0 70u 96% 36u "Your selected model path, Cloudflare Tunnel token, and pairing configuration are not deleted. Reinstalling SoFlo Server restores them."
  Pop $1
  !insertmacro ServerText $1 0xC2BDCC "10" "400"
  nsDialogs::Show
FunctionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\SoFlo\SoFlo Server.lnk"
  Delete "$SMPROGRAMS\SoFlo\Uninstall SoFlo Server.lnk"
  RMDir "$SMPROGRAMS\SoFlo"
  Delete "$DESKTOP\SoFlo Server.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SoFlo Server"
  Delete "$INSTDIR\SoFloServer.exe"
  Delete "$INSTDIR\cloudflared.exe"
  Delete "$INSTDIR\Uninstall SoFlo Server.exe"
  RMDir /r "$INSTDIR\llama"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${PRODUCT_KEY}"
SectionEnd
