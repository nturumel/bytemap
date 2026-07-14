// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "BytemapHelper",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "BytemapHelper", targets: ["BytemapHelper"]),
    .executable(name: "BytemapHelperCtl", targets: ["BytemapHelperCtl"])
  ],
  targets: [
    .executableTarget(
      name: "BytemapHelper",
      path: "Sources/BytemapHelper"
    ),
    .executableTarget(
      name: "BytemapHelperCtl",
      path: "Sources/BytemapHelperCtl"
    )
  ]
)
