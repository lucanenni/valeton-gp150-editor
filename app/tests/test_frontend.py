"""Frontend serving smoke tests (T3).

Doesn't drive the UI (that's the headless e2e in T5) — just confirms the
page and its static assets are actually wired up and reachable, and that
the key DOM hooks a click-through test would need are present.
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_index_serves_html_with_key_hooks():
    resp = client.get("/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    html = resp.text
    for hook in (
        'id="prst-drop"',
        'id="prst-target"',
        'id="prst-convert-btn"',
    ):
        assert hook in html, f"missing hook: {hook}"


def test_convert_page_shows_preset_tool_and_nam_download_link():
    """CONV-2 (2026-09-23): the page hosts the GP-5<->GP-50 preset converter;
    the NAM A2->A1 distiller is NOT embedded here (this fork is GP-150-
    focused, and GP-150 accepts NAM A2 captures directly) — it's always just
    a link to the standalone converter tool, on every build, no more
    static-vs-backend distinction. app.js (the local in-browser trainer) was
    deleted along with the UI it drove."""
    html = client.get("/").text
    for hook in (
        'id="prst-drop"',
        'id="prst-target"',
        'id="prst-convert-btn"',
        "convert_prst.js",
    ):
        assert hook in html, f"missing preset-convert hook: {hook}"
    assert "Preset Converter" in html
    # NAM A2->A1: link-out only, no local trainer UI or app.js anywhere
    assert 'id="nam-converter"' not in html
    assert "app.js" not in html
    assert 'id="nam-download"' in html
    assert "nam-a2a1-converter/releases" in html


def test_static_style_css_served():
    resp = client.get("/static/style.css")
    assert resp.status_code == 200
    assert "text/css" in resp.headers["content-type"]


def test_gp150_page_redirects_to_explorer():
    """GP150-8 (2026-09-20): GP-150 no longer has its own page. The user
    correctly pointed out that a different write mechanism doesn't justify a
    separate tab — GP-5/GP-50 and GP-150 should share the same Explorer page,
    each showing the parts relevant to whichever pedal is connected. /gp150
    now just redirects, kept only in case of an old bookmark."""
    resp = client.get("/gp150", follow_redirects=False)
    assert resp.status_code in (302, 307)
    assert resp.headers["location"] == "/explorer"


def test_gp150_full_live_edit_section_on_explorer_page():
    """GP150-8 (2026-09-20): Preset Explorer hosts the FULL GP-150 section —
    file upload, live WebMIDI read, list-all-names, AND the live-edit
    controls (per-param send, model swap, reorder, save) — reusing gp150.js
    unchanged rather than a separate read-only duplicate. Deliberately NOT
    wired into PatchLib/the main preset grid: GP-150's container has no
    model_records/bypass_mask (see BACKLOG_GP150.md's GP150-8 entry), so it gets
    its own self-contained block on this page instead, kept separate from
    explorer.js/GP-5/GP-50 code so a future upstream PR stays a clean diff."""
    resp = client.get("/explorer")
    assert resp.status_code == 200
    html = resp.text
    for hook in (
        'id="gp150-drop"',
        'id="gp150-input"',
        'id="gp150-connect-btn"',
        'id="gp150-live-controls"',
        'id="gp150-slot-input"',
        'id="gp150-read-btn"',
        'id="gp150-list-names-btn"',
        'id="gp150-name-list"',
        'id="gp150-results"',
        'id="gp150-patch-template"',
        'class="gp150-reorder"',
        'class="gp150-save"',
        "gp150_format.js",
        "webmidi_gp150.js",
        "gp150.js",
    ):
        assert hook in html, f"missing GP-150 hook on /explorer: {hook}"
    # the live-edit/write controls ARE present here (this is the merged, full section)
    js = client.get("/static/gp150.js").text
    for write_hook in ("sendSetParam", "sendReorder", "sendSave", "sendModelSwap", "sendEnable"):
        assert write_hook in js, f"missing write control in gp150.js: {write_hook}"


def test_gp150_block_library_present_on_explorer_page():
    """EXP-9 (2026-09-23): the GP-150 block-library section (save/apply/
    export/import a single module's model+params+on-off, independent of
    any preset) is present on /explorer, self-contained in its own file
    (gp150_block_library.js) — no equivalent for GP-5/GP-50 yet."""
    resp = client.get("/explorer")
    assert resp.status_code == 200
    html = resp.text
    for hook in (
        'id="gp150-block-library"',
        'id="gp150-block-list"',
        'id="gp150-block-export-all-btn"',
        'id="gp150-block-import-btn"',
        'id="gp150-block-import-input"',
        'id="gp150-block-error"',
        "gp150_block_library.js",
    ):
        assert hook in html, f"missing GP-150 block-library hook on /explorer: {hook}"
    # the one hook gp150.js exposes for this feature — a custom event with
    # the already-decoded entry, not a re-derivation from the DOM
    gp150_js = client.get("/static/gp150.js").text
    assert "gp150:patch-rendered" in gp150_js
    lib_js = client.get("/static/gp150_block_library.js").text
    assert "gp150:patch-rendered" in lib_js
    for hook in ("sendModelSwap", "sendEnable", "sendSetParam", "localStorage"):
        assert hook in lib_js, f"missing hook in gp150_block_library.js: {hook}"


def test_gp150_captures_moved_to_device_page():
    """GP150-8 (2026-09-20): the GP-150 SnapTones/User IRs catalog listing
    moved from its own /gp150 page onto the Captures & IRs page (/device),
    alongside the existing GP-5/GP-50 sync flow, since it's a live WebMIDI
    read with a direct conceptual equivalent there."""
    resp = client.get("/device")
    assert resp.status_code == 200
    html = resp.text
    for hook in (
        'id="gp150-list-snaptones-btn"',
        'id="gp150-snaptone-list"',
        'id="gp150-list-user-irs-btn"',
        'id="gp150-user-ir-list"',
        "webmidi_gp150.js",
        "gp150_captures_ui.js",
    ):
        assert hook in html, f"missing GP-150 captures hook on /device: {hook}"


def test_static_webmidi_gp150_js_served():
    resp = client.get("/static/webmidi_gp150.js")
    assert resp.status_code == 200
    assert "WebMidiGP150" in resp.text


def test_gp150_converter_runs_client_side_not_via_backend():
    """PLAT-2: the GP-50/GP-5 -> GP-150 converter is a pure transform with no
    device I/O, so it's a client-side port (gp150_format.js +
    convert_gp50_to_gp150.js). GP150-8 (2026-09-20) moved it onto the Preset
    Converter page (/), alongside the existing GP-5<->GP-50 converter, since
    it has a direct equivalent there. (The separate /gp150 page it used to
    also live on is gone entirely now — see test_gp150_page_redirects_to_explorer.)
    Confirms the Converter page loads those scripts + prst.js, and that its
    own JS no longer calls the old backend endpoints for this feature."""
    html = client.get("/").text
    for script in ("prst.js", "gp150_format.js", "convert_gp50_to_gp150.js", "gp150_converter_ui.js"):
        assert script in html, f"missing script tag: {script}"
    js = client.get("/static/gp150_converter_ui.js").text
    assert "window.ConvertGp150" in js and "window.PRST" in js
    assert "/api/device/convert/gp50-to-gp150" not in js


def test_gp150_inspect_also_runs_client_side_not_via_backend():
    """PLAT-2 (2026-09-18): inspecting an uploaded/live-read GP-150 file
    (patch name, chain order, every module's model + params) is now decoded
    in the browser too — window.GP150Format.decode() + the bundled
    fxid_ring_gp150.json — the last backend dependency /gp150 had besides
    the (still-blocked, out of scope) GP150-6 live SysEx write path.
    Verified byte-for-byte against the real Python decoder over the whole
    200-file corpus in app/tests/test_gp150_inspect_js.mjs; this just
    confirms the backend calls are actually gone from the shipped JS."""
    js = client.get("/static/gp150.js").text
    assert "GP150Format.decode" in js
    assert 'fetch("/api/device/gp150/inspect"' not in js
    assert 'fetch("/api/device/gp150/models")' not in js


def test_gp150_folded_into_explorer_in_static_dist_build():
    """GP150-8 (2026-09-20): GP-150 no longer has its own page to build, so
    build_static_site.mjs no longer needs a dedicated gp150.html output or a
    /gp150 nav-link rewrite — GP-150 rides along with index.html (Explorer),
    which the build already produces from explorer.html."""
    script = open("scripts/build_static_site.mjs").read()
    assert "gp150.html" not in script
    assert r'href="\/gp150"' not in script


def test_static_gp150_format_and_converter_js_served():
    fmt_js = client.get("/static/gp150_format.js").text
    assert "GP150Format" in fmt_js and "buildFromSkeleton" in fmt_js
    conv_js = client.get("/static/convert_gp50_to_gp150.js").text
    assert "ConvertGp150" in conv_js and "GP50_SLOT_MODULE" in conv_js


def test_static_api_shim_handles_reset_and_replace_snaptone():
    """PLAT-2: CAP-2/CAP-3 (reset-to-blank, replace-SnapTone) now have a
    static-mode (WebMIDI, no backend) implementation in static_api.js,
    mirroring app/api_device.py's /reset and /replace-snaptone routes —
    not just the original build/write/swap handlers."""
    js = client.get("/static/static_api.js").text
    assert '"/api/device/reset"' in js and "handleReset" in js
    assert '"/api/device/replace-snaptone"' in js and "handleReplaceSnaptone" in js
    assert "repointSnaptone" in js  # reused, not reimplemented


def test_static_data_bundle_has_gp150_converter_assets():
    for path, content_check in [
        ("/static/data/fxid_ring_gp150.json", lambda b: b.startswith(b"{")),
        ("/static/data/gp50_to_gp150_model_map.json", lambda b: b.startswith(b"{")),
        ("/static/data/gp150_skeleton.prst", lambda b: len(b) == 1128),
    ]:
        resp = client.get(path)
        assert resp.status_code == 200, path
        assert content_check(resp.content), path
