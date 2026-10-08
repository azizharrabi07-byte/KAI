# Type with the REAL keyboard, at the OS level (SendInput + KEYEVENTF_UNICODE).
#
# A renderer-level `Input.insertText` over CDP proves a page's handler works; it says
# nothing about whether a window is really focused and really receiving keystrokes.
# This sends genuine input events, so the window that answers has to be the focused one.
#
#   powershell -File win-type.ps1 -Text "what is happening?" -Enter
#
# All the struct handling is done in C#: PowerShell cannot reliably mutate a field of a
# nested struct (the getter returns a copy), so the events would silently go out zeroed.
param(
    [Parameter(Mandatory = $true)][string]$Text,
    [switch]$Enter
)

Add-Type -Namespace Kai -Name Keys -MemberDefinition @'
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUTK { public uint type; public KEYBDINPUT ki; public uint pad1; public uint pad2; }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUTK[] pInputs, int cbSize);

    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint INPUT_KEYBOARD = 1;

    static INPUTK Key(ushort vk, ushort scan, uint flags) {
        var kb = new KEYBDINPUT();
        kb.wVk = vk; kb.wScan = scan; kb.dwFlags = flags; kb.time = 0; kb.dwExtraInfo = System.IntPtr.Zero;
        var input = new INPUTK();
        input.type = INPUT_KEYBOARD; input.ki = kb; input.pad1 = 0; input.pad2 = 0;
        return input;
    }

    public static string Type(string text, bool enter) {
        var list = new System.Collections.Generic.List<INPUTK>();
        foreach (char c in text) {
            list.Add(Key(0, (ushort)c, KEYEVENTF_UNICODE));
            list.Add(Key(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        if (enter) {
            list.Add(Key(13, 0, 0));                       // VK_RETURN
            list.Add(Key(13, 0, KEYEVENTF_KEYUP));
        }
        var events = list.ToArray();
        int size = Marshal.SizeOf(typeof(INPUTK));
        uint sent = SendInput((uint)events.Length, events, size);
        return "SendInput sent " + sent + " of " + events.Length + " events (cbSize " + size + ", lastError " + Marshal.GetLastWin32Error() + ")";
    }
'@

[Kai.Keys]::Type($Text, [bool]$Enter)
