HELM_BRIDGE_PATH=./target/debug/bridge cargo run -p helm -- --adopt 8c280151-78f5-48e2-9c3a-2e856a582c01 -c '
{"skills":{"dir":"~/repos/shellicar/skills-v2/skills"}}
{"model":"claude-sonnet-5"}
{"permissions": [
  { "match": "$PWD", "read": "allow", "write": "allow", "delete": "ask", "exec": "allow" },
  { "match": "*", "read": "allow", "write": "ask", "delete": "deny", "exec": "ask" }
]}
{"settings":{}}
'
