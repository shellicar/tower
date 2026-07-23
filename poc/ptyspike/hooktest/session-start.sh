#!/bin/sh
input="$(cat)"
session_id="$(echo "$input" | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p')"
transcript="$(echo "$input" | sed -n 's/.*"transcript_path":"\([^"]*\)".*/\1/p')"
printf '{"sessionId":"%s","transcriptPath":"%s"}\n' "$session_id" "$transcript" > /tmp/ptyspike-session.json
echo "[hook] SessionStart: session=$session_id transcript=$transcript" >> /tmp/ptyspike.log
