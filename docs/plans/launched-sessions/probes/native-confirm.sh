#!/bin/bash
# Probe: zenity's exit codes for Launch, Cancel, Enter with --default-cancel, its timeout, a kill, and an unreachable display.
# Needs zenity, Xvfb, and xdotool (apt-get install zenity xvfb xdotool); shows the dialogs on a private virtual display.
Xvfb :91 -screen 0 1024x768x24 >/dev/null 2>&1 & XVFB=$!; sleep 1.5; export DISPLAY=:91
ask() { zenity --question "$@" --title=Prism --text="Start probe?" --ok-label=Launch --cancel-label=Cancel 2>/dev/null; }
ask --timeout=2; echo "timeout-exit=$?"
( ask --timeout=20; echo "return-exit=$?" ) & sleep 2; xdotool key --window "$(xdotool search --name Prism | head -1)" Return; wait %2 2>/dev/null; wait
( ask --timeout=20; echo "escape-exit=$?" ) & sleep 2; xdotool key --window "$(xdotool search --name Prism | head -1)" Escape; wait
( ask --default-cancel --timeout=20; echo "default-cancel-return-exit=$?" ) & sleep 2; xdotool key --window "$(xdotool search --name Prism | head -1)" Return; wait
( ask --timeout=20; echo "killed-exit=$?" ) & sleep 2; pkill -x zenity; wait
DISPLAY=:99 zenity --question --text=x --timeout=2; echo "unreachable-display-exit=$?"
kill $XVFB
