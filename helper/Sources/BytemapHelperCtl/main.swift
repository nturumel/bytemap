import Foundation
import ServiceManagement

let helperMachServiceName = "com.niharturumella.bytemap.helper"
let helperPlistName = "com.niharturumella.bytemap.helper"

@objc protocol HelperProtocol {
  func ping(reply: @escaping (Bool) -> Void)
  func trashPaths(_ paths: [String], reply: @escaping ([String]) -> Void)
  func removePaths(_ paths: [String], reply: @escaping ([String]) -> Void)
}

enum CtlError: Error, CustomStringConvertible {
  case usage
  case connect(String)
  case register(String)

  var description: String {
    switch self {
    case .usage:
      return "Usage: BytemapHelperCtl status|register|trash <paths…>|remove <paths…>"
    case .connect(let message), .register(let message):
      return message
    }
  }
}

final class Box<T> {
  var value: T?
  var error: Error?
}

func statusString() -> String {
  let service = SMAppService.daemon(plistName: helperPlistName)
  switch service.status {
  case .enabled: return "enabled"
  case .requiresApproval: return "requiresApproval"
  case .notRegistered: return "notRegistered"
  case .notFound: return "unavailable"
  @unknown default: return "unavailable"
  }
}

func registerHelper() throws {
  let service = SMAppService.daemon(plistName: helperPlistName)
  do {
    try service.register()
  } catch {
    throw CtlError.register(error.localizedDescription)
  }
}

func connect() -> NSXPCConnection {
  let connection = NSXPCConnection(machServiceName: helperMachServiceName, options: .privileged)
  connection.remoteObjectInterface = NSXPCInterface(with: HelperProtocol.self)
  connection.resume()
  return connection
}

func callHelper(_ invoke: (HelperProtocol, @escaping ([String]) -> Void) -> Void) throws -> [String] {
  let connection = connect()
  defer { connection.invalidate() }

  let box = Box<[String]>()
  let semaphore = DispatchSemaphore(value: 0)

  guard
    let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
      box.error = error
      semaphore.signal()
    }) as? HelperProtocol
  else {
    throw CtlError.connect("Could not create helper proxy")
  }

  invoke(proxy) { lines in
    box.value = lines
    semaphore.signal()
  }

  if semaphore.wait(timeout: .now() + 120) == .timedOut {
    throw CtlError.connect("Timed out waiting for privileged helper")
  }
  if let error = box.error {
    throw CtlError.connect(error.localizedDescription)
  }
  return box.value ?? []
}

func main() throws {
  let args = Array(CommandLine.arguments.dropFirst())
  guard let command = args.first else { throw CtlError.usage }

  switch command {
  case "status":
    print(statusString())
  case "register":
    try registerHelper()
    Thread.sleep(forTimeInterval: 0.5)
    print(statusString())
  case "trash":
    let paths = Array(args.dropFirst())
    guard !paths.isEmpty else { throw CtlError.usage }
    let lines = try callHelper { proxy, reply in
      proxy.trashPaths(paths, reply: reply)
    }
    for line in lines { print(line) }
    if lines.contains(where: { $0.hasPrefix("FAIL:") }) { exit(1) }
  case "remove":
    let paths = Array(args.dropFirst())
    guard !paths.isEmpty else { throw CtlError.usage }
    let lines = try callHelper { proxy, reply in
      proxy.removePaths(paths, reply: reply)
    }
    for line in lines { print(line) }
    if lines.contains(where: { $0.hasPrefix("FAIL:") }) { exit(1) }
  case "ping":
    let connection = connect()
    defer { connection.invalidate() }
    let box = Box<Bool>()
    let semaphore = DispatchSemaphore(value: 0)
    guard
      let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
        box.error = error
        semaphore.signal()
      }) as? HelperProtocol
    else {
      throw CtlError.connect("Could not create helper proxy")
    }
    proxy.ping { ok in
      box.value = ok
      semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 10)
    if let error = box.error { throw CtlError.connect(error.localizedDescription) }
    print(box.value == true ? "pong" : "fail")
  default:
    throw CtlError.usage
  }
}

do {
  try main()
} catch {
  fputs("\(error)\n", stderr)
  exit(1)
}
