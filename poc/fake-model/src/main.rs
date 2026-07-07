use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let listener = TcpListener::bind("0.0.0.0:8090").await?;
    eprintln!("fake-model: listening on 0.0.0.0:8090");
    axum::serve(listener, fake_model::server::router()).await?;
    Ok(())
}
