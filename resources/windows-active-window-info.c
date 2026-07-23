/**
 * windows-active-window-info.exe
 *
 * One-shot (not a long-running listener) helper for the active-window
 * screen-context feature — see docs/specs/active-window-screen-context.md's
 * "Capture: identifying and grabbing the focused window (Windows only)"
 * Design section.
 *
 * Protocol: writes a single-line JSON metadata header to stdout, followed by
 * a newline, followed by raw PNG bytes (binary-safe framing, since the
 * payload is image data rather than the line-delimited JSON event stream
 * windows-key-listener.exe/windows-system-audio-helper.exe use).
 *
 * Header shape: { "processName": string|null, "windowTitle": string|null,
 *                 "hasEligibleWindow": boolean }
 *
 * Self-exclusion: if the foreground window belongs to EktosWhispr's own
 * process tree (matched by comparing the foreground window's owning PID's
 * parent chain against this process's own parent chain / executable name),
 * the helper reports { hasEligibleWindow: false } and writes no PNG bytes —
 * mirroring windows-system-audio-helper.exe's existing self-exclusion of the
 * app's own process tree from system-audio capture.
 *
 * NOTE: this source targets MinGW-w64/MSVC on Windows and requires a Windows
 * build environment to compile (see .github/workflows/build-windows-active-
 * window-info.yml). It is written to the spec's protocol contract, and uses
 * GDI+'s "flat" C API (GdipXxx functions) rather than the C++ Gdiplus::
 * wrapper classes, since this is a plain C translation unit (.c), not C++.
 * Requirement 7's failure mode (missing/erroring binary -> capture
 * gracefully resolves to null) means the JS layer (activeWindowCapture.js)
 * degrades safely if this binary is ever missing or broken.
 */

#define COBJMACROS
#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <io.h>
#include <fcntl.h>

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")

static int GetCLSIDForPngEncoder(CLSID *pClsid) {
  UINT num = 0, size = 0;
  GdipGetImageEncodersSize(&num, &size);
  if (size == 0) return -1;
  ImageCodecInfo *info = (ImageCodecInfo *)malloc(size);
  if (!info) return -1;
  GdipGetImageEncoders(num, size, info);
  for (UINT i = 0; i < num; i++) {
    if (wcscmp(info[i].MimeType, L"image/png") == 0) {
      *pClsid = info[i].Clsid;
      free(info);
      return 0;
    }
  }
  free(info);
  return -1;
}

// Walks up the process tree from `pid`, returning true if any ancestor's
// executable name matches this process's own executable name (case-
// insensitive) — the same self-exclusion principle already implemented by
// windows-system-audio-helper.c.
static BOOL IsOwnProcessTree(DWORD targetPid) {
  char selfPath[MAX_PATH];
  GetModuleFileNameA(NULL, selfPath, MAX_PATH);
  char *selfName = strrchr(selfPath, '\\');
  selfName = selfName ? selfName + 1 : selfPath;

  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return FALSE;

  PROCESSENTRY32 entry;
  entry.dwSize = sizeof(PROCESSENTRY32);

  DWORD currentPid = targetPid;
  BOOL matched = FALSE;
  for (int depth = 0; depth < 10 && currentPid != 0; depth++) {
    BOOL found = FALSE;
    if (Process32First(snap, &entry)) {
      do {
        if (entry.th32ProcessID == currentPid) {
          found = TRUE;
          if (_stricmp(entry.szExeFile, selfName) == 0) {
            matched = TRUE;
          }
          currentPid = entry.th32ParentProcessID;
          break;
        }
      } while (Process32Next(snap, &entry));
    }
    if (!found || matched) break;
  }
  CloseHandle(snap);
  return matched;
}

static void WriteJsonHeader(const char *processName, BOOL hasEligibleWindow) {
  fprintf(stdout, "{\"processName\":%s%s%s,\"hasEligibleWindow\":%s}\n",
          processName ? "\"" : "", processName ? processName : "null",
          processName ? "\"" : "", hasEligibleWindow ? "true" : "false");
  fflush(stdout);
}

int main() {
  _setmode(_fileno(stdout), _O_BINARY);

  HWND fg = GetForegroundWindow();
  if (!fg) {
    WriteJsonHeader(NULL, FALSE);
    return 0;
  }

  DWORD pid = 0;
  GetWindowThreadProcessId(fg, &pid);

  if (IsOwnProcessTree(pid)) {
    WriteJsonHeader(NULL, FALSE);
    return 0;
  }

  char processName[MAX_PATH] = {0};
  HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (hProcess) {
    char fullPath[MAX_PATH];
    DWORD size = MAX_PATH;
    if (QueryFullProcessImageNameA(hProcess, 0, fullPath, &size)) {
      char *base = strrchr(fullPath, '\\');
      strncpy(processName, base ? base + 1 : fullPath, MAX_PATH - 1);
    }
    CloseHandle(hProcess);
  }

  RECT rect;
  if (!GetWindowRect(fg, &rect)) {
    WriteJsonHeader(processName[0] ? processName : NULL, FALSE);
    return 0;
  }
  int width = rect.right - rect.left;
  int height = rect.bottom - rect.top;
  if (width <= 0 || height <= 0) {
    WriteJsonHeader(processName[0] ? processName : NULL, FALSE);
    return 0;
  }

  ULONG_PTR gdiplusToken;
  GdiplusStartupInput gdiplusStartupInput;
  gdiplusStartupInput.GdiplusVersion = 1;
  gdiplusStartupInput.DebugEventCallback = NULL;
  gdiplusStartupInput.SuppressBackgroundThread = FALSE;
  gdiplusStartupInput.SuppressExternalCodecs = FALSE;
  GdiplusStartup(&gdiplusToken, &gdiplusStartupInput, NULL);

  HDC hdcScreen = GetDC(NULL);
  HDC hdcMem = CreateCompatibleDC(hdcScreen);
  HBITMAP hBitmap = CreateCompatibleBitmap(hdcScreen, width, height);
  HBITMAP hOldBitmap = (HBITMAP)SelectObject(hdcMem, hBitmap);

  // Try PrintWindow with PW_RENDERFULLCONTENT first (best for modern/GPU-
  // composited apps per the Design section's noted Open Question); fall back
  // to BitBlt from the screen DC if it reports failure.
  BOOL captured = PrintWindow(fg, hdcMem, 2 /* PW_RENDERFULLCONTENT */);
  if (!captured) {
    captured = BitBlt(hdcMem, 0, 0, width, height, hdcScreen, rect.left, rect.top, SRCCOPY);
  }

  SelectObject(hdcMem, hOldBitmap);

  if (!captured) {
    DeleteObject(hBitmap);
    DeleteDC(hdcMem);
    ReleaseDC(NULL, hdcScreen);
    GdiplusShutdown(gdiplusToken);
    WriteJsonHeader(processName[0] ? processName : NULL, FALSE);
    return 0;
  }

  WriteJsonHeader(processName[0] ? processName : NULL, TRUE);

  {
    GpBitmap *bitmap = NULL;
    if (GdipCreateBitmapFromHBITMAP(hBitmap, NULL, &bitmap) == Ok && bitmap) {
      CLSID pngClsid;
      if (GetCLSIDForPngEncoder(&pngClsid) == 0) {
        IStream *stream = NULL;
        if (CreateStreamOnHGlobal(NULL, TRUE, &stream) == S_OK && stream) {
          if (GdipSaveImageToStream(bitmap, stream, &pngClsid, NULL) == Ok) {
            HGLOBAL hMem = NULL;
            if (GetHGlobalFromStream(stream, &hMem) == S_OK && hMem) {
              SIZE_T size = GlobalSize(hMem);
              void *data = GlobalLock(hMem);
              if (data && size > 0) {
                fwrite(data, 1, size, stdout);
                fflush(stdout);
              }
              GlobalUnlock(hMem);
            }
          }
          IStream_Release(stream);
        }
      }
      GdipDisposeImage(bitmap);
    }
  }

  DeleteObject(hBitmap);
  DeleteDC(hdcMem);
  ReleaseDC(NULL, hdcScreen);
  GdiplusShutdown(gdiplusToken);

  return 0;
}
