# Resume comparison, run r3

Reference: the `local` method (Claude Code reads its own record). Each other method is compared with it, request for request.

## tool

Summary (what differs, by location):

- `local`: same
- `local2`: same
- `msg`: differs; differs at system.0.text, diagnostics.previous_message_id, messages, messages[0], messages[1], messages[4], messages[5], messages[6], messages[7]
- `msg-extras`: differs; differs at system.0.text, diagnostics.previous_message_id
- `msg-msgid,reqid,turnpos,extras`: same
- `msg-msgid,reqid,turnpos,extras,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model@`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,system,model`: same
- `msg-msgid,reqid,turnpos,extras,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras@`: same
- `msg-parent,msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,extras`: same
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,system,extras`: same
- `raw`: same
- `raw@`: same

Detail:

- `local`: same (the reference)
- `local2`: same
- `msg`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.03f; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdjzjoE5YDZBGL5XMYAH; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.03f; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk;"
    - diagnostics.previous_message_id: "msg_011CfdjzkDGUoQgiZnPaTyeY" vs null
    - messages: 8 vs 7
    - messages[0] user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("Use the Read tool on note.txt in the current direc…")] vs user[text("Use the Read tool on note.txt in the current direc…")]
    -     messages[0].content.0.text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is stephen… vs "Use the Read tool on note.txt in the current directory and tell me its first word after \"is:\". Reply with just that word."
    -     messages[0].content.1: {"type":"text","text":"<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's… vs undefined
    -     messages[0].content.2: {"type":"text","text":"Use the Read tool on note.txt in the current directory and tell me its first word after \"is:\". Reply with just that… vs undefined
    - messages[1] system[string("## Bash command sandbox\nBy default, Bash commands …")] vs system[]
    -     messages[1].content: "## Bash command sandbox\nBy default, Bash commands run inside an OS-level sandbox (Linux bubblewrap) applied to each command separately, no… vs []
    - messages[4] system[string("<total_tokens>14981419 tokens left</total_tokens>")] vs assistant[text("marmalade")]
    -     messages[4].role: "system" vs "assistant"
    -     messages[4].content: "<total_tokens>14981419 tokens left</total_tokens>" vs [{"type":"text","text":"marmalade"}]
    - … 11 more lines in report.json
- `msg-extras`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.03f; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdjzjoE5YDZBGL5XMYAH; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.03f; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk;"
    - diagnostics.previous_message_id: "msg_011CfdjzkDGUoQgiZnPaTyeY" vs null
- `msg-msgid,reqid,turnpos,extras`: same
- `msg-msgid,reqid,turnpos,extras,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model@`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,system,model`: same
- `msg-msgid,reqid,turnpos,extras,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras@`: same
- `msg-parent,msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,extras`: same
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,system,extras`: same
- `raw`: same
- `raw@`: same

## parallel

Summary (what differs, by location):

- `local`: same
- `local2`: same
- `msg`: differs; differs at system.0.text, diagnostics.previous_message_id, messages, messages[0], messages[1], messages[2], messages[3], messages[4], messages[5], messages[6], messages[7], messages[8]
- `msg-extras`: differs; differs at system.0.text, diagnostics.previous_message_id, messages, messages[2], messages[3], messages[4], messages[5], messages[6], messages[7], messages[8], messages[9]
- `msg-msgid,reqid,turnpos,extras`: same
- `msg-msgid,reqid,turnpos,extras,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model@`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,system,model`: same
- `msg-msgid,reqid,turnpos,extras,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras@`: same
- `msg-parent,msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,extras`: same
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,system,extras`: same
- `raw`: same
- `raw@`: same

Detail:

- `local`: same (the reference)
- `local2`: same
- `msg`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.014; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011Cfdk4kevdqkaMYSXg19C6; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.014; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk;"
    - diagnostics.previous_message_id: "msg_011Cfdk4kzGGGaqCPMoEvBDW" vs null
    - messages: 8 vs 9
    - messages[0] user[text("<system-reminder>\nAttribution for git commits and …") + text("Read a.txt and b.txt in the current directory with…")] vs user[text("Read a.txt and b.txt in the current directory with…")]
    -     messages[0].content.0.text: "<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's own earlier attributi… vs "Read a.txt and b.txt in the current directory with two Read tool calls in the same response (in parallel). Then reply with both contents on…
    -     messages[0].content.1: {"type":"text","text":"Read a.txt and b.txt in the current directory with two Read tool calls in the same response (in parallel). Then reply… vs undefined
    - messages[1] system[string("## Bash command sandbox\nBy default, Bash commands …")] vs system[]
    -     messages[1].content: "## Bash command sandbox\nBy default, Bash commands run inside an OS-level sandbox (Linux bubblewrap) applied to each command separately, no… vs []
    - messages[2] assistant[tool_use(Read 6BUeAX) + tool_use(Read PTD6BL)] vs assistant[tool_use(Read 6BUeAX)]
    -     messages[2].content.1: {"type":"tool_use","id":"toolu_01J4sjPcj5qRXtFsH1PTD6BL","name":"Read","input":{"file_path":"/tmp/tower-proof/parallel/cwd/b.txt"},"caller":… vs undefined
    - messages[3] user[tool_result(6BUeAX) + tool_result(PTD6BL)] vs user[tool_result(6BUeAX)]
    -     messages[3].content.1: {"tool_use_id":"toolu_01J4sjPcj5qRXtFsH1PTD6BL","type":"tool_result","content":"1\tbravo-content\n2\t"} vs undefined
    - … 19 more lines in report.json
- `msg-extras`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.014; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011Cfdk4kevdqkaMYSXg19C6; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.014; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk;"
    - diagnostics.previous_message_id: "msg_011Cfdk4kzGGGaqCPMoEvBDW" vs null
    - messages: 8 vs 10
    - messages[2] assistant[tool_use(Read 6BUeAX) + tool_use(Read PTD6BL)] vs assistant[tool_use(Read 6BUeAX)]
    -     messages[2].content.1: {"type":"tool_use","id":"toolu_01J4sjPcj5qRXtFsH1PTD6BL","name":"Read","input":{"file_path":"/tmp/tower-proof/parallel/cwd/b.txt"},"caller":… vs undefined
    - messages[3] user[tool_result(6BUeAX) + tool_result(PTD6BL)] vs user[tool_result(6BUeAX)]
    -     messages[3].content.1: {"tool_use_id":"toolu_01J4sjPcj5qRXtFsH1PTD6BL","type":"tool_result","content":"1\tbravo-content\n2\t"} vs undefined
    - messages[4] system[string("<total_tokens>14981474 tokens left</total_tokens>")] vs assistant[tool_use(Read PTD6BL)]
    -     messages[4].role: "system" vs "assistant"
    -     messages[4].content: "<total_tokens>14981474 tokens left</total_tokens>" vs [{"type":"tool_use","id":"toolu_01J4sjPcj5qRXtFsH1PTD6BL","name":"Read","input":{"file_path":"/tmp/tower-proof/parallel/cwd/b.txt"},"caller"…
    - messages[5] assistant[text("a.txt: alpha-content | b.txt: bravo-content")] vs user[tool_result(PTD6BL)]
    -     messages[5].role: "assistant" vs "user"
    - … 14 more lines in report.json
- `msg-msgid,reqid,turnpos,extras`: same
- `msg-msgid,reqid,turnpos,extras,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model@`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,system,model`: same
- `msg-msgid,reqid,turnpos,extras,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras@`: same
- `msg-parent,msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,extras`: same
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,system,extras`: same
- `raw`: same
- `raw@`: same

## midturn

Summary (what differs, by location):

- `local`: same
- `local2`: same
- `msg`: differs; differs at system.0.text, system.2.text, system.3.text, safeguards.0.classifier_context.prior_turn_context, diagnostics.previous_message_id, messages, messages[0], messages[1], messages[4], messages[5], messages[6], messages[7]
- `msg-extras`: differs; differs at system.0.text, safeguards.0.classifier_context.prior_turn_context, diagnostics.previous_message_id
- `msg-msgid,reqid,turnpos,extras`: differs; differs at safeguards.0.classifier_context.prior_turn_context
- `msg-msgid,reqid,turnpos,extras,model`: differs; differs at safeguards.0.classifier_context.prior_turn_context
- `msg-msgid,reqid,turnpos,extras,toolresult,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model@`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,system,model`: same
- `msg-msgid,reqid,turnpos,extras,wire,origin,system,model`: differs; differs at safeguards.0.classifier_context.prior_turn_context
- `msg-msgid,reqid,turnpos,extras@`: differs; differs at safeguards.0.classifier_context.prior_turn_context
- `msg-parent,msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,extras`: differs; differs at safeguards.0.classifier_context.prior_turn_context
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,system,extras`: same
- `raw`: same
- `raw@`: same

Detail:

- `local`: same (the reference)
- `local2`: same
- `msg`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.03f; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011Cfdk98C5hwyjfUdns9o32; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.03f; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk;"
    - system.2.text: "\nYou are an interactive agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, def… vs "\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized se…
    - system.3.text: "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the … vs "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the …
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_01VGuzYB6zLTGDRAMqLmUo7G"],"context":{"git_state":{"cwd":"/tmp/tower-proof/midturn/cwd","root":null,"branch":null,"… vs undefined
    - diagnostics.previous_message_id: "msg_011Cfdk98b9HmBA2cce6vy8n" vs null
    - messages: 8 vs 7
    - messages[0] user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("Use the Bash tool to run `sleep 12; echo first-don…")] vs user[text("Use the Bash tool to run `sleep 12; echo first-don…")]
    -     messages[0].content.0.text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is stephen… vs "Use the Bash tool to run `sleep 12; echo first-done`, then reply with the output."
    -     messages[0].content.1: {"type":"text","text":"<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's… vs undefined
    -     messages[0].content.2: {"type":"text","text":"Use the Bash tool to run `sleep 12; echo first-done`, then reply with the output."} vs undefined
    - messages[1] system[string("## Bash command sandbox\nBy default, Bash commands …")] vs system[]
    -     messages[1].content: "## Bash command sandbox\nBy default, Bash commands run inside an OS-level sandbox (Linux bubblewrap) applied to each command separately, no… vs []
    - … 14 more lines in report.json
- `msg-extras`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.03f; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011Cfdk98C5hwyjfUdns9o32; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.03f; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk;"
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_01VGuzYB6zLTGDRAMqLmUo7G"],"context":{"git_state":{"cwd":"/tmp/tower-proof/midturn/cwd","root":null,"branch":null,"… vs undefined
    - diagnostics.previous_message_id: "msg_011Cfdk98b9HmBA2cce6vy8n" vs null
- `msg-msgid,reqid,turnpos,extras`: differs
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_01VGuzYB6zLTGDRAMqLmUo7G"],"context":{"git_state":{"cwd":"/tmp/tower-proof/midturn/cwd","root":null,"branch":null,"… vs undefined
- `msg-msgid,reqid,turnpos,extras,model`: differs
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_01VGuzYB6zLTGDRAMqLmUo7G"],"context":{"git_state":{"cwd":"/tmp/tower-proof/midturn/cwd","root":null,"branch":null,"… vs undefined
- `msg-msgid,reqid,turnpos,extras,toolresult,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model@`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,system,model`: same
- `msg-msgid,reqid,turnpos,extras,wire,origin,system,model`: differs
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_01VGuzYB6zLTGDRAMqLmUo7G"],"context":{"git_state":{"cwd":"/tmp/tower-proof/midturn/cwd","root":null,"branch":null,"… vs undefined
- `msg-msgid,reqid,turnpos,extras@`: differs
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_01VGuzYB6zLTGDRAMqLmUo7G"],"context":{"git_state":{"cwd":"/tmp/tower-proof/midturn/cwd","root":null,"branch":null,"… vs undefined
- `msg-parent,msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,extras`: differs
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_01VGuzYB6zLTGDRAMqLmUo7G"],"context":{"git_state":{"cwd":"/tmp/tower-proof/midturn/cwd","root":null,"branch":null,"… vs undefined
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,system,extras`: same
- `raw`: same
- `raw@`: same

## background

Summary (what differs, by location):

- `local`: same
- `local2`: same
- `msg`: differs; differs at system.0.text, safeguards.0.classifier_context.prior_turn_context, diagnostics.previous_message_id, messages, messages[0], messages[1], messages[2], messages[4], messages[5], messages[6], messages[7], messages[8], messages[9]
- `msg-extras`: differs; differs at system.0.text, safeguards.0.classifier_context.prior_turn_context, diagnostics.previous_message_id, messages[2], messages[6]
- `msg-msgid,reqid,turnpos,extras`: differs; differs at safeguards.0.classifier_context.prior_turn_context, messages[2], messages[6]
- `msg-msgid,reqid,turnpos,extras,model`: differs; differs at safeguards.0.classifier_context.prior_turn_context, messages[2], messages[6]
- `msg-msgid,reqid,turnpos,extras,toolresult,origin,system,model`: differs; differs at messages[2], messages[6]
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,model`: differs; differs at messages[6]
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: differs; differs at messages[6]
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model@`: differs; differs at messages[6]
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,system,model`: differs; differs at messages[6]
- `msg-msgid,reqid,turnpos,extras,wire,origin,system,model`: differs; differs at safeguards.0.classifier_context.prior_turn_context, messages[6]
- `msg-msgid,reqid,turnpos,extras@`: differs; differs at safeguards.0.classifier_context.prior_turn_context, messages[2], messages[6]
- `msg-parent,msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: differs; differs at messages[6]
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,extras`: differs; differs at safeguards.0.classifier_context.prior_turn_context, messages[2], messages[6]
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,system,extras`: differs; differs at messages[6]
- `raw`: same
- `raw@`: same

Detail:

- `local`: same (the reference)
- `local2`: same
- `msg`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.465; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkDfze4fPcp1iX2NKUy; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.465; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk;"
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_013sBHj3Jk443vmoJ8tL599k"],"context":{"git_state":{"cwd":"/tmp/tower-proof/background/cwd","root":null,"branch":nul… vs undefined
    - diagnostics.previous_message_id: "msg_011CfdkDgH1Jg4vdezutY9QD" vs null
    - messages: 10 vs 9
    - messages[0] user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("Start a background task with the Bash tool (run_in…")] vs user[text("Start a background task with the Bash tool (run_in…")]
    -     messages[0].content.0.text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is stephen… vs "Start a background task with the Bash tool (run_in_background true) that runs `sleep 5; echo bg-finished`. After starting it, reply with th…
    -     messages[0].content.1: {"type":"text","text":"<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's… vs undefined
    -     messages[0].content.2: {"type":"text","text":"Start a background task with the Bash tool (run_in_background true) that runs `sleep 5; echo bg-finished`. After star… vs undefined
    - messages[1] system[string("## Bash command sandbox\nBy default, Bash commands …")] vs system[]
    -     messages[1].content: "## Bash command sandbox\nBy default, Bash commands run inside an OS-level sandbox (Linux bubblewrap) applied to each command separately, no… vs []
    - messages[2] assistant[tool_use(Bash tL599k)] vs assistant[tool_use(Bash tL599k)]
    - messages[4] system[string("<total_tokens>14981384 tokens left</total_tokens>")] vs assistant[text("started")]
    - … 19 more lines in report.json
- `msg-extras`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.465; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkDfze4fPcp1iX2NKUy; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.465; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk;"
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_013sBHj3Jk443vmoJ8tL599k"],"context":{"git_state":{"cwd":"/tmp/tower-proof/background/cwd","root":null,"branch":nul… vs undefined
    - diagnostics.previous_message_id: "msg_011CfdkDgH1Jg4vdezutY9QD" vs null
    - messages[2] assistant[tool_use(Bash tL599k)] vs assistant[tool_use(Bash tL599k)]
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<task-notification>\n<task-id>baqmnyz51</task-id>\n<…")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<task-notification>\n<task-id>baqmnyz51</task-id>\n<tool-use-id>toolu_013sBHj3Jk443vmoJ8tL599k</tool-use-id>\n<outpu…
- `msg-msgid,reqid,turnpos,extras`: differs
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_013sBHj3Jk443vmoJ8tL599k"],"context":{"git_state":{"cwd":"/tmp/tower-proof/background/cwd","root":null,"branch":nul… vs undefined
    - messages[2] assistant[tool_use(Bash tL599k)] vs assistant[tool_use(Bash tL599k)]
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<task-notification>\n<task-id>baqmnyz51</task-id>\n<…")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<task-notification>\n<task-id>baqmnyz51</task-id>\n<tool-use-id>toolu_013sBHj3Jk443vmoJ8tL599k</tool-use-id>\n<outpu…
- `msg-msgid,reqid,turnpos,extras,model`: differs
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_013sBHj3Jk443vmoJ8tL599k"],"context":{"git_state":{"cwd":"/tmp/tower-proof/background/cwd","root":null,"branch":nul… vs undefined
    - messages[2] assistant[tool_use(Bash tL599k)] vs assistant[tool_use(Bash tL599k)]
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<task-notification>\n<task-id>baqmnyz51</task-id>\n<…")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<task-notification>\n<task-id>baqmnyz51</task-id>\n<tool-use-id>toolu_013sBHj3Jk443vmoJ8tL599k</tool-use-id>\n<outpu…
- `msg-msgid,reqid,turnpos,extras,toolresult,origin,system,model`: differs
    - messages[2] assistant[tool_use(Bash tL599k)] vs assistant[tool_use(Bash tL599k)]
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message…
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,model`: differs
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message…
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: differs
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message…
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model@`: differs
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message…
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,system,model`: differs
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<task-notification>\n<task-id>baqmnyz51</task-id>\n<…")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<task-notification>\n<task-id>baqmnyz51</task-id>\n<tool-use-id>toolu_013sBHj3Jk443vmoJ8tL599k</tool-use-id>\n<outpu…
- `msg-msgid,reqid,turnpos,extras,wire,origin,system,model`: differs
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_013sBHj3Jk443vmoJ8tL599k"],"context":{"git_state":{"cwd":"/tmp/tower-proof/background/cwd","root":null,"branch":nul… vs undefined
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message…
- `msg-msgid,reqid,turnpos,extras@`: differs
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_013sBHj3Jk443vmoJ8tL599k"],"context":{"git_state":{"cwd":"/tmp/tower-proof/background/cwd","root":null,"branch":nul… vs undefined
    - messages[2] assistant[tool_use(Bash tL599k)] vs assistant[tool_use(Bash tL599k)]
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<task-notification>\n<task-id>baqmnyz51</task-id>\n<…")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<task-notification>\n<task-id>baqmnyz51</task-id>\n<tool-use-id>toolu_013sBHj3Jk443vmoJ8tL599k</tool-use-id>\n<outpu…
- `msg-parent,msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: differs
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message…
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,extras`: differs
    - safeguards.0.classifier_context.prior_turn_context: [{"tool_use_ids":["toolu_013sBHj3Jk443vmoJ8tL599k"],"context":{"git_state":{"cwd":"/tmp/tower-proof/background/cwd","root":null,"branch":nul… vs undefined
    - messages[2] assistant[tool_use(Bash tL599k)] vs assistant[tool_use(Bash tL599k)]
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<task-notification>\n<task-id>baqmnyz51</task-id>\n<…")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<task-notification>\n<task-id>baqmnyz51</task-id>\n<tool-use-id>toolu_013sBHj3Jk443vmoJ8tL599k</tool-use-id>\n<outpu…
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,system,extras`: differs
    - messages[6] user[string("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")] vs user[text("<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER …")]
    -     messages[6].content: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT… vs [{"type":"text","text":"<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message…
- `raw`: same
- `raw@`: same

## compact

Summary (what differs, by location):

- `local`: same
- `local2`: same
- `msg`: differs; differs at system.0.text, system.2.text, system.3.text, diagnostics.previous_message_id, messages, messages[0], messages[2], messages[3], messages[4], messages[5], messages[6], messages[7], messages[8]
- `msg-extras`: differs; differs at system.0.text, diagnostics.previous_message_id, messages, messages[0], messages[1], messages[2], messages[3], messages[4], messages[5], messages[6], messages[7]
- `msg-msgid,reqid,turnpos,extras`: differs; differs at system.0.text, messages, messages[0], messages[1], messages[2], messages[3], messages[4], messages[5], messages[6], messages[7]
- `msg-msgid,reqid,turnpos,extras,model`: differs; differs at system.0.text, messages, messages[0], messages[1], messages[2], messages[3], messages[4], messages[5], messages[6], messages[7]
- `msg-msgid,reqid,turnpos,extras,toolresult,origin,system,model`: differs; differs at system.2.text, system.3.text
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,model`: differs; differs at system.0.text, messages, messages[0], messages[1], messages[2], messages[3], messages[4], messages[5], messages[6], messages[7]
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model@`: differs; differs at system.2.text, system.3.text
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,system,model`: same
- `msg-msgid,reqid,turnpos,extras,wire,origin,system,model`: differs; differs at system.2.text, system.3.text
- `msg-msgid,reqid,turnpos,extras@`: differs; differs at system.0.text, messages, messages[0], messages[1], messages[2], messages[3], messages[4], messages[5], messages[6], messages[7]
- `msg-parent,msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: differs; differs at system.2.text, system.3.text
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,extras`: differs; differs at system.0.text, system.2.text, system.3.text, diagnostics.previous_message_id, messages, messages[0], messages[1], messages[2], messages[3], messages[4]
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,system,extras`: same
- `raw`: differs; differs at system.2.text, system.3.text
- `raw@`: same

Detail:

- `local`: same (the reference)
- `local2`: same
- `msg`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.1c6; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.01a; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk;"
    - system.2.text: "\nYou are an interactive agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, def… vs "\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized se…
    - system.3.text: "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the … vs "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the …
    - diagnostics.previous_message_id: "msg_011CfdkGziMYfJMsUVcuo8Cu" vs null
    - messages: 5 vs 9
    - messages[0] user[string("This session is being continued from a previous co…")] vs user[text("Reply with exactly one word: one. Do not use any t…")]
    -     messages[0].content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the c… vs [{"type":"text","text":"Reply with exactly one word: one. Do not use any tools."}]
    - messages[2] assistant[text("two")] vs assistant[text("one")]
    -     messages[2].content.0.text: "two" vs "one"
    - messages[3] user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("<local-command-caveat>The command below was run di…") + text("<command-name>/compact</command-name>\n            …") + text("<local-command-stdout>Compacted </local-command-st…") + text("PROBE-COMPACT: reply with exactly one word, no too…")] vs user[text("Reply with exactly one word: two. Do not use any t…")]
    -     messages[3].content.0.text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is stephen… vs "Reply with exactly one word: two. Do not use any tools."
    -     messages[3].content.1: {"type":"text","text":"<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's… vs undefined
    - … 14 more lines in report.json
- `msg-extras`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.1c6; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.01a; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk; cc_promp…
    - diagnostics.previous_message_id: "msg_011CfdkGziMYfJMsUVcuo8Cu" vs null
    - messages: 5 vs 8
    - messages[0] user[string("This session is being continued from a previous co…")] vs user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("Reply with exactly one word: one. Do not use any t…")]
    -     messages[0].content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the c… vs [{"type":"text","text":"<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's e…
    - messages[1] system[] vs system[string("## Bash command sandbox\nBy default, Bash commands …")]
    -     messages[1].content: [] vs "## Bash command sandbox\nBy default, Bash commands run inside an OS-level sandbox (Linux bubblewrap) applied to each command separately, no…
    - messages[2] assistant[text("two")] vs assistant[text("one")]
    -     messages[2].content.0.text: "two" vs "one"
    - messages[3] user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("<local-command-caveat>The command below was run di…") + text("<command-name>/compact</command-name>\n            …") + text("<local-command-stdout>Compacted </local-command-st…") + text("PROBE-COMPACT: reply with exactly one word, no too…")] vs user[text("Reply with exactly one word: two. Do not use any t…")]
    -     messages[3].content.0.text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is stephen… vs "Reply with exactly one word: two. Do not use any tools."
    -     messages[3].content.1: {"type":"text","text":"<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's… vs undefined
    - … 10 more lines in report.json
- `msg-msgid,reqid,turnpos,extras`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.1c6; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.01a; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id…
    - messages: 5 vs 8
    - messages[0] user[string("This session is being continued from a previous co…")] vs user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("Reply with exactly one word: one. Do not use any t…")]
    -     messages[0].content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the c… vs [{"type":"text","text":"<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's e…
    - messages[1] system[] vs system[string("## Bash command sandbox\nBy default, Bash commands …")]
    -     messages[1].content: [] vs "## Bash command sandbox\nBy default, Bash commands run inside an OS-level sandbox (Linux bubblewrap) applied to each command separately, no…
    - messages[2] assistant[text("two")] vs assistant[text("one")]
    -     messages[2].content.0.text: "two" vs "one"
    - messages[3] user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("<local-command-caveat>The command below was run di…") + text("<command-name>/compact</command-name>\n            …") + text("<local-command-stdout>Compacted </local-command-st…") + text("PROBE-COMPACT: reply with exactly one word, no too…")] vs user[text("Reply with exactly one word: two. Do not use any t…")]
    -     messages[3].content.0.text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is stephen… vs "Reply with exactly one word: two. Do not use any tools."
    -     messages[3].content.1: {"type":"text","text":"<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's… vs undefined
    -     messages[3].content.2: {"type":"text","text":"<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output… vs undefined
    - … 9 more lines in report.json
- `msg-msgid,reqid,turnpos,extras,model`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.1c6; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.01a; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id…
    - messages: 5 vs 8
    - messages[0] user[string("This session is being continued from a previous co…")] vs user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("Reply with exactly one word: one. Do not use any t…")]
    -     messages[0].content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the c… vs [{"type":"text","text":"<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's e…
    - messages[1] system[] vs system[string("## Bash command sandbox\nBy default, Bash commands …")]
    -     messages[1].content: [] vs "## Bash command sandbox\nBy default, Bash commands run inside an OS-level sandbox (Linux bubblewrap) applied to each command separately, no…
    - messages[2] assistant[text("two")] vs assistant[text("one")]
    -     messages[2].content.0.text: "two" vs "one"
    - messages[3] user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("<local-command-caveat>The command below was run di…") + text("<command-name>/compact</command-name>\n            …") + text("<local-command-stdout>Compacted </local-command-st…") + text("PROBE-COMPACT: reply with exactly one word, no too…")] vs user[text("Reply with exactly one word: two. Do not use any t…")]
    -     messages[3].content.0.text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is stephen… vs "Reply with exactly one word: two. Do not use any tools."
    -     messages[3].content.1: {"type":"text","text":"<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's… vs undefined
    -     messages[3].content.2: {"type":"text","text":"<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output… vs undefined
    - … 9 more lines in report.json
- `msg-msgid,reqid,turnpos,extras,toolresult,origin,system,model`: differs
    - system.2.text: "\nYou are an interactive agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, def… vs "\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized se…
    - system.3.text: "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the … vs "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the …
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,model`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.1c6; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.01a; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id…
    - messages: 5 vs 8
    - messages[0] user[string("This session is being continued from a previous co…")] vs user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("Reply with exactly one word: one. Do not use any t…")]
    -     messages[0].content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the c… vs [{"type":"text","text":"<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's e…
    - messages[1] system[] vs system[string("## Bash command sandbox\nBy default, Bash commands …")]
    -     messages[1].content: [] vs "## Bash command sandbox\nBy default, Bash commands run inside an OS-level sandbox (Linux bubblewrap) applied to each command separately, no…
    - messages[2] assistant[text("two")] vs assistant[text("one")]
    -     messages[2].content.0.text: "two" vs "one"
    - messages[3] user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("<local-command-caveat>The command below was run di…") + text("<command-name>/compact</command-name>\n            …") + text("<local-command-stdout>Compacted </local-command-st…") + text("PROBE-COMPACT: reply with exactly one word, no too…")] vs user[text("Reply with exactly one word: two. Do not use any t…")]
    -     messages[3].content.0.text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is stephen… vs "Reply with exactly one word: two. Do not use any tools."
    -     messages[3].content.1: {"type":"text","text":"<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's… vs undefined
    -     messages[3].content.2: {"type":"text","text":"<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output… vs undefined
    - … 9 more lines in report.json
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: same
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model@`: differs
    - system.2.text: "\nYou are an interactive agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, def… vs "\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized se…
    - system.3.text: "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the … vs "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the …
- `msg-msgid,reqid,turnpos,extras,toolresult,wire,system,model`: same
- `msg-msgid,reqid,turnpos,extras,wire,origin,system,model`: differs
    - system.2.text: "\nYou are an interactive agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, def… vs "\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized se…
    - system.3.text: "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the … vs "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the …
- `msg-msgid,reqid,turnpos,extras@`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.1c6; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.01a; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id…
    - messages: 5 vs 8
    - messages[0] user[string("This session is being continued from a previous co…")] vs user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("Reply with exactly one word: one. Do not use any t…")]
    -     messages[0].content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the c… vs [{"type":"text","text":"<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's e…
    - messages[1] system[] vs system[string("## Bash command sandbox\nBy default, Bash commands …")]
    -     messages[1].content: [] vs "## Bash command sandbox\nBy default, Bash commands run inside an OS-level sandbox (Linux bubblewrap) applied to each command separately, no…
    - messages[2] assistant[text("two")] vs assistant[text("one")]
    -     messages[2].content.0.text: "two" vs "one"
    - messages[3] user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("<local-command-caveat>The command below was run di…") + text("<command-name>/compact</command-name>\n            …") + text("<local-command-stdout>Compacted </local-command-st…") + text("PROBE-COMPACT: reply with exactly one word, no too…")] vs user[text("Reply with exactly one word: two. Do not use any t…")]
    -     messages[3].content.0.text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is stephen… vs "Reply with exactly one word: two. Do not use any tools."
    -     messages[3].content.1: {"type":"text","text":"<system-reminder>\nAttribution for git commits and pull requests you create from here on (this replaces Claude Code's… vs undefined
    -     messages[3].content.2: {"type":"text","text":"<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output… vs undefined
    - … 9 more lines in report.json
- `msg-parent,msgid,reqid,turnpos,extras,toolresult,wire,origin,system,model`: differs
    - system.2.text: "\nYou are an interactive agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, def… vs "\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized se…
    - system.3.text: "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the … vs "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the …
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,extras`: differs
    - system.0.text: "x-anthropic-billing-header: cc_version=2.1.285.1c6; cc_entrypoint=sdk-ts; cch=00000; cc_prev_req=req_011CfdkGzLnHziMySHZbf19w; cc_prompt_id… vs "x-anthropic-billing-header: cc_version=2.1.285.1c6; cc_entrypoint=sdk-ts; cch=00000; cc_prompt_id=<PROMPT_ID>; cc_turn_origin=sdk; cc_promp…
    - system.2.text: "\nYou are an interactive agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, def… vs "\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized se…
    - system.3.text: "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the … vs "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the …
    - diagnostics.previous_message_id: "msg_011CfdkGziMYfJMsUVcuo8Cu" vs null
    - messages: 5 vs 2
    - messages[0] user[string("This session is being continued from a previous co…")] vs user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("This session is being continued from a previous co…") + text("<local-command-caveat>The command below was run di…") + text("<command-name>/compact</command-name>\n            …") + text("<local-command-stdout>Compacted </local-command-st…") + text("PROBE-COMPACT: reply with exactly one word, no too…")]
    -     messages[0].content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the c… vs [{"type":"text","text":"<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\nThe user's e…
    - messages[1] system[] vs system[text+cc("The following deferred tools are now available via…")]
    -     messages[1].content.0: undefined vs {"type":"text","text":"The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly w…
    - messages[2] assistant[text("two")] vs (none)
    -     messages[2]: {"role":"assistant","content":[{"type":"text","text":"two"}]} vs undefined
    - messages[3] user[text("<system-reminder>\nAs you answer the user's questio…") + text("<system-reminder>\nAttribution for git commits and …") + text("<local-command-caveat>The command below was run di…") + text("<command-name>/compact</command-name>\n            …") + text("<local-command-stdout>Compacted </local-command-st…") + text("PROBE-COMPACT: reply with exactly one word, no too…")] vs (none)
    - … 3 more lines in report.json
- `msg-parent,time,msgid,model,reqid,turnpos,promptmeta,envelope,msgmeta,origin,toolresult,wire,asstmeta,system,extras`: same
- `raw`: differs
    - system.2.text: "\nYou are an interactive agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, def… vs "\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized se…
    - system.3.text: "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the … vs "Write code that reads like the surrounding code: match its comment density, naming, and idiom.\n\nWhen you use a pronoun for someone — the …
- `raw@`: same

