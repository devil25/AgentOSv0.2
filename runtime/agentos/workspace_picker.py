"""Native Windows folder picker used to choose the AgentOS workspace.

The host is launched on demand by Firefox. Initialize COM as an STA and use
Firefox's foreground window as the dialog owner so the picker is visible and
modal instead of appearing behind the browser.
"""
import ctypes
from ctypes import wintypes


class BROWSEINFO(ctypes.Structure):
    _fields_ = [
        ("hwndOwner", wintypes.HWND),
        ("pidlRoot", ctypes.c_void_p),
        ("pszDisplayName", wintypes.LPWSTR),
        ("lpszTitle", wintypes.LPCWSTR),
        ("ulFlags", wintypes.UINT),
        ("lpfn", ctypes.c_void_p),
        ("lParam", wintypes.LPARAM),
        ("iImage", ctypes.c_int),
    ]


def choose_directory(title="Choose AgentOS workspace"):
    if not hasattr(ctypes, "windll"):
        raise OSError("The native folder picker is available only on Windows.")

    ole32 = ctypes.windll.ole32
    shell32 = ctypes.windll.shell32
    user32 = ctypes.windll.user32

    # SHBrowseForFolder's new-style dialog requires COM to be initialized.
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole32.CoInitializeEx.restype = ctypes.c_long
    ole32.CoUninitialize.argtypes = []
    ole32.CoUninitialize.restype = None
    hr = ole32.CoInitializeEx(None, 0x2)  # COINIT_APARTMENTTHREADED
    if hr < 0:
        raise OSError(f"Could not initialize Windows dialog services (HRESULT 0x{hr & 0xffffffff:08X}).")

    item = None
    try:
        display_name = ctypes.create_unicode_buffer(32768)
        info = BROWSEINFO()
        user32.GetForegroundWindow.restype = wintypes.HWND
        info.hwndOwner = user32.GetForegroundWindow()
        info.pidlRoot = None
        info.pszDisplayName = ctypes.cast(display_name, wintypes.LPWSTR)
        info.lpszTitle = title
        # Filesystem folders + modern dialog + editable location field.
        info.ulFlags = 0x0001 | 0x0040 | 0x0010
        info.lpfn = None
        info.lParam = 0
        info.iImage = 0

        shell32.SHBrowseForFolderW.argtypes = [ctypes.POINTER(BROWSEINFO)]
        shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
        shell32.SHGetPathFromIDListW.argtypes = [ctypes.c_void_p, wintypes.LPWSTR]
        shell32.SHGetPathFromIDListW.restype = wintypes.BOOL
        ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        ole32.CoTaskMemFree.restype = None

        item = shell32.SHBrowseForFolderW(ctypes.byref(info))
        if not item:
            return None

        path = ctypes.create_unicode_buffer(32768)
        if not shell32.SHGetPathFromIDListW(item, path):
            raise OSError("Windows could not resolve the selected folder.")
        return path.value or None
    finally:
        if item:
            ole32.CoTaskMemFree(ctypes.c_void_p(item))
        ole32.CoUninitialize()
