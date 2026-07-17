fn main() -> Result<(), Box<dyn std::error::Error>> {
    std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path()?);
    tonic_prost_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(&["../proto/bytemap.proto"], &["../proto"])?;
    println!("cargo:rerun-if-changed=../proto/bytemap.proto");
    Ok(())
}
