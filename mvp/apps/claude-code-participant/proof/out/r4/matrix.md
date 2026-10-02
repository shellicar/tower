# r4: each method's probe request against the local resume

`same*` is same apart from lines that two local resumes differ by as well.

| method | text | thinking | tool | parallel | midturn | background | compact |
|---|---|---|---|---|---|---|---|
| `file` | same | - | - | - | - | - | same |
| `file2` | same | - | - | - | - | - | same |
| `file3` | same | - | - | - | - | - | same* |
| `file4` | same | - | - | - | - | - | same* |
| `file5` | same | - | - | - | - | - | same |
| `file6` | same | - | - | - | - | - | same |
| `file7` | same | - | - | - | - | - | same |
| `file8` | same | - | - | - | - | - | same* |
| `file9` | same | - | - | - | - | - | same* |
| `local` | same | same | same | same | same | same | same |
| `local2` | same | same | same | same | same | same | same* |
| `local3` | same | same | same | same | same | same | same |
| `local4` | same | - | - | - | - | - | same |
| `local5` | same | - | - | - | - | - | same* |
| `local6` | same | - | - | - | - | - | same* |
| `local7` | same | - | - | - | - | - | same* |
| `local8` | same | - | - | - | - | - | same* |
| `msg` | DIFF system.0.text diagnostics.previous_message_id messages messages[] | DIFF system.0.text system.2.text system.3.text diagnostics.previous_message_id messages[] | DIFF system.0.text diagnostics.previous_message_id messages messages[] | DIFF system.0.text diagnostics.previous_message_id messages messages[] | DIFF system.0.text safeguards.prior_turn_context diagnostics.previous_message_id messages messages[] | DIFF system.0.text system.2.text system.3.text safeguards.prior_turn_context diagnostics.previous_message_id messages messages[] | DIFF system.0.text diagnostics.previous_message_id messages messages[] |
| `msg-msgid,reqid,model,wire,toolresult,strcontent,system,extras` | DIFF system.0.text | DIFF system.0.text | DIFF system.0.text | DIFF system.0.text | DIFF system.0.text | DIFF system.0.text messages[] | same* |
| `msg-msgid,reqid,turnpos,model,toolresult,strcontent,system,extras` | same | same | same | same | same | DIFF messages[] | same* |
| `msg-msgid,reqid,turnpos,model,wire,strcontent,system,extras` | same | same | same | same | DIFF safeguards.prior_turn_context | DIFF safeguards.prior_turn_context messages[] | same |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,extras` | same | same | same | same | same | DIFF messages[] | DIFF system.0.text messages messages[] |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system` | DIFF system.2.text system.3.text messages messages[] | DIFF system.2.text system.3.text messages[] | DIFF system.2.text system.3.text messages messages[] | DIFF messages messages[] | DIFF messages messages[] | DIFF messages messages[] | DIFF system.0.text diagnostics.previous_message_id messages[] |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system,extras` | same | same | same | same | same | DIFF messages[] | same |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system,extras,origin` | same | same | same | same | same | same | same* |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system,extras@` | same | same | same | same | same | DIFF messages[] | same* |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,system,extras` | same | same | same | same | same | DIFF messages[] | same* |
| `msg-msgid,reqid,turnpos,wire,toolresult,strcontent,system,extras` | same | DIFF messages[] | same | same | same | DIFF messages[] | same* |
| `msg-msgid,turnpos,model,wire,toolresult,strcontent,system,extras` | DIFF system.0.text | DIFF system.0.text | DIFF system.0.text | DIFF system.0.text | DIFF system.0.text | DIFF system.0.text messages[] | DIFF system.0.text |
| `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,strcontent,system,extras` | same | same | same | same | same | same | same* |
| `msg-reqid,turnpos,model,wire,toolresult,strcontent,system,extras` | DIFF diagnostics.previous_message_id | DIFF diagnostics.previous_message_id messages[] | DIFF diagnostics.previous_message_id messages messages[] | DIFF diagnostics.previous_message_id messages messages[] | DIFF diagnostics.previous_message_id messages messages[] | DIFF diagnostics.previous_message_id messages messages[] | DIFF diagnostics.previous_message_id |
| `raw` | same | same | same | same | same | same | same |
| `raw@` | same | same | same | same | same | same | same* |
