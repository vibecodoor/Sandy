//! One-click PDF export via WebView2's native PrintToPdf (Windows only).
//!
//! Reuses the WebView2 runtime the app already ships on — no bundled PDF engine,
//! no external tool. The frontend renders the note to a hidden `.print-doc`
//! (printExport.ts); this writes that exact layout straight to a `.pdf` the user
//! chose, skipping the system print dialog. If anything here fails the caller
//! falls back to `window.print()`.

use tauri::webview::PlatformWebview;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Environment6, ICoreWebView2_2, ICoreWebView2_7,
};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{Interface, HRESULT, HSTRING, PCWSTR};

/* Paper, in the inches this API speaks. A4, because the app is not American and
 * WebView2's default is 8.5 × 11 — every PDF exported before this was US Letter
 * without anyone choosing it. */
const A4_WIDTH_IN: f64 = 210.0 / 25.4;
const A4_HEIGHT_IN: f64 = 297.0 / 25.4;

/* The same margins print.css declares in `@page`. Deliberately stated twice:
 * Chromium honours CSS `@page` margins when the print settings carry the
 * "default" ones and lets explicit settings win otherwise, and which case
 * PrintToPdf counts as is not something this code can observe. Matching the two
 * makes the question moot — whichever wins, the page is the same, and the CSS
 * declaration still gives `@page`'s margin boxes (the running foot) their area.
 * If one moves, move the other: print.css `@page { margin: 20mm 19mm }`. */
const MARGIN_V_IN: f64 = 20.0 / 25.4;
const MARGIN_H_IN: f64 = 19.0 / 25.4;

/// Drive WebView2 PrintToPdf to `out_path`. Must run on the UI thread (the
/// completion handler is pumped there); the caller invokes it inside
/// `WebviewWindow::with_webview`.
pub fn print_to_pdf(controller: ICoreWebView2Controller, out_path: &str) -> Result<(), String> {
    let core = unsafe { controller.CoreWebView2() }.map_err(|e| format!("CoreWebView2: {e}"))?;
    // PrintToPdf arrived in ICoreWebView2_7 (Runtime 1.0.1054+).
    let core7: ICoreWebView2_7 = core
        .cast()
        .map_err(|_| "This WebView2 runtime is too old for direct PDF export.".to_string())?;
    let path = HSTRING::from(out_path);

    /* Print settings, because the defaults are wrong twice over: WebView2
     * documents `None` as 8.5 × 11 in with `ShouldPrintBackgrounds = FALSE`, so
     * every callout tint, code card, table header and `==highlight==` print.css
     * paints has been dropped on the way to paper — a page that did not match
     * the page it was exported from, which is the whole promise of that file.
     * CreatePrintSettings arrived in the same runtime release as PrintToPdf
     * (1.0.1054), so the cast above is still the only version floor. */
    let settings = unsafe {
        let env: ICoreWebView2Environment6 = core
            .cast::<ICoreWebView2_2>()
            .and_then(|core2| core2.Environment())
            .and_then(|env| env.cast())
            .map_err(|e| format!("WebView2 print settings unavailable: {e}"))?;
        let settings = env
            .CreatePrintSettings()
            .map_err(|e| format!("CreatePrintSettings: {e}"))?;
        settings
            .SetShouldPrintBackgrounds(true)
            .and_then(|_| settings.SetPageWidth(A4_WIDTH_IN))
            .and_then(|_| settings.SetPageHeight(A4_HEIGHT_IN))
            .and_then(|_| settings.SetMarginTop(MARGIN_V_IN))
            .and_then(|_| settings.SetMarginBottom(MARGIN_V_IN))
            .and_then(|_| settings.SetMarginLeft(MARGIN_H_IN))
            .and_then(|_| settings.SetMarginRight(MARGIN_H_IN))
            .map_err(|e| format!("print settings: {e}"))?;
        settings
    };

    PrintToPdfCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            core7.PrintToPdf(PCWSTR::from_raw(path.as_ptr()), &settings, &handler)?;
            Ok(())
        }),
        Box::new(|error, is_successful| {
            error?;
            if is_successful {
                Ok(())
            } else {
                Err(windows::core::Error::from(HRESULT(-1)))
            }
        }),
    )
    .map_err(|e| format!("PrintToPdf failed: {e}"))
}

/// Extract the WebView2 controller from a Tauri `PlatformWebview`.
pub fn controller_of(webview: &PlatformWebview) -> ICoreWebView2Controller {
    webview.controller()
}
