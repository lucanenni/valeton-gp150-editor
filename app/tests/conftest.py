"""Shared fixtures for the test suite.

`live_server` is only used by the slow, real-browser e2e test
(test_e2e.py) — it launches the actual app (uvicorn + app.main:app) as a
subprocess against a real free port, so a real headless browser can drive
it over HTTP. The fast suite (TestClient-based) does not use this fixture.
"""

from __future__ import annotations

import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


@pytest.fixture(autouse=True)
def _pin_fixture_exports(monkeypatch):
    """Tests use the presetExports fixtures deterministically, even when a local
    device_scan/ (from a live scan) exists and would otherwise shadow them."""
    from app import patchlib

    monkeypatch.setattr(patchlib, "SCAN_DIR", str(PROJECT_ROOT / "_no_such_scan_dir"))
    patchlib.reload()
    yield
    patchlib.reload()


# Upstream's GP-50 tests compare against the author's own preset exports (presetExports/, git-ignored, not in
# the repo). Without them these tests cannot pass, so they are skipped instead of failing.
NEEDS_PRESET_EXPORTS = {
    "test_convert.py": {
        "test_detect_gp50_exports",
        "test_gp50_stream_unchanged_29_packets",
        "test_gp50_to_gp5_preserves_portable_content",
        "test_write_stream_builds_and_validates_for_both_devices",
    },
    "test_device.py": {
        "test_block_detail_and_facets",
        "test_block_detail_carries_fxid_roundtrips_to_catalog",
        "test_block_params_decode_against_hardware",
        "test_build_write_requires_confirm",
        "test_clone_multiple_returns_zip",
        "test_clone_single_returns_valid_prst",
        "test_edit_endpoint_writes_params_bypass_settings",
        "test_edit_footswitch_assignment_max_two",
        "test_edit_leaves_other_params_untouched",
        "test_edit_swaps_model_record",
        "test_export_multiple_returns_a_zip",
        "test_export_single_returns_the_original_file_untouched",
        "test_facets_models_carry_official",
        "test_inventory_shape_real_data",
        "test_official_names_origin",
        "test_patch_write_stream_reproduces_suite_capture",
        "test_replace_snaptone_repoints_and_writes_back_to_the_same_slot",
        "test_repoint_engine_guards",
        "test_reset_stops_on_first_failure",
        "test_reset_writes_the_factory_blank_to_each_slot",
        "test_swap_writes_both_bodies",
        "test_template_from_patch_then_build_download",
        "test_user_ir_uses_device_name_when_synced",
        "test_write_endpoint_applies_edits_and_writes",
    },
    "test_device_protocol.py": {
        "test_device_io_write_patch_friendly_error_from_fake_writer",
        "test_device_io_write_patch_parses_fake_writer",
        "test_write_patch_script_bad_slot_is_structured_error",
        "test_write_patch_script_dry_run_emits_contract",
    },
    "test_prst_format.py": {
        "test_layout_constants_hold_across_all_exports",
        "test_model_records_shape_and_refix",
        "test_name_codec_round_trip_and_truncation",
        "test_read_name_stops_at_body_boundary",
    },
}


def _have_preset_exports() -> bool:
    d = PROJECT_ROOT / "presetExports"
    return d.is_dir() and any(d.glob("*.prst"))


def pytest_collection_modifyitems(config, items):
    if _have_preset_exports():
        return
    skip = pytest.mark.skip(reason="needs the GP-50 preset exports (presetExports/*.prst, not in the repo)")
    for item in items:
        names = NEEDS_PRESET_EXPORTS.get(Path(str(item.fspath)).name)
        if names and item.name.split("[")[0] in names:
            item.add_marker(skip)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def live_server():
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"

    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    try:
        deadline = time.time() + 30
        ready = False
        while time.time() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ""
                raise RuntimeError(
                    f"app server exited early (rc={proc.returncode}):\n{out}"
                )
            try:
                with urllib.request.urlopen(f"{base_url}/health", timeout=1) as resp:
                    if resp.status == 200:
                        ready = True
                        break
            except OSError:
                pass
            time.sleep(0.25)

        if not ready:
            proc.terminate()
            raise RuntimeError(
                f"app server did not become healthy at {base_url}/health within 30s"
            )

        yield base_url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
