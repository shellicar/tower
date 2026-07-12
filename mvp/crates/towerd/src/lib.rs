//! towerd's components as a library so the integration check can compose
//! them in-process; `main.rs` is the thin binary over this.

pub mod broker;
pub mod gateway;
pub mod ingest;
pub mod refs;
pub mod views;
pub mod web;
pub mod ws;
