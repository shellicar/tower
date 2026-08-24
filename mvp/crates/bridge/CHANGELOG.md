# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- A world can be asked to serve a conversation over NATS: bridge answers agent.v1.{world}.requests.service, spawning, adopting, or taking over per the conversation's own attachment record, and rejects every other request leaf honestly.
- Six GitHub pull request tools, each limited to a fixed set of gh flags: creating always drafts, reviewing cannot approve, and auto-merge is only queued or cleared.
- `credentials` and `tools` control lines name credentials and bind them to tool groups.
- A `settings` request can name the system prompt or the user context to get its full text.

### Changed

- The Skill tool is offered whether or not a skills directory is set.
- The `model` control line takes an object naming the model, its max tokens, thinking mode, thinking display and effort level.
- The `settings` reply summarises the system prompt and the user context as a set flag, a byte count and a content hash.
- Writing and deleting a memory no longer raises an approval. All five memory tools now run without asking.
- The environment an Exec child runs with is composed as a whole before the child is spawned: the call's own variables, then a configured provider's removals, then its forced values. What a child ends up with is unchanged.
- An Exec call states a required timeout in whole seconds and is killed when it passes, so a command that never exits returns an ordinary tool error the agent can work around instead of blocking the turn and leaving the conversation unable to be spoken to until someone kills the process by hand. A host can bound what a call may ask for with max_timeout_s on the tools line's exec group, absent meaning no bound; a call asking for longer is refused before anything runs and the refusal names the limit, rather than being quietly reduced to it.

### Removed

- `BRIDGE_MODEL` and `BRIDGE_THINKING_BUDGET`. Bridge serves no conversation until a `model` control line names a model and a max token count.

### Fixed

- AppendFile flushes its write before returning, so a reader that opens the file immediately after the append sees the appended content instead of an empty file.
- Turns ask the messages API for adaptive thinking rather than a fixed token budget.

### Security

- Configuring a GitHub credential stops Exec children authenticating with the host's own gh login. A host that configures none is unaffected.
