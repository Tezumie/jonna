//! What Windows really lets a normal (not elevated) user do for the command sandbox (D348, D349).
//! These run the real APIs: the decisions rest on their results, not on documentation.

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::NetworkManagement::WindowsFilteringPlatform::{
    FwpmEngineClose0, FwpmEngineOpen0, FwpmFilterAdd0, FWPM_ACTION0, FWPM_CONDITION_IP_REMOTE_PORT,
    FWPM_DISPLAY_DATA0, FWPM_FILTER0, FWPM_FILTER_CONDITION0, FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    FWPM_SESSION0, FWPM_SESSION_FLAG_DYNAMIC, FWP_ACTION_BLOCK, FWP_CONDITION_VALUE0,
    FWP_CONDITION_VALUE0_0, FWP_MATCH_EQUAL, FWP_UINT16,
};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

fn elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut e = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some((&mut e as *mut TOKEN_ELEVATION).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && e.TokenIsElevated != 0
    }
}

/// D348: a dynamic WFP session (filters that vanish with the session, the least a firewall
/// change can be) still needs an administrator to add a filter. The filter tried blocks
/// connections to port 1 only, so even an elevated run changes nothing that matters.
#[test]
fn a_normal_user_cant_add_a_wfp_filter_even_in_a_dynamic_session() {
    const RPC_C_AUTHN_DEFAULT: u32 = 0xFFFF_FFFF;
    const ERROR_ACCESS_DENIED: u32 = 5;
    unsafe {
        let session = FWPM_SESSION0 {
            flags: FWPM_SESSION_FLAG_DYNAMIC,
            ..Default::default()
        };
        let mut engine = HANDLE::default();
        let open = FwpmEngineOpen0(
            PCWSTR::null(),
            RPC_C_AUTHN_DEFAULT,
            None,
            Some(&session),
            &mut engine,
        );
        eprintln!("FwpmEngineOpen0 (dynamic session): {open:#x}");
        if open != 0 {
            assert!(
                !elevated(),
                "an elevated run couldn't open the engine: {open:#x}"
            );
            return;
        }
        let mut condition = FWPM_FILTER_CONDITION0 {
            fieldKey: FWPM_CONDITION_IP_REMOTE_PORT,
            matchType: FWP_MATCH_EQUAL,
            conditionValue: FWP_CONDITION_VALUE0 {
                r#type: FWP_UINT16,
                Anonymous: FWP_CONDITION_VALUE0_0 { uint16: 1 },
            },
        };
        let mut name: Vec<u16> = "sandbox probe".encode_utf16().chain([0]).collect();
        let filter = FWPM_FILTER0 {
            displayData: FWPM_DISPLAY_DATA0 {
                name: PWSTR(name.as_mut_ptr()),
                description: PWSTR::null(),
            },
            layerKey: FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            numFilterConditions: 1,
            filterCondition: &mut condition,
            action: FWPM_ACTION0 {
                r#type: FWP_ACTION_BLOCK,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut id = 0u64;
        let add = FwpmFilterAdd0(engine, &filter, None, Some(&mut id));
        eprintln!(
            "FwpmFilterAdd0 (dynamic session, elevated: {}): {add:#x}",
            elevated()
        );
        // Closing a dynamic session removes its filters.
        FwpmEngineClose0(engine);
        if !elevated() {
            assert_eq!(add, ERROR_ACCESS_DENIED, "a normal user added a WFP filter");
        }
    }
}

fn run_in(
    sandbox: &super::sandbox::Sandbox,
    cwd: &std::path::Path,
    script: &str,
) -> (super::ExecResult, String) {
    let service = super::ExecService::default();
    let out = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let sink = out.clone();
    let r = service.run_sandboxed(
        "t-read",
        script,
        cwd,
        std::time::Duration::from_secs(60),
        sandbox,
        move |c| {
            if let Ok(mut o) = sink.lock() {
                o.push_str(&c);
            }
        },
    );
    let text = out.lock().map(|o| o.clone()).unwrap_or_default();
    match r {
        Ok(r) => (r, text),
        Err(e) => panic!("run failed: {e} {text}"),
    }
}

/// D349, the real thing: a hidden folder and file can't be read by the sandboxed command (nor
/// by what it starts), the user's own programs still read them, and unhiding puts it all back.
#[test]
fn a_sandboxed_command_cant_read_hidden_secrets_and_unhiding_restores_them() {
    use super::sandbox::Sandbox;
    use super::sandbox_read::windows_hide::{is_hidden, unhide_all};
    use super::sandbox_read::ReadLimits;

    let base = std::env::temp_dir().join(format!("ide-sandbox-read-{}", std::process::id()));
    let work = base.join("work");
    let secret = base.join("secret");
    let data = base.join("data");
    for d in [&work, &secret, &data] {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(work.join("open.txt"), "open-value");
    let _ = std::fs::write(secret.join("key.txt"), "secret-in-folder");
    let _ = std::fs::write(base.join(".env.local"), "secret-in-file");
    // Inside the writable (low-labelled) folder: the explicit label comes first.
    let _ = std::fs::write(work.join("private.key"), "secret-in-work");
    let sandbox = Sandbox {
        writable: vec![work.clone()],
        app_name: "ide-sandbox-test".into(),
        deny_read: ReadLimits {
            paths: vec![
                secret.clone(),
                base.join(".env.local"),
                work.join("private.key"),
            ],
            env_pattern: false,
        },
        data_dir: Some(data.clone()),
        ..Default::default()
    };
    let script = format!(
        "Get-Content '{}'; Get-Content '{}'; Get-Content '{}'; Get-Content '{}'; cmd /c 'type {}'",
        work.join("open.txt").display(),
        work.join("private.key").display(),
        secret.join("key.txt").display(),
        base.join(".env.local").display(),
        secret.join("key.txt").display(),
    );
    let (r, text) = run_in(&sandbox, &work, &script);
    assert!(r.sandbox_notes.is_empty(), "{:?}", r.sandbox_notes);
    assert!(text.contains("open-value"), "{text}");
    assert!(
        !text.contains("secret-in-folder"),
        "read a hidden folder: {text}"
    );
    assert!(
        !text.contains("secret-in-file"),
        "read a hidden file: {text}"
    );
    assert!(
        !text.contains("secret-in-work"),
        "read a hidden file in the folder: {text}"
    );
    assert!(is_hidden(&secret) && is_hidden(&base.join(".env.local")));
    // The user's own (medium) programs read them as before.
    assert_eq!(
        std::fs::read_to_string(secret.join("key.txt")).unwrap_or_default(),
        "secret-in-folder"
    );
    // A file made in the hidden folder afterwards is hidden too (inherited).
    let _ = std::fs::write(secret.join("later.txt"), "secret-later");
    let later = format!("Get-Content '{}'", secret.join("later.txt").display());
    let (_, text) = run_in(&sandbox, &work, &later);
    assert!(!text.contains("secret-later"), "{text}");

    // Unhidden: the labels from before come back and the command reads them again.
    let done = unhide_all(&data).unwrap_or_default();
    assert_eq!(done.len(), 3, "{done:?}");
    assert!(!is_hidden(&secret) && !is_hidden(&base.join(".env.local")));
    let open = Sandbox {
        deny_read: ReadLimits::default(),
        ..sandbox.clone()
    };
    let (_, text) = run_in(&open, &work, &script);
    assert!(
        text.contains("secret-in-folder") && text.contains("secret-in-file"),
        "{text}"
    );
    assert!(text.contains("secret-in-work"), "{text}");
    let (_, text) = run_in(&open, &work, &later);
    assert!(text.contains("secret-later"), "{text}");
    let _ = std::fs::remove_dir_all(&base);
}

/// D348: a sandboxed tool that honors the proxy variables (curl) is refused a host that isn't
/// allowed, and the host is recorded; no connection leaves the machine.
#[test]
fn a_sandboxed_curl_goes_through_the_filter() {
    use super::sandbox::Sandbox;
    let base = std::env::temp_dir().join(format!("ide-sandbox-net-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&base);
    let sandbox = Sandbox {
        writable: vec![base.clone()],
        app_name: "ide-sandbox-test".into(),
        allow_hosts: vec!["allowed.invalid".into()],
        ..Default::default()
    };
    let curl = std::env::var("SystemRoot")
        .map(|r| std::path::Path::new(&r).join("System32").join("curl.exe"))
        .unwrap_or_default();
    if !curl.is_file() {
        eprintln!("no curl.exe here: skipped");
        return;
    }
    let script = format!("& '{}' -sS https://example.com/", curl.display());
    let (r, text) = run_in(&sandbox, &base, &script);
    assert_eq!(r.blocked_hosts, vec!["example.com"], "{text}");
    assert_ne!(r.exit_code, Some(0), "{text}");
    let _ = std::fs::remove_dir_all(&base);
}
