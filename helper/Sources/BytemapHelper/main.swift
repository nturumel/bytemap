import Foundation
import Security
import SystemConfiguration

let helperMachServiceName = "com.niharturumella.bytemap.helper"

private let allowedClientIdentifiers: Set<String> = [
  "com.niharturumella.bytemap.helper.ctl",
  "com.niharturumella.bytemap"
]

/// Paths the helper will never touch (SIP / OS-critical).
private let deniedPrefixes = [
  "/System",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/libexec",
  "/private/var/db",
  "/dev"
]

@objc protocol HelperProtocol {
  func ping(reply: @escaping (Bool) -> Void)
  func trashPaths(_ paths: [String], reply: @escaping ([String]) -> Void)
  func removePaths(_ paths: [String], reply: @escaping ([String]) -> Void)
}

final class HelperService: NSObject, HelperProtocol {
  func ping(reply: @escaping (Bool) -> Void) {
    reply(true)
  }

  func trashPaths(_ paths: [String], reply: @escaping ([String]) -> Void) {
    reply(paths.map { trashOne($0) })
  }

  func removePaths(_ paths: [String], reply: @escaping ([String]) -> Void) {
    reply(paths.map { removeOne($0) })
  }

  private func validatePath(_ path: String) -> String? {
    let resolved = (path as NSString).standardizingPath
    if resolved.isEmpty || resolved == "/" {
      return "Refused empty or root path"
    }
    for prefix in deniedPrefixes {
      if resolved == prefix || resolved.hasPrefix(prefix + "/") {
        return "Refused protected path"
      }
    }
    if resolved == "/usr" || (resolved.hasPrefix("/usr/") && !resolved.hasPrefix("/usr/local")) {
      return "Refused protected path"
    }
    return nil
  }

  private func consoleUserHome() -> String? {
    var uid: uid_t = 0
    guard let name = SCDynamicStoreCopyConsoleUser(nil, &uid, nil) as String? else { return nil }
    return NSHomeDirectoryForUser(name)
  }

  private func uniqueTrashDestination(trashDir: String, name: String) -> String {
    var candidate = (trashDir as NSString).appendingPathComponent(name)
    if !FileManager.default.fileExists(atPath: candidate) { return candidate }
    let ns = name as NSString
    let ext = ns.pathExtension
    let stem = ext.isEmpty ? name : ns.deletingPathExtension
    var n = 1
    repeat {
      let leaf = ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)"
      candidate = (trashDir as NSString).appendingPathComponent(leaf)
      n += 1
    } while FileManager.default.fileExists(atPath: candidate)
    return candidate
  }

  private func trashOne(_ path: String) -> String {
    if let err = validatePath(path) { return "FAIL:\(path):\(err)" }
    guard let home = consoleUserHome() else {
      return "FAIL:\(path):Could not resolve console user home"
    }
    let trashDir = (home as NSString).appendingPathComponent(".Trash")
    do {
      try FileManager.default.createDirectory(atPath: trashDir, withIntermediateDirectories: true)
      let dest = uniqueTrashDestination(
        trashDir: trashDir,
        name: (path as NSString).lastPathComponent
      )
      try FileManager.default.moveItem(atPath: path, toPath: dest)
      return "OK:\(path)"
    } catch {
      return "FAIL:\(path):\(error.localizedDescription)"
    }
  }

  private func removeOne(_ path: String) -> String {
    if let err = validatePath(path) { return "FAIL:\(path):\(err)" }
    do {
      try FileManager.default.removeItem(atPath: path)
      return "OK:\(path)"
    } catch {
      return "FAIL:\(path):\(error.localizedDescription)"
    }
  }
}

func clientIsAllowed(_ connection: NSXPCConnection) -> Bool {
  var code: SecCode?
  var err = SecCodeCopyGuestWithAttributes(
    nil,
    [kSecGuestAttributePid: connection.processIdentifier] as CFDictionary,
    SecCSFlags(),
    &code
  )
  guard err == errSecSuccess, let code else { return false }

  var staticCode: SecStaticCode?
  err = SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode)
  guard err == errSecSuccess, let staticCode else { return false }

  var info: CFDictionary?
  err = SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info)
  let dict = info as? [String: Any]

  if let identifier = dict?["identifier"] as? String, allowedClientIdentifiers.contains(identifier) {
    return true
  }

  // Unsigned local builds: only accept the companion ctl binary by path leaf.
  var path: CFURL?
  if SecCodeCopyPath(staticCode, SecCSFlags(), &path) == errSecSuccess,
    let path,
    let url = path as URL?
  {
    let leaf = url.lastPathComponent
    if leaf == "BytemapHelperCtl" { return true }
  }

  return false
}

final class HelperDelegate: NSObject, NSXPCListenerDelegate {
  func listener(_ listener: NSXPCListener, shouldAcceptNewConnection newConnection: NSXPCConnection)
    -> Bool
  {
    guard clientIsAllowed(newConnection) else { return false }
    newConnection.exportedInterface = NSXPCInterface(with: HelperProtocol.self)
    newConnection.exportedObject = HelperService()
    newConnection.resume()
    return true
  }
}

let delegate = HelperDelegate()
let listener = NSXPCListener(machServiceName: helperMachServiceName)
listener.delegate = delegate
listener.resume()
RunLoop.main.run()
