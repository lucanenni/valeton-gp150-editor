# GP-150 probe scripts (this fork)

`gp150_rtmidi_diag.py` / `gp150_runloop_diag.py` (moved here 2026-08-22,
CLEANUP-1): the pair of one-off scripts from GP150-5's first-contact
debugging that isolated CoreMIDI's run-loop requirement (plain
`time.sleep()` polling never fires input callbacks; a pumped
`AppHelper.runConsoleEventLoop()` does). Their finding is now baked into
every live GP-150 script (`patch/gp150_live_read.py`,
`patch/gp150_probe.py`, `patch/gp150_cc_experiment.py`,
`patch/gp150_wake_replay.py`), which is the only place that still narrates
the story. Superseded, not needed to rerun — kept for the record, same as
everything else in this directory.
