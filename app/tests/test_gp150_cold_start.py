"""GP150-6 write-protocol round structure — regression test for the
2026-09-08 findings from a real cold-start capture (pedal power-cycled,
connected fresh, then two live AmpGain edits).

Ground truth: re/gp150_captures/cold_start_ampgain.mmon (102 real
messages). Confirms the write protocol runs in numbered *rounds* — ping
(To) -> substantive request (To) -> device echoes the ping verbatim
(From) -> next round's response, counter shared by both directions and
advancing once per round, not once per raw message — and that the
existing WAKE_REQUEST_BYTES (patch/gp150_wake_replay.py) is exactly this
capture's own round-1 substantive request, byte-for-byte. See
design/GP150_SUPPORT.md §3.1
for the full write-up; the `tag` byte itself remains unsolved — this
test only locks down what IS understood, so it doesn't silently regress.
"""

import os

from app.tests.test_gp150_wire import _load_mmon_messages, CAPTURES_DIR

CAPTURE_PATH = os.path.join(CAPTURES_DIR, "cold_start_ampgain.mmon")

# Copied verbatim from patch/gp150_wake_replay.py's WAKE_REQUEST_BYTES --
# duplicated here (rather than imported) so this test doesn't pull in
# that module's rtmidi/PyObjCTools hardware dependencies just to compare
# a byte constant.
WAKE_REQUEST_BYTES = bytes([
    127, 92, 15, 0, 0, 0, 1, 0, 0, 1, 8, 2, 0, 11, 0, 0, 0, 3, 0, 3, 1, 1, 3,
    0, 1, 1, 3, 0, 0, 2, 0, 0, 15, 15, 15, 15, 0, 1,
])


def _messages():
    return [
        (ep, bytes(data))
        for ep, data in _load_mmon_messages(CAPTURE_PATH)
        if data is not None
    ]


def test_capture_has_expected_message_count():
    # Locks the fixture itself down -- if this ever changes, the indices
    # used by the other tests below need re-deriving from a fresh dump.
    assert len(_messages()) == 102


def test_round1_substantive_request_matches_wake_request_bytes():
    msgs = _messages()
    # Message index 6 (0-based) is round 1's substantive "To GP-150"
    # request -- see the byte-by-byte dump in design/GP150_SUPPORT.md.
    ep, data = msgs[6]
    assert ep == "To GP-150"
    assert data == WAKE_REQUEST_BYTES


def test_ping_is_echoed_verbatim_by_the_device():
    msgs = _messages()
    # Round 7's ping/echo pair (message indices 95 and 97): a short
    # 8-byte "To" message the device echoes back byte-for-byte, tag
    # included -- this is what lets the tag be freely chosen for pings
    # specifically (unlike the substantive request's own tag).
    ping_ep, ping = msgs[95]
    echo_ep, echo = msgs[97]
    assert ping_ep == "To GP-150"
    assert echo_ep == "From GP-150"
    assert len(ping) == 8
    assert echo == ping


def test_counter_shared_by_both_directions_within_a_round():
    msgs = _messages()
    # Round 7 spans indices 94-97 here: a trailing response chunk from
    # the previous round's burst, then this round's ping+request+echo.
    # All four raw messages carry the SAME counter (byte 6) despite two
    # different directions and message shapes -- counter advances once
    # per round, not once per raw message.
    counters = {data[6] for _, data in msgs[94:98]}
    assert counters == {7}


def test_counter_advances_by_one_between_consecutive_rounds():
    msgs = _messages()
    # The live edit in round 7 (index 96) and the next live edit in
    # round 8 (index 100) are consecutive rounds -- counter is exactly
    # +1, matching the simple per-message sequence seen during a rapid
    # slider drag (each drag step completing a whole round on its own).
    assert msgs[96][1][6] == 7
    assert msgs[100][1][6] == 8
