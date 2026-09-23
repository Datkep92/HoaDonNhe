; ===========================================================================
;  HoaDonNhe - Trình cài đặt (Installed / Portable)  --  file NSIS
;
;  Build bằng makensis với các define (xem tools/build-installer.cjs):
;     -DVERSION -DVI_VERSION -DAPP_EXE -DAPP_BASENAME -DPAYLOAD
;     -DOUT_FILE -DICON -DREPO
;
;  Đặc điểm:
;   * Một file Setup duy nhất, payload HoaDonNhe.exe được NHÚNG bên trong.
;   * Chọn chế độ CÀI ĐẶT (shortcut + gỡ cài đặt) hoặc PORTABLE (chạy trực tiếp).
;   * Không cần quyền Administrator (RequestExecutionLevel user).
;   * Cài vào hồ sơ người dùng -> thư mục dữ liệu du_lieu cạnh EXE ghi được bình thường.
;   * Không tự cài Node.js/Python/Chromium: dùng Chrome/Edge có sẵn trên máy.
;
;  LƯU Ý: file này phải lưu dạng UTF-8 **có BOM** thì makensis mới đọc đúng
;  tiếng Việt (xem .gitattributes / tools/build-installer.cjs).
; ===========================================================================
Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"

; ---- define mặc định (có thể bị ghi đè từ dòng lệnh -D...) ----------------
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef VI_VERSION
  !define VI_VERSION "${VERSION}.0"
!endif
!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "HoaDonNhe"
!endif
!ifndef APP_EXE
  !define APP_EXE "HoaDonNhe.exe"
!endif
!ifndef APP_BASENAME
  !define APP_BASENAME "HoaDonNhe"
!endif
; Gốc project = thư mục cha của thư mục chứa file .nsi này (…/packaging/..).
; Dùng ${__FILEDIR__} để đường dẫn không phụ thuộc thư mục làm việc của makensis.
!define ROOT "${__FILEDIR__}\.."
!ifndef PAYLOAD
  !define PAYLOAD "${ROOT}\release\installer\payload\HoaDonNhe.exe"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "${ROOT}\release\HoaDonNhe-Setup-v${VERSION}.exe"
!endif
!ifndef ICON
  !define ICON "${ROOT}\resources\icon.ico"
!endif
!ifndef REPO
  !define REPO "Datkep92/HoaDonNhe"
!endif

; Mọi đường dẫn tương đối tính từ GỐC project (đã dùng ${ROOT} ở trên).

; ---- thông tin chung -------------------------------------------------------
Name "${PRODUCT_NAME} ${VERSION}"
OutFile "${OUT_FILE}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
ShowInstDetails show
ShowUninstDetails show
BrandingText "${PRODUCT_NAME} ${VERSION}"

VIProductVersion "${VI_VERSION}"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "${PRODUCT_NAME}"
VIAddVersionKey "LegalCopyright" "${PRODUCT_NAME}"

; ---- giao diện MUI2 --------------------------------------------------------
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Cài đặt ${PRODUCT_NAME} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Trình cài đặt sẽ đưa ${PRODUCT_NAME} ${VERSION} lên máy này.$\r$\n$\r$\n$\r$\n$\r$\nỞ bước tiếp theo bạn chọn một trong hai chế độ:$\r$\n$\r$\n   - CÀI ĐẶT VÀO WINDOWS: tạo shortcut Desktop và Start Menu, có mục gỡ cài đặt trong Windows.$\r$\n$\r$\n   - PORTABLE: chỉ giải nén vào thư mục bạn chọn để chạy trực tiếp, không ghi gì vào Windows.$\r$\n$\r$\n$\r$\nChỉ cần 1 file Setup này: ${APP_EXE} được nhúng sẵn bên trong."

!define MUI_DIRECTORYPAGE_TEXT_TOP "Chọn thư mục đặt ${PRODUCT_NAME}. Ở chế độ CÀI ĐẶT, thư mục mặc định nằm trong hồ sơ người dùng nên không cần quyền Administrator."
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Thư mục"

!define MUI_FINISHPAGE_TITLE "Đã xong"
!define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} ${VERSION} đã sẵn sàng.$\r$\n$\r$\nDữ liệu (danh sách MST, phiên đăng nhập, hóa đơn tải về) được lưu trong thư mục 'du_lieu' nằm cạnh ${APP_EXE}."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Chạy ${PRODUCT_NAME} ngay"
!define MUI_FINISHPAGE_LINK "Xem các bản phát hành trên GitHub"
!define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/${REPO}/releases"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT

!insertmacro MUI_PAGE_WELCOME
Page custom ModePage ModePageLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!define MUI_UNCONFIRMPAGE_TEXT_TOP "Gỡ cài đặt ${PRODUCT_NAME} khỏi máy này. Dữ liệu trong thư mục 'du_lieu' sẽ được hỏi trước khi xóa."
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!define MUI_UNFINISHPAGE_NOAUTOCLOSE
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "Vietnamese"

; ---- biến (phải khai báo trước khi dùng trong .onInit) ----------------------
Var Portable
Var UpdateMode
Var RadioInstalled
Var RadioPortable

; ---- khởi tạo: biến shell trỏ về hồ sơ người dùng hiện tại (không cần admin) ----
; Cờ im lặng tuỳ chọn:  Setup.exe /S /PORTABLE /D=<thư mục>
;   -> giải nén thẳng vào <thư mục>, không tạo shortcut/gỡ cài đặt (dùng cho triển khai script).
Function .onInit
  SetShellVarContext current
  ; Lưu ý: ${GetParameters}/${GetOptions} dùng $R0..$R2 làm thanh ghi tạm -> chỉ dùng $0..$9.
  ${GetParameters} $0
  ; Setup.exe /S /PORTABLE /D=<thư mục>  -> giải nén thẳng, không shortcut/gỡ cài đặt
  ClearErrors
  ${GetOptions} $0 "/PORTABLE" $1
  ${IfNot} ${Errors}
    StrCpy $Portable 1
  ${EndIf}
  ; Setup.exe /S /UPDATE  -> auto-update từ trong app: chờ app thoát rồi cài im lặng,
  ; giữ nguyên thư mục cài + dữ liệu, và mở lại app sau khi xong.
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

; ==================== Trang chọn chế độ =====================================
Function ModePage
  !insertmacro MUI_HEADER_TEXT "Chọn chế độ" "Bạn muốn cài vào Windows hay chạy Portable?"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 18u "Chọn cách dùng ${PRODUCT_NAME} trên máy này:"
  Pop $1

  ${NSD_CreateRadioButton} 0 24u 100% 14u "CÀI ĐẶT VÀO WINDOWS  (shortcut Desktop + Start Menu, có mục gỡ cài đặt)"
  Pop $RadioInstalled
  ${NSD_AddStyle} $RadioInstalled ${WS_GROUP}

  ${NSD_CreateRadioButton} 0 46u 100% 14u "PORTABLE  (giải nén để chạy trực tiếp, không ghi vào Windows, không có gỡ cài đặt)"
  Pop $RadioPortable

  ${NSD_CreateLabel} 0 76u 100% 44u "Cả hai chế độ đều KHÔNG cần Node.js/Python/Chromium: ứng dụng dùng Google Chrome hoặc Microsoft Edge có sẵn trên máy (Edge có sẵn trong Windows 10/11).$\r$\nCả hai chế độ đều KHÔNG cần quyền Administrator."
  Pop $2

  ${If} $Portable == 1
    ${NSD_Check} $RadioPortable
  ${Else}
    ${NSD_Check} $RadioInstalled
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function ModePageLeave
  ${NSD_GetState} $RadioInstalled $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Portable 0
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
  ${Else}
    StrCpy $Portable 1
    StrCpy $INSTDIR "$DOCUMENTS\${PRODUCT_NAME}-Portable"
  ${EndIf}
  Call CheckBrowser
FunctionEnd

; ==================== Kiểm tra trình duyệt ==================================
Function CheckBrowser
  ${If} ${FileExists} "$LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES32\Google\Chrome\Application\chrome.exe"
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\Google\Chrome\Application\chrome.exe"
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES32\Microsoft\Edge\Application\msedge.exe"
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\Microsoft\Edge\Application\msedge.exe"
    Return
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONINFORMATION "Không tìm thấy Google Chrome hoặc Microsoft Edge trên máy.$\r$\n$\r$\n${PRODUCT_NAME} cần một trong hai trình duyệt này để mở cổng thuế (Microsoft Edge có sẵn trong Windows 10/11).$\r$\n$\r$\nBấm Có để mở trang tải Google Chrome, hoặc Không để tiếp tục." IDNO browser_done
  ExecShell "open" "https://www.google.com/chrome/"
  browser_done:
FunctionEnd

; ==================== Kiểm tra ứng dụng đang chạy ===========================
Function CheckAppRunning
  ; Chế độ im lặng (/S — dùng cho auto-update): KHÔNG hỏi gì, chờ app thoát tối đa 60 giây
  ; trước khi ghi đè. Không làm vậy thì MessageBox bị bỏ qua trong /S và việc ghi đè file
  ; đang chạy có thể thất bại.
  ${If} ${Silent}
    StrCpy $2 0
    check_wait:
      Sleep 1000
      nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "if (Get-Process -Name ${APP_BASENAME} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"'
      Pop $0
      Pop $1
      ${If} $1 == "0"
        Return
      ${EndIf}
      IntOp $2 $2 + 1
      ${If} $2 < 60
        Goto check_wait
      ${EndIf}
    ; Quá 60 giây vẫn chạy: dừng trước khi ghi gì, không để lại bản cài nửa vời.
    SetErrors
    Abort
  ${EndIf}
  check_loop:
    nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "if (Get-Process -Name ${APP_BASENAME} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"'
    Pop $0
    Pop $1
    ${If} $0 == "1"
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} đang chạy. Hãy đóng ứng dụng rồi bấm Thử lại, hoặc Hủy để dừng cài đặt." IDCANCEL check_cancel
      Goto check_loop
    ${EndIf}
  Return
  check_cancel:
    Abort
FunctionEnd

Function un.CheckAppRunning
  un_check_loop:
    nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "if (Get-Process -Name ${APP_BASENAME} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"'
    Pop $0
    Pop $1
    ${If} $0 == "1"
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} đang chạy. Hãy đóng ứng dụng rồi bấm Thử lại, hoặc Hủy để dừng gỡ cài đặt." IDCANCEL un_check_cancel
      Goto un_check_loop
    ${EndIf}
  Return
  un_check_cancel:
    Abort
FunctionEnd

; ==================== Cài đặt ===============================================
Section "Cài đặt ${PRODUCT_NAME}" SecMain
  SectionIn RO

  ${If} $Portable == 0
    ${If} ${FileExists} "$INSTDIR\${APP_EXE}"
      Call CheckAppRunning
    ${EndIf}
  ${EndIf}

  SetOutPath "$INSTDIR"
  SetOverwrite on
  File "${PAYLOAD}"
  DetailPrint "Đã giải nén ${APP_EXE} vào $INSTDIR"

  ${If} $Portable == 0
    ; Icon dùng cho shortcut + mục gỡ cài đặt (app EXE không tự gán được icon vì rcedit phá pkg).
    File /oname=HoaDonNhe.ico "${ICON}"
    WriteUninstaller "$INSTDIR\Uninstall.exe"

    CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
    CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\HoaDonNhe.ico" 0 SW_SHOWNORMAL "" "${PRODUCT_NAME} - tải hóa đơn điện tử"
    CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}\Gỡ cài đặt ${PRODUCT_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\HoaDonNhe.ico" 0 SW_SHOWNORMAL "" "Gỡ cài đặt ${PRODUCT_NAME}"
    CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\HoaDonNhe.ico" 0 SW_SHOWNORMAL "" "${PRODUCT_NAME} - tải hóa đơn điện tử"

    WriteRegStr HKCU "Software\${PRODUCT_NAME}" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\${PRODUCT_NAME}" "Version" "${VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayName" "${PRODUCT_NAME}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "Publisher" "${PRODUCT_NAME}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "DisplayIcon" "$INSTDIR\HoaDonNhe.ico"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "NoRepair" 1

    ; Auto-update: cài xong thì mở lại app để người dùng thấy bản mới ngay.
    ${If} $UpdateMode == 1
      Exec "$INSTDIR\${APP_EXE}"
    ${EndIf}
  ${Else}
    DetailPrint "Chế độ PORTABLE: chỉ giải nén, không tạo shortcut/gỡ cài đặt."
  ${EndIf}
SectionEnd

; ==================== Gỡ cài đặt ============================================
Section "Uninstall"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\Gỡ cài đặt ${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"

  Call un.CheckAppRunning

  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\HoaDonNhe.ico"
  Delete "$INSTDIR\Uninstall.exe"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
  DeleteRegKey HKCU "Software\${PRODUCT_NAME}"

  MessageBox MB_YESNO|MB_ICONQUESTION "Xóa luôn dữ liệu người dùng trong thư mục 'du_lieu' (danh sách MST, phiên đăng nhập đã lưu, hóa đơn đã tải)?$\r$\n$\r$\nChọn Không để giữ lại dữ liệu." IDNO keep_data
    RMDir /r "$INSTDIR\du_lieu"
  keep_data:

  RMDir "$INSTDIR"
SectionEnd
