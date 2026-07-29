#!/bin/sh
# open fd 3 for writing to the fifo, then exec claude — a plain shell exec
# replaces this process, so if fd 3 survives it's purely inheritance, not
# anything Rust-specific.
exec 3>./fd-test.fifo
exec claude
