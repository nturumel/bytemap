import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

type CredentialFile = Record<string, string>

export class AgentCredentialStore {
  private readonly ompHome = join(app.getPath('userData'), 'omp-home')
  private readonly credentialsPath = join(this.ompHome, 'provider-credentials.json')

  async readApiKeys(): Promise<Record<string, string>> {
    const encrypted = await this.readCredentialFile()
    const apiKeys: Record<string, string> = {}
    for (const [providerId, value] of Object.entries(encrypted)) {
      apiKeys[providerId] = safeStorage.decryptString(Buffer.from(value, 'base64'))
    }
    return apiKeys
  }

  async writeApiKey(providerId: string, apiKey: string): Promise<Record<string, string>> {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Electron safeStorage encryption is unavailable')
    const credentials = await this.readCredentialFile()
    credentials[providerId] = safeStorage.encryptString(apiKey).toString('base64')
    await this.writeCredentialFile(credentials)
    return this.readApiKeys()
  }

  async removeApiKey(providerId: string): Promise<Record<string, string>> {
    const credentials = await this.readCredentialFile()
    delete credentials[providerId]
    await this.writeCredentialFile(credentials)
    return this.readApiKeys()
  }

  private async readCredentialFile(): Promise<CredentialFile> {
    try {
      return JSON.parse(await readFile(this.credentialsPath, 'utf8')) as CredentialFile
    } catch {
      return {}
    }
  }

  private async writeCredentialFile(credentials: CredentialFile): Promise<void> {
    await mkdir(this.ompHome, { recursive: true, mode: 0o700 })
    await writeFile(this.credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600
    })
  }
}
