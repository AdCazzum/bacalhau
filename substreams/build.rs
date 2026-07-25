use substreams_ethereum::Abigen;

fn main() -> Result<(), anyhow::Error> {
    // Ethereum event bindings from the Aqua ABI.
    Abigen::new("aqua", "abi/aqua.json")?
        .generate()?
        .write_to_file("src/abi/aqua.rs")?;

    // Our own protobuf messages -> src/pb.
    prost_build::Config::new()
        .out_dir("src/pb")
        .compile_protos(&["proto/bacalhau/v1/aqua.proto"], &["proto"])?;

    Ok(())
}
