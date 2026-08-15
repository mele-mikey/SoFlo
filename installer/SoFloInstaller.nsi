; SoFlo's user-facing Windows installer. It is intentionally a per-user NSIS
; bootstrapper: no account, no bundled model download, and no UAC for normal use.
Unicode true
ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetDatablockOptimize on
ShowInstDetails nevershow
ShowUninstDetails nevershow
SilentInstall silent
AutoCloseWindow true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "WinMessages.nsh"

!ifndef APP_EXE
  !error "APP_EXE must point to the release SoFlo executable."
!endif
!ifndef APP_VERSION
  !error "APP_VERSION must be supplied (for example 1.0.29)."
!endif
!ifndef OUTFILE
  !error "OUTFILE must point to the generated setup executable."
!endif

!define PRODUCT "SoFlo"
!define COMPANY "SoFlo"
!define APP_ID "edu.soflo.desktop"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SoFlo"
!define PRODUCT_KEY "Software\SoFlo"
!define APP_DATA "$APPDATA\edu.soflo.desktop"
!define MODEL_FILE "Qwen3-4B-Q4_K_M.gguf"
!define MUI_ICON "..\src-tauri\icons\icon.ico"
!define MUI_UNICON "..\src-tauri\icons\icon.ico"
!define MUI_ABORTWARNING
!define MUI_BGCOLOR "1D1B24"
!define MUI_TEXTCOLOR "F4F1FA"
!define MUI_CUSTOMFUNCTION_GUIINIT SoFloMUIInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.SoFloMUIInit

Name "${PRODUCT}"
OutFile "${OUTFILE}"
Caption "SoFlo Setup"
BrandingText "SoFlo · focused study, kept local"
InstallDir "$LOCALAPPDATA\Programs\SoFlo"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "SoFlo Setup"
VIAddVersionKey "FileDescription" "SoFlo Windows Installer"
VIAddVersionKey "CompanyName" "Mikey M."
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 Mikey M."
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"

Var ModelPath
Var LaunchAtStartup
Var StartMinimized
Var CreateDesktopShortcut
Var LaunchNow
Var OptionsModelPath
Var OptionsBrowse
Var OptionsStartup
Var OptionsMinimized
Var OptionsDesktop
Var LocationPath
Var LocationBrowse
Var FinishLaunch
Var UninstallData
Var WorkerMode

!macro SoFloDarkCanvas
  ${NSD_CreateLabel} 0 0 100% 100% ""
  Pop $2
  SetCtlColors $2 0xEDEAF4 0x1D1B24
!macroend

!macro SoFloText HANDLE COLOR SIZE WEIGHT
  SetCtlColors ${HANDLE} ${COLOR} 0x1D1B24
  CreateFont $0 "$(^Font)" "${SIZE}" "${WEIGHT}"
  SendMessage ${HANDLE} ${WM_SETFONT} $0 1
!macroend

Page custom WelcomePage
Page custom OptionsPage OptionsLeave
Page custom InstallLocationPage InstallLocationLeave
!define MUI_PAGE_HEADER_TEXT "Installing SoFlo"
!define MUI_PAGE_HEADER_SUBTEXT "Your private study workspace is being prepared."
!define MUI_PAGE_CUSTOMFUNCTION_SHOW InstallProgressShow
!insertmacro MUI_PAGE_INSTFILES
Page custom FinishPage FinishLeave
UninstPage custom un.ConfirmPage un.ConfirmLeave
!define MUI_PAGE_HEADER_TEXT "Removing SoFlo"
!define MUI_PAGE_HEADER_SUBTEXT "The desktop app is being removed."
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; The visible experience is SoFlo's own Tauri installer. NSIS only performs
  ; the file and registry work silently after that window asks it to continue.
  StrCpy $WorkerMode 0
  ${GetParameters} $0
  ${GetOptions} $0 "--perform-silent-install=" $1
  ${If} $1 != "1"
    SetSilent silent
    Return
  ${EndIf}
  StrCpy $WorkerMode 1
  SetSilent silent

  ; SoFlo installers are forward-only. The visible setup UI also checks this,
  ; but the worker enforces it so command-line use cannot replace a newer app.
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "DisplayVersion"
  ${If} $0 != ""
    ${VersionCompare} "$0" "${APP_VERSION}" $1
    ${If} $1 != 2
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}

  ; Existing per-user install: preserve its location and installer preferences.
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
  ReadRegStr $ModelPath HKCU "${PRODUCT_KEY}" "ModelPath"
  ${If} $ModelPath == ""
    StrCpy $ModelPath "$LOCALAPPDATA\SoFlo\Models\${MODEL_FILE}"
  ${EndIf}
  ReadRegDWORD $LaunchAtStartup HKCU "${PRODUCT_KEY}" "LaunchAtStartup"
  ReadRegDWORD $StartMinimized HKCU "${PRODUCT_KEY}" "StartMinimized"
  ReadRegDWORD $CreateDesktopShortcut HKCU "${PRODUCT_KEY}" "DesktopShortcut"
  StrCpy $LaunchNow 1
FunctionEnd

Function SoFloMUIInit
  SetCtlColors $HWNDPARENT 0xF4F1FA 0x1D1B24
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 0x918A9B 0x1D1B24
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 0x918A9B 0x1D1B24
  GetDlgItem $0 $HWNDPARENT 1035
  SetCtlColors $0 0x1D1B24 0x1D1B24
  GetDlgItem $0 $HWNDPARENT 1045
  SetCtlColors $0 0x1D1B24 0x1D1B24
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

Function un.SoFloMUIInit
  SetCtlColors $HWNDPARENT 0xF4F1FA 0x1D1B24
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 0x918A9B 0x1D1B24
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 0x918A9B 0x1D1B24
  GetDlgItem $0 $HWNDPARENT 1035
  SetCtlColors $0 0x1D1B24 0x1D1B24
  GetDlgItem $0 $HWNDPARENT 1045
  SetCtlColors $0 0x1D1B24 0x1D1B24
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

Function WelcomePage
  !insertmacro MUI_HEADER_TEXT "SoFlo Setup" "A private space for your study life."
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}
  !insertmacro SoFloDarkCanvas
  ${NSD_CreateLabel} 0 6u 100% 18u "SOFLO FOR WINDOWS"
  Pop $1
  !insertmacro SoFloText $1 0xB6AEFF "9" "700"
  ${NSD_CreateLabel} 0 31u 100% 28u "A calmer place for class."
  Pop $1
  !insertmacro SoFloText $1 0xF4F1FA "17" "700"
  ${NSD_CreateLabel} 0 67u 96% 46u "Everything for class, from your first lecture to your final exam."
  Pop $1
  !insertmacro SoFloText $1 0xC2BDCC "10" "400"
  ${NSD_CreateLabel} 0 132u 96% 23u "Installs just for this Windows account."
  Pop $1
  !insertmacro SoFloText $1 0x918A9B "9" "400"
  nsDialogs::Show
FunctionEnd

Function OptionsPage
  !insertmacro MUI_HEADER_TEXT "Install preferences" "Choose the few details SoFlo needs."
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}
  !insertmacro SoFloDarkCanvas
  ${NSD_CreateLabel} 0 6u 100% 18u "SET UP SOFLO"
  Pop $1
  !insertmacro SoFloText $1 0xB6AEFF "9" "700"
  ${NSD_CreateLabel} 0 31u 100% 16u "A few choices you can change later."
  Pop $1
  !insertmacro SoFloText $1 0xF4F1FA "14" "700"
  ${NSD_CreateLabel} 0 59u 100% 11u "AI model storage"
  Pop $1
  !insertmacro SoFloText $1 0xE7E2EE "9" "700"
  ${NSD_CreateText} 0 73u 77% 13u "$ModelPath"
  Pop $OptionsModelPath
  SetCtlColors $OptionsModelPath 0xF2EFF8 0x2A2733
  ${NSD_CreateButton} 80% 73u 20% 13u "Browse"
  Pop $OptionsBrowse
  ${NSD_OnClick} $OptionsBrowse BrowseModelFolder
  ${NSD_CreateLabel} 0 91u 96% 17u "The compact model is never downloaded during setup. This only chooses where it will be kept if you use local AI later."
  Pop $1
  !insertmacro SoFloText $1 0x918A9B "8" "400"
  ${NSD_CreateCheckbox} 0 119u 100% 12u "Launch SoFlo when I sign in"
  Pop $OptionsStartup
  SetCtlColors $OptionsStartup 0xEDEAF4 0x1D1B24
  ${If} $LaunchAtStartup == 1
    ${NSD_Check} $OptionsStartup
  ${EndIf}
  ${NSD_CreateCheckbox} 0 137u 100% 12u "Start minimized when it launches automatically"
  Pop $OptionsMinimized
  SetCtlColors $OptionsMinimized 0xEDEAF4 0x1D1B24
  ${If} $StartMinimized == 1
    ${NSD_Check} $OptionsMinimized
  ${EndIf}
  ${NSD_CreateCheckbox} 0 155u 100% 12u "Create a desktop shortcut"
  Pop $OptionsDesktop
  SetCtlColors $OptionsDesktop 0xEDEAF4 0x1D1B24
  ${If} $CreateDesktopShortcut == 1
    ${NSD_Check} $OptionsDesktop
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function BrowseModelFolder
  ${NSD_GetText} $OptionsModelPath $0
  nsDialogs::SelectFolderDialog "Choose a folder for SoFlo's future AI model" "$0"
  Pop $0
  ${If} $0 != "error"
  ${AndIf} $0 != ""
    StrCpy $ModelPath "$0\${MODEL_FILE}"
    ${NSD_SetText} $OptionsModelPath "$ModelPath"
  ${EndIf}
FunctionEnd

Function OptionsLeave
  ${NSD_GetText} $OptionsModelPath $ModelPath
  ${If} $ModelPath == ""
    StrCpy $ModelPath "$LOCALAPPDATA\SoFlo\Models\${MODEL_FILE}"
  ${EndIf}
  ${NSD_GetState} $OptionsStartup $LaunchAtStartup
  ${NSD_GetState} $OptionsMinimized $StartMinimized
  ${NSD_GetState} $OptionsDesktop $CreateDesktopShortcut
FunctionEnd

Function InstallLocationPage
  !insertmacro MUI_HEADER_TEXT "Install location" "SoFlo installs just for this Windows account."
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}
  !insertmacro SoFloDarkCanvas
  ${NSD_CreateLabel} 0 6u 100% 18u "INSTALL LOCATION"
  Pop $1
  !insertmacro SoFloText $1 0xB6AEFF "9" "700"
  ${NSD_CreateLabel} 0 31u 100% 18u "Keep SoFlo where it is easy to update."
  Pop $1
  !insertmacro SoFloText $1 0xF4F1FA "14" "700"
  ${NSD_CreateLabel} 0 58u 100% 13u "This does not affect where your papers or library are saved."
  Pop $1
  !insertmacro SoFloText $1 0xC2BDCC "9" "400"
  ${NSD_CreateText} 0 83u 77% 13u "$INSTDIR"
  Pop $LocationPath
  SetCtlColors $LocationPath 0xF2EFF8 0x2A2733
  ${NSD_CreateButton} 80% 83u 20% 13u "Browse"
  Pop $LocationBrowse
  ${NSD_OnClick} $LocationBrowse BrowseInstallFolder
  ${NSD_CreateLabel} 0 111u 96% 24u "You can change this location later by reinstalling. Your data stays separately in your private SoFlo library."
  Pop $1
  !insertmacro SoFloText $1 0x918A9B "8" "400"
  nsDialogs::Show
FunctionEnd

Function BrowseInstallFolder
  ${NSD_GetText} $LocationPath $0
  nsDialogs::SelectFolderDialog "Choose where SoFlo is installed" "$0"
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
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\SoFlo"
  ${EndIf}
FunctionEnd

Function InstallProgressShow
  FindWindow $0 "#32770" "" $HWNDPARENT
  SetCtlColors $0 0xF4F1FA 0x1D1B24
  GetDlgItem $1 $0 1006
  SetCtlColors $1 0xC2BDCC 0x1D1B24
  GetDlgItem $1 $0 1027
  ShowWindow $1 ${SW_HIDE}
  GetDlgItem $1 $0 1016
  ShowWindow $1 ${SW_HIDE}
FunctionEnd

Section "Install SoFlo" InstallSection
  ${If} $WorkerMode == 0
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=SoFlo-SetupUI.exe "${APP_EXE}"
    ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "DisplayVersion"
    Exec '"$PLUGINSDIR\SoFlo-SetupUI.exe" --installer --setup-exe="$EXEPATH" --current-version="$0" --target-version="${APP_VERSION}"'
    Quit
  ${EndIf}

  SetOutPath "$INSTDIR"
  Call EnsureWebView2
  DetailPrint "Installing the SoFlo desktop app..."
  SetOverwrite on
  File /oname=SoFlo.exe "${APP_EXE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "${APP_DATA}"
  CreateDirectory "$LOCALAPPDATA\SoFlo\Models"
  FileOpen $0 "${APP_DATA}\installer.model-path" w
  FileWrite $0 "$ModelPath"
  FileClose $0

  WriteRegStr HKCU "${PRODUCT_KEY}" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "${PRODUCT_KEY}" "ModelPath" "$ModelPath"
  WriteRegDWORD HKCU "${PRODUCT_KEY}" "LaunchAtStartup" "$LaunchAtStartup"
  WriteRegDWORD HKCU "${PRODUCT_KEY}" "StartMinimized" "$StartMinimized"
  WriteRegDWORD HKCU "${PRODUCT_KEY}" "DesktopShortcut" "$CreateDesktopShortcut"

  ${If} $LaunchAtStartup == 1
    ${If} $StartMinimized == 1
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SoFlo" '"$INSTDIR\SoFlo.exe" --minimized'
    ${Else}
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SoFlo" '"$INSTDIR\SoFlo.exe"'
    ${EndIf}
  ${Else}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SoFlo"
  ${EndIf}

  ${If} $CreateDesktopShortcut == 1
    CreateShortcut "$DESKTOP\SoFlo.lnk" "$INSTDIR\SoFlo.exe"
  ${Else}
    Delete "$DESKTOP\SoFlo.lnk"
  ${EndIf}
  CreateDirectory "$SMPROGRAMS\SoFlo"
  CreateShortcut "$SMPROGRAMS\SoFlo\SoFlo.lnk" "$INSTDIR\SoFlo.exe"
  CreateShortcut "$SMPROGRAMS\SoFlo\Uninstall SoFlo.lnk" "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "SoFlo"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "SoFlo"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" '"$INSTDIR\SoFlo.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
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
    MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "SoFlo needs Microsoft WebView2. The download could not start. Check your connection and try again." IDRETRY webview_retry IDCANCEL webview_cancel
    Return
    webview_cancel:
      Abort
  ${EndIf}
  DetailPrint "Installing Microsoft WebView2..."
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2Setup.exe" /silent /install' $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Microsoft WebView2 could not be installed. SoFlo cannot open without it."
    Abort
  ${EndIf}
FunctionEnd

Function FinishPage
  !insertmacro MUI_HEADER_TEXT "SoFlo is ready" "Your workspace is installed and ready for its first class."
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}
  !insertmacro SoFloDarkCanvas
  ${NSD_CreateLabel} 0 8u 100% 18u "SOFLO IS READY"
  Pop $1
  !insertmacro SoFloText $1 0xB6AEFF "9" "700"
  ${NSD_CreateLabel} 0 33u 100% 24u "Your study space is installed."
  Pop $1
  !insertmacro SoFloText $1 0xF4F1FA "16" "700"
  ${NSD_CreateCheckbox} 0 126u 100% 13u "Launch SoFlo now"
  Pop $FinishLaunch
  SetCtlColors $FinishLaunch 0xEDEAF4 0x1D1B24
  ${NSD_Check} $FinishLaunch
  nsDialogs::Show
FunctionEnd

Function FinishLeave
  ${NSD_GetState} $FinishLaunch $LaunchNow
  ${If} $LaunchNow == 1
    ${If} $StartMinimized == 1
      Exec '"$INSTDIR\SoFlo.exe" --minimized'
    ${Else}
      Exec '"$INSTDIR\SoFlo.exe"'
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  StrCpy $WorkerMode 0
  StrCpy $UninstallData 0
  ; Never expose NSIS's stock pages. The section below opens SoFlo's own
  ; uninstaller UI unless this is the background worker it launches.
  SetSilent silent
  ${GetParameters} $0
  ${GetOptions} $0 "--perform-silent-uninstall=" $1
  ${If} $1 == "1"
    StrCpy $WorkerMode 1
  ${EndIf}
  ${GetOptions} $0 "--erase-data=" $1
  ${If} $1 == "1"
    StrCpy $UninstallData 1
  ${EndIf}
FunctionEnd

Function un.ConfirmPage
  !insertmacro MUI_HEADER_TEXT "Remove SoFlo" "Your library stays safe unless you choose to erase it."
  nsDialogs::Create 1018
  Pop $0
  ${IfThen} $0 == error ${|} Abort ${|}
  !insertmacro SoFloDarkCanvas
  ${NSD_CreateLabel} 0 7u 100% 18u "UNINSTALL SOFLO"
  Pop $1
  !insertmacro SoFloText $1 0xE88B94 "9" "700"
  ${NSD_CreateLabel} 0 34u 96% 24u "Remove the desktop app."
  Pop $1
  !insertmacro SoFloText $1 0xF4F1FA "16" "700"
  ${NSD_CreateLabel} 0 68u 96% 30u "Your library, settings, and local AI model are preserved by default. Choose the option below only if you want to erase everything stored by SoFlo on this PC."
  Pop $1
  !insertmacro SoFloText $1 0xC2BDCC "10" "400"
  ${NSD_CreateCheckbox} 0 119u 100% 22u "Also permanently delete my local SoFlo library, settings, and AI model"
  Pop $UninstallData
  SetCtlColors $UninstallData 0xEDEAF4 0x1D1B24
  nsDialogs::Show
FunctionEnd

Function un.ConfirmLeave
  ${NSD_GetState} $UninstallData $UninstallData
FunctionEnd

Section "Uninstall"
  ${If} $WorkerMode == 0
    ; The visible uninstaller is the same SoFlo-styled Tauri experience as
    ; setup. NSIS remains the small background worker that removes files.
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=SoFlo-UninstallUI.exe "${APP_EXE}"
    ; Do not wait here: the worker needs this uninstaller process to exit so
    ; Windows can remove uninstall.exe cleanly after the SoFlo UI confirms.
    Exec '"$PLUGINSDIR\SoFlo-UninstallUI.exe" --uninstaller --uninstall-exe="$EXEPATH"'
    Quit
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SoFlo"
  Delete "$DESKTOP\SoFlo.lnk"
  Delete "$SMPROGRAMS\SoFlo\SoFlo.lnk"
  Delete "$SMPROGRAMS\SoFlo\Uninstall SoFlo.lnk"
  RMDir "$SMPROGRAMS\SoFlo"
  Delete "$INSTDIR\SoFlo.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ReadRegStr $0 HKCU "${PRODUCT_KEY}" "ModelPath"
  DeleteRegKey HKCU "${PRODUCT_KEY}"
  ${If} $UninstallData == 1
    RMDir /r "${APP_DATA}"
    ${If} $0 != ""
      ; The installer only removes the specific model location the user chose.
      Delete "$0"
    ${EndIf}
  ${EndIf}
SectionEnd
