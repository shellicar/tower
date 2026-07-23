#!/bin/sh
input="$(cat)"
session_id="$(echo "$input" | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p')"
transcript="$(echo "$input" | sed -n 's/.*"transcript_path":"\([^"]*\)".*/\1/p')"
last="$(echo "$input" | sed -n 's/.*"last_assistant_message":"\([^"]*\)".*/\1/p')"
echo "[hook] Stop fired: session=$session_id transcript=$transcript last=\"$last\"" >> /tmp/ptyspike.log
