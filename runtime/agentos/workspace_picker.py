"""Native Windows folder picker used to choose the AgentOS workspace."""
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
    display_name = ctypes.create_unicode_buffer(32768)
    info = BROWSEINFO()
    info.hwndOwner = None
    info.pidlRoot = None
    info.pszDisplayName = ctypes.cast(display_name, wintypes.LPWSTR)
    info.lpszTitle = title
    info.ulFlags = 0x0001 | 0x0040 | 0x0010  # filesystem folders, new dialog, editable path
    info.lpfn = None
    info.lParam = 0
    info.iImage = 0

    shell32 = ctypes.windll.shell32
    ole32 = ctypes.windll.ole32
    shell32.SHBrowseForFolderW.restype = ctypes.c_void_p
    shell32.SHBrowseForFolderW.argtypes = [ctypes.POINTER(BROWSEINFO)]
    shell32.SHGetPathFromIDListW.argtypes = [ctypes.c_void_p, wintypes.LPWSTR]
    shell32.SHGetPathFromIDListW.restype = wintypes.BOOL

    item = shell32.SHBrowseForFolderW(ctypes.byref(info))
    if not item:
        return None
    try:
        path = ctypes.create_unicode_buffer(32768)
        if not shell32.SHGetPathFromIDListW(item, path):
            raise OSError("Windows could not resolve the selected folder.")
        return path.value or None
    finally:
        ole32.CoTaskMemFree(ctypes.c_void_p(item))
