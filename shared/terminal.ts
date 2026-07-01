// Disables every mouse-tracking mode + restores cursor visibility. Ink apps
// (the `claude` CLI TUI) enable these on the shared terminal; on Windows,
// child.kill() is always a hard TerminateProcess (Node has no real signal
// delivery there), so the child never gets a chance to disable them itself.
// Call this as soon as we decide to kill the child — not just on our own
// "exit" — otherwise mouse movement spams raw escape codes into the terminal
// for however long our own async cleanup takes.
export function resetTerminalModes(): void {
  try {
    process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?25h");
  } catch {}
}
