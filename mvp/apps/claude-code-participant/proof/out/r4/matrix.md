# r4: each method's probe request against the local resume

`same*` is same apart from lines that two local resumes differ by as well.

| method | compact | text |
|---|---|---|
| `file` | same | same |
| `file2` | same | same |
| `file3` | same* | same |
| `file4` | same* | same |
| `file5` | same | same |
| `file6` | same | same |
| `file7` | same | same |
| `file8` | same* | same |
| `file9` | same* | same |
| `local` | same | same |
| `local2` | same* | same |
| `local3` | same | same |
| `local4` | same | same |
| `local5` | same* | same |
| `local6` | same* | same |
| `local7` | same* | same |
| `local8` | same* | same |
| `msg` | DIFF system.0.text diagnostics.previous_message_id messages messages[] | DIFF system.0.text diagnostics.previous_message_id messages messages[] |
| `msg-msgid,reqid,model,wire,toolresult,strcontent,system,extras` | same* | DIFF system.0.text |
| `msg-msgid,reqid,turnpos,model,toolresult,strcontent,system,extras` | same* | same |
| `msg-msgid,reqid,turnpos,model,wire,strcontent,system,extras` | same | same |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,extras` | DIFF system.0.text messages messages[] | same |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system` | DIFF system.0.text diagnostics.previous_message_id messages[] | DIFF system.2.text system.3.text messages messages[] |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system,extras` | same | same |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system,extras,origin` | same* | same |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,strcontent,system,extras@` | same* | same |
| `msg-msgid,reqid,turnpos,model,wire,toolresult,system,extras` | same* | same |
| `msg-msgid,reqid,turnpos,wire,toolresult,strcontent,system,extras` | same* | same |
| `msg-msgid,turnpos,model,wire,toolresult,strcontent,system,extras` | DIFF system.0.text | DIFF system.0.text |
| `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,strcontent,system,extras` | same* | same |
| `msg-reqid,turnpos,model,wire,toolresult,strcontent,system,extras` | DIFF diagnostics.previous_message_id | DIFF diagnostics.previous_message_id |
| `raw` | same | same |
| `raw@` | same* | same |
