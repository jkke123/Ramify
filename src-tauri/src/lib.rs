// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use tiny_http::{Response, Server};

use std::sync::{
    Arc,
    Mutex,
};

use serde::Serialize;
use sysinfo::{
    Pid,
    ProcessRefreshKind,
    ProcessesToUpdate,
    System,
};

#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL,
};

#[cfg(target_os = "windows")]
use windows_core::Interface;

#[cfg(target_os = "windows")]
use windows::{
    core::PCWSTR,
    Win32::{
        Media::Audio::{
            eMultimedia,
            eRender,
            IAudioSessionControl2,
            IMMDeviceEnumerator,
            MMDeviceEnumerator,
        },
        System::Com::{
            CoCreateInstance,
            CoInitializeEx,
            CLSCTX_ALL,
            COINIT_MULTITHREADED,
        },
    },
};

#[tauri::command]
async fn wait_for_spotify_callback() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let server = Server::http("127.0.0.1:8888")
            .map_err(|e| e.to_string())?;

        let request = server
            .recv()
            .map_err(|e| e.to_string())?;

        let url = request.url().to_string();

        let response = Response::from_string(
            "Spotify connected successfully. You can close this window."
        );

        request
            .respond(response)
            .map_err(|e| e.to_string())?;

        let query = url
            .split('?')
            .nth(1)
            .ok_or("Missing query string")?;

        let params = url::form_urlencoded::parse(query.as_bytes());

        for (key, value) in params {
            if key == "code" {
                return Ok(value.into_owned());
            }
        }

        Err("Spotify authorization code not found".into())
    })
    .await
    .map_err(|e| e.to_string())?
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-gpu",
    );
    tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())

    .manage(ResourceMonitor {
    system: Mutex::new(System::new()),

    #[cfg(target_os = "windows")]
    webview_browser_pid: Arc::new(Mutex::new(None)),
})

    .invoke_handler(tauri::generate_handler![
        wait_for_spotify_callback,
        get_resource_usage,
        register_webview_process,
        set_webview_memory_mode,
        rename_audio_session
    ])

    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[derive(Serialize)]
struct ResourceUsage {
    memory_mb: f64,
    cpu_percent: f32,

    // Optional extra information
    core_memory_mb: f64,
    child_memory_mb: f64,
    process_count: usize,
}

fn is_descendant_of(
    system: &System,
    pid: Pid,
    ancestor_pid: Pid,
) -> bool {
    let mut current_pid = pid;

    /*
     * Protect against malformed/cyclic
     * process trees.
     */
    for _ in 0..32 {
        let process =
            match system.process(current_pid) {
                Some(process) => process,
                None => return false,
            };

        let parent_pid =
            match process.parent() {
                Some(parent) => parent,
                None => return false,
            };

        if parent_pid == ancestor_pid {
            return true;
        }

        if parent_pid == current_pid {
            return false;
        }

        current_pid = parent_pid;
    }

    false
}

#[tauri::command]
fn register_webview_process(
    window: tauri::WebviewWindow,
    monitor: tauri::State<ResourceMonitor>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        /*
         * Clone the Arc, not the Mutex itself.
         *
         * This gives the WebView callback its own
         * reference-counted handle to the PID storage.
         */
        let stored_pid =
            Arc::clone(&monitor.webview_browser_pid);

        window
            .with_webview(move |webview| {
                unsafe {
                    let controller =
                        webview.controller();

                    let core_webview =
                        match controller.CoreWebView2() {
                            Ok(webview) => webview,

                            Err(error) => {
                                eprintln!(
                                    "Could not get CoreWebView2 for process tracking: {error}"
                                );

                                return;
                            }
                        };

                    /*
                     * Depending on the webview2-com version,
                     * BrowserProcessId() returns the PID directly.
                     */
                    let mut browser_pid: u32 = 0;

                        match core_webview.BrowserProcessId(
                            &mut browser_pid as *mut u32,
                        ) {
                            Ok(()) => {
                                if browser_pid == 0 {
                                    eprintln!(
                                        "WebView2 returned browser PID 0"
                                    );

                                    return;
                                }

                                match stored_pid.lock() {
                                    Ok(mut pid) => {
                                        *pid = Some(browser_pid);

                                        println!(
                                            "Registered WebView2 browser PID: {}",
                                            browser_pid
                                        );
                                    }

                                    Err(_) => {
                                        eprintln!(
                                            "Could not lock WebView2 PID storage"
                                        );
                                    }
                                }
                            }

                            Err(error) => {
                                eprintln!(
                                    "Could not get WebView2 browser PID: {error}"
                                );
                            }
}
                }
            })
            .map_err(|error| error.to_string())?;

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        let _ = monitor;

        Ok(())
    }
}

#[tauri::command]
fn set_webview_memory_mode(
    window: tauri::WebviewWindow,
    low: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        window
            .with_webview(move |webview| {
                unsafe {
                    // Get the WebView2 controller from Tauri.
                    let controller = webview.controller();

                    // Get the actual CoreWebView2 instance.
                    let core_webview = match controller.CoreWebView2() {
                        Ok(webview) => webview,

                        Err(error) => {
                            eprintln!(
                                "Could not get CoreWebView2: {error}"
                            );
                            return;
                        }
                    };

                    // MemoryUsageTargetLevel was added on
                    // ICoreWebView2_19, so cast to that interface.
                    let webview19: ICoreWebView2_19 =
                        match core_webview.cast() {
                            Ok(webview) => webview,

                            Err(error) => {
                                eprintln!(
                                    "ICoreWebView2_19 is unavailable: {error}"
                                );
                                return;
                            }
                        };

                    let level = if low {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(1)
                    } else {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(0)
                    };

                    match webview19
                        .SetMemoryUsageTargetLevel(level)
                    {
                        Ok(()) => {
                            println!(
                                "WebView memory mode: {}",
                                if low {
                                    "LOW"
                                } else {
                                    "NORMAL"
                                }
                            );
                        }

                        Err(error) => {
                            eprintln!(
                                "Could not set WebView memory mode: {error}"
                            );
                        }
                    }
                }
            })
            .map_err(|error| error.to_string())?;

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        let _ = low;

        Err(
            "WebView memory mode is only available on Windows"
                .to_string(),
        )
    }
}

#[tauri::command]
fn get_resource_usage(
    monitor: tauri::State<ResourceMonitor>,
) -> Result<ResourceUsage, String> {
    let betterfy_pid =
        Pid::from_u32(std::process::id());

    let mut system = monitor
        .system
        .lock()
        .map_err(|_| "Could not lock resource monitor")?;

    /*
     * Refresh every process because WebView2 uses
     * multiple browser/renderer/utility processes.
     */
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_cpu(),
    );

    let betterfy_process = system
        .process(betterfy_pid)
        .ok_or("Could not find Betterfy process")?;

    let core_memory =
        betterfy_process.memory();

    let mut child_memory: u64 = 0;

    let mut total_cpu =
        betterfy_process.cpu_usage();

    let mut process_count: usize = 1;

    /*
     * Get the WebView2 browser process PID that was
     * captured directly from CoreWebView2.
     */
    #[cfg(target_os = "windows")]
    let webview_browser_pid = {
        let stored = monitor
            .webview_browser_pid
            .lock()
            .map_err(|_| "Could not lock WebView2 PID")?;

        stored.map(Pid::from_u32)
    };

    #[cfg(not(target_os = "windows"))]
    let webview_browser_pid: Option<Pid> = None;

    for (pid, process) in system.processes() {
        if *pid == betterfy_pid {
            continue;
        }

        /*
         * Normal native descendants of Betterfy.
         */
        let is_betterfy_child =
            is_descendant_of(
                &system,
                *pid,
                betterfy_pid,
            );

        /*
         * WebView2 consists of a browser process plus
         * renderer/GPU/network/audio/utility children.
         *
         * Count:
         *  - the browser process itself
         *  - any descendants of that browser process
         */
        let is_webview_process =
            if let Some(browser_pid) = webview_browser_pid {
                *pid == browser_pid
                    || is_descendant_of(
                        &system,
                        *pid,
                        browser_pid,
                    )
            } else {
                false
            };

        if is_betterfy_child || is_webview_process {
            let memory = process.memory();

            child_memory += memory;

            total_cpu += process.cpu_usage();

            process_count += 1;
        }
    }

    let total_memory =
        core_memory + child_memory;

    Ok(ResourceUsage {
        memory_mb:
            total_memory as f64
                / 1024.0
                / 1024.0,

        cpu_percent:
            total_cpu,

        core_memory_mb:
            core_memory as f64
                / 1024.0
                / 1024.0,

        child_memory_mb:
            child_memory as f64
                / 1024.0
                / 1024.0,

        process_count,
    })
}

#[tauri::command]
fn rename_audio_session() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let _ = CoInitializeEx(
            None,
            COINIT_MULTITHREADED,
        );

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(
                &MMDeviceEnumerator,
                None,
                CLSCTX_ALL,
            )
            .map_err(|e| e.to_string())?;

        let device = enumerator
            .GetDefaultAudioEndpoint(
                eRender,
                eMultimedia,
            )
            .map_err(|e| e.to_string())?;

        let manager = device
            .Activate::<
                windows::Win32::Media::Audio::
                    IAudioSessionManager2,
            >(
                CLSCTX_ALL,
                None,
            )
            .map_err(|e| e.to_string())?;

        let session_enumerator = manager
            .GetSessionEnumerator()
            .map_err(|e| e.to_string())?;

        let count = session_enumerator
            .GetCount()
            .map_err(|e| e.to_string())?;

        let betterfy_pid =
            std::process::id();

        let system =
            sysinfo::System::new_all();

        for index in 0..count {
            let session =
                session_enumerator
                    .GetSession(index)
                    .map_err(|e| e.to_string())?;

            let session2:
                IAudioSessionControl2 =
                session
                    .cast()
                    .map_err(|e| e.to_string())?;

            let pid =
                session2
                    .GetProcessId()
                    .map_err(|e| e.to_string())?;

            let pid =
                sysinfo::Pid::from_u32(pid);

            /*
             * Rename the session if it belongs
             * either directly to Betterfy or to
             * one of Betterfy's descendants.
             */
            if pid.as_u32() == betterfy_pid
                || is_descendant_of(
                    &system,
                    pid,
                    sysinfo::Pid::from_u32(
                        betterfy_pid,
                    ),
                )
            {
                let name: Vec<u16> =
                    "Ramify"
                        .encode_utf16()
                        .chain(Some(0))
                        .collect();

                session
                    .SetDisplayName(
                        PCWSTR(name.as_ptr()),
                        std::ptr::null(),
                    )
                    .map_err(|e| e.to_string())?;
                
                let exe_path =
                    std::env::current_exe()
                        .map_err(|e| e.to_string())?;

                let exe_path_string =
                    exe_path
                        .to_string_lossy()
                        .to_string();

                let icon_path: Vec<u16> =
                    exe_path_string
                        .encode_utf16()
                        .chain(Some(0))
                        .collect();

                session
                    .SetIconPath(
                        PCWSTR(icon_path.as_ptr()),
                        std::ptr::null(),
                    )
                    .map_err(|e| e.to_string())?;

                println!(
                    "Renamed audio session PID {} to Betterfy",
                    pid.as_u32(),
                );
            }
        }

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(
            "Audio-session renaming is Windows-only"
                .to_string(),
        )
    }
}

struct ResourceMonitor {
    system: Mutex<System>,

    #[cfg(target_os = "windows")]
    webview_browser_pid: Arc<Mutex<Option<u32>>>,
}


