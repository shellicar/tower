# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- The `m` command sets the model name on its own and leaves max tokens, thinking and effort as configured. The `j` paste command is how the rest of the model configuration is set.

### Fixed

- A `-c` configuration batch is applied before the conversation is created, so the model it configures is the one the conversation gets. Launching with no configuration at all now refuses to start rather than falling back to a built-in model.
