# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- An agent displaced from a conversation no longer clears the standing attachment when it releases its own superseded claim, so clients keep showing the agent that actually holds the conversation.
- Attachments in the connect snapshot arrive oldest first, so a client reconnecting mid-handover settles on the claim that stands rather than whichever one the database happened to return first.
