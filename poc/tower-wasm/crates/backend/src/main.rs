//! Wiring only: parse args, construct, run.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = backend::Config::from_args(std::env::args().skip(1))?;
    backend::run(config).await
}
