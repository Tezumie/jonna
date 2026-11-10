// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started as a remote window's relay (remote/relay.rs, D252): runs a program there, exits
    // with its code. First: it starts for every git call in a remote window.
    if let Some(code) = ide_lib::remote_relay() {
        std::process::exit(code);
    }
    // Started by git or ssh as their sign-in prompt (git/askpass.rs): answer and exit.
    if let Some(code) = ide_lib::askpass_client() {
        std::process::exit(code);
    }
    // Started by an external agent as its stdio MCP server, bridging to the IDE's (D223).
    if let Some(code) = ide_lib::mcp_stdio_proxy() {
        std::process::exit(code);
    }
    // Started to send Ctrl+C to a program's console (lsp/ctrl_c.rs): done.
    if let Some(code) = ide_lib::ctrl_c_helper() {
        std::process::exit(code);
    }
    // `--help` / `--version`: printed, no window.
    if let Some(code) = ide_lib::cli_info() {
        std::process::exit(code);
    }
    // Started as the command line with a running window to hand over to (D209): done.
    if let Some(code) = ide_lib::cli_forward() {
        std::process::exit(code);
    }
    // Started by `npm run dev`: what npm set for its script isn't passed on to projects.
    ide_lib::forget_npm_launcher();
    // Started from another editor's terminal: its variables aren't passed on (D192).
    ide_lib::forget_parent_editor();
    ide_lib::run();
}
