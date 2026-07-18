import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { OmpProviderId, OmpProviderSummary } from '@shared/types'
import { discoverAuthStorage } from '@oh-my-pi/pi-coding-agent/sdk'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import type { AuthStorage } from '@oh-my-pi/pi-coding-agent/session/auth-storage'

const PROVIDERS: {
  id: OmpProviderId
  label: string
  authKind: OmpProviderSummary['authKind']
  envVars: string[]
}[] = [
  {
    id: 'anthropic',
    label: 'Claude',
    authKind: 'oauth',
    envVars: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
  },
  {
    id: 'openai-codex',
    label: 'OpenAI Codex',
    authKind: 'oauth',
    envVars: ['OPENAI_CODEX_OAUTH_TOKEN']
  },
  { id: 'openai', label: 'OpenAI API', authKind: 'apiKey', envVars: ['OPENAI_API_KEY'] },
  { id: 'google', label: 'Google Gemini API', authKind: 'apiKey', envVars: ['GEMINI_API_KEY'] },
  { id: 'google-gemini-cli', label: 'Gemini CLI OAuth', authKind: 'oauth', envVars: [] },
  { id: 'google-antigravity', label: 'Google Antigravity OAuth', authKind: 'oauth', envVars: [] },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    authKind: 'oauth',
    envVars: ['COPILOT_GITHUB_TOKEN']
  },
  { id: 'cursor', label: 'Cursor', authKind: 'oauth', envVars: ['CURSOR_ACCESS_TOKEN'] },
  {
    id: 'ollama',
    label: 'Ollama',
    authKind: 'local',
    envVars: ['OLLAMA_BASE_URL', 'OLLAMA_HOST', 'OLLAMA_API_KEY']
  },
  {
    id: 'lm-studio',
    label: 'LM Studio',
    authKind: 'local',
    envVars: ['LM_STUDIO_BASE_URL', 'LM_STUDIO_API_KEY']
  },
  {
    id: 'llama.cpp',
    label: 'llama.cpp',
    authKind: 'local',
    envVars: ['LLAMA_CPP_BASE_URL', 'LLAMA_CPP_API_KEY']
  }
]

type Model = ReturnType<ModelRegistry['getAll']>[number]

type AgentSettings = {
  selectedModelId?: string | null
}

export type OmpProviderSnapshot = {
  providers: OmpProviderSummary[]
  selectedModelId: string | null
}

export class OmpBackendProviderAuthManager {
  private authStorage: AuthStorage | null = null
  private modelRegistry: ModelRegistry | null = null
  private selectedModelId: string | null = null
  readonly userData = requiredEnv('BYTEMAP_USER_DATA')
  readonly realHome = requiredEnv('BYTEMAP_REAL_HOME')
  readonly authAgentDir = join(this.realHome, '.omp', 'agent')
  private readonly settingsPath = join(this.userData, 'agent-settings.json')

  async init(apiKeys: Record<string, string> = {}): Promise<void> {
    await mkdir(this.authAgentDir, { recursive: true, mode: 0o700 })
    this.authStorage = await discoverAuthStorage(this.authAgentDir)
    this.applyRuntimeApiKeys(apiKeys)
    this.modelRegistry = new ModelRegistry(this.authStorage)
    await this.refresh()
    this.selectedModelId = await this.readSelectedModelId()
    await this.validateSelectedModel()
  }

  async syncApiKeys(apiKeys: Record<string, string>): Promise<OmpProviderSnapshot> {
    await this.ensureInitialized()
    this.applyRuntimeApiKeys(apiKeys)
    await this.refresh()
    await this.validateSelectedModel()
    return this.snapshot()
  }

  getAuthStorage(): AuthStorage {
    if (!this.authStorage) throw new Error('OMP provider auth is not initialized')
    return this.authStorage
  }

  getModelRegistry(): ModelRegistry {
    if (!this.modelRegistry) throw new Error('OMP model registry is not initialized')
    return this.modelRegistry
  }

  getSelectedModel(): Model | null {
    if (!this.selectedModelId) return null
    return this.findModel(this.selectedModelId)
  }

  getSelectedModelId(): string | null {
    return this.selectedModelId
  }

  async providers(): Promise<OmpProviderSnapshot> {
    await this.ensureInitialized()
    await this.refresh()
    await this.validateSelectedModel()
    return this.snapshot()
  }

  async loginProvider(
    providerId: string,
    onAuthUrl: (url: string) => void
  ): Promise<OmpProviderSnapshot> {
    await this.ensureInitialized()
    const provider = providerDefinition(providerId)
    if (!provider || provider.authKind !== 'oauth')
      throw new Error(`${providerId} does not support OAuth login`)
    await this.getAuthStorage().login(providerId as never, {
      onAuth: ({ url }) => onAuthUrl(url),
      onProgress: (message) => process.stdout.write(`[omp-auth] ${message}\n`),
      // OpenAI Codex races its localhost browser callback against an optional manual-code
      // fallback. Rejecting this prompt makes OMP retry it in a tight loop and starves the
      // gRPC auth-url event. Keep the fallback pending; the browser callback remains active.
      onPrompt: () => new Promise<string>(() => undefined)
    })
    await this.refresh()
    return this.snapshot()
  }

  async setProviderApiKey(providerId: string, apiKey: string): Promise<OmpProviderSnapshot> {
    await this.ensureInitialized()
    const provider = providerDefinition(providerId)
    if (!provider || provider.authKind !== 'apiKey')
      throw new Error(`${providerId} does not accept an API key in Bytemap`)
    const trimmed = apiKey.trim()
    if (!trimmed) throw new Error('API key is empty')
    this.getAuthStorage().setRuntimeApiKey(providerId, trimmed)
    await this.refresh()
    return this.snapshot()
  }

  async logoutProvider(providerId: string): Promise<OmpProviderSnapshot> {
    await this.ensureInitialized()
    const provider = providerDefinition(providerId)
    if (provider?.authKind === 'apiKey') {
      this.getAuthStorage().removeRuntimeApiKey(providerId)
    } else if (provider?.authKind === 'oauth') {
      await this.getAuthStorage().logout(providerId)
    } else if (provider?.authKind === 'local') {
      // Local providers have no app-owned credential to remove.
    } else {
      throw new Error(`Unknown provider: ${providerId}`)
    }
    if (this.selectedModelId?.startsWith(`${providerId}/`)) {
      this.selectedModelId = null
      await this.writeSettings({ selectedModelId: null })
    }
    await this.refresh()
    // Skip auto-select so logout reliably returns the UI to the provider picker.
    return { providers: this.buildProviderSummaries(), selectedModelId: this.selectedModelId }
  }

  async selectModel(modelId: string): Promise<void> {
    await this.ensureInitialized()
    await this.refresh()
    if (!this.findModel(modelId)) throw new Error(`OMP model is not available: ${modelId}`)
    this.selectedModelId = modelId
    await this.writeSettings({ selectedModelId: modelId })
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.authStorage || !this.modelRegistry) await this.init()
  }

  private applyRuntimeApiKeys(apiKeys: Record<string, string>): void {
    for (const providerId of PROVIDERS.filter((provider) => provider.authKind === 'apiKey').map(
      (provider) => provider.id
    )) {
      this.authStorage?.removeRuntimeApiKey(providerId)
    }
    for (const [providerId, apiKey] of Object.entries(apiKeys)) {
      if (apiKey) this.authStorage?.setRuntimeApiKey(providerId, apiKey)
    }
  }

  private async refresh(): Promise<void> {
    await this.modelRegistry?.refresh()
  }

  private snapshot(): OmpProviderSnapshot {
    const providers = this.buildProviderSummaries()
    if (!this.selectedModelId) {
      const models = providers.flatMap((provider) => provider.models)
      if (models.length === 1) {
        this.selectedModelId = models[0]!.id
        void this.writeSettings({ selectedModelId: this.selectedModelId })
      }
    }
    return { providers: this.buildProviderSummaries(), selectedModelId: this.selectedModelId }
  }

  private buildProviderSummaries(): OmpProviderSummary[] {
    const registry = this.getModelRegistry()
    const availableModels = registry.getAvailable()
    return PROVIDERS.map((provider) => {
      const models = availableModels
        .filter((model) => model.provider === provider.id)
        .map((model) => {
          const id = modelKey(model)
          return {
            id,
            label: model.name || model.id,
            provider: model.provider,
            selected: id === this.selectedModelId
          }
        })
      const discoveryStatus = registry.getProviderDiscoveryState(provider.id)?.status
      const hasAuth = this.getAuthStorage().hasAuth(provider.id)
      const status: OmpProviderSummary['status'] = models.length
        ? 'available'
        : provider.authKind === 'local'
          ? discoveryStatus === 'unavailable' || discoveryStatus === 'empty' || !models.length
            ? 'localUnavailable'
            : 'available'
          : provider.authKind === 'apiKey'
            ? hasAuth
              ? 'available'
              : 'needsApiKey'
            : hasAuth
              ? 'available'
              : 'needsLogin'
      return {
        id: provider.id,
        label: provider.label,
        authKind: provider.authKind,
        status,
        envVars: provider.envVars,
        models,
        loginSupported: provider.authKind === 'oauth',
        logoutSupported: provider.authKind === 'oauth' || provider.authKind === 'apiKey'
      }
    })
  }

  private findModel(modelId: string): Model | null {
    const registry = this.getModelRegistry()
    return registry.getAvailable().find((model) => modelKey(model) === modelId) ?? null
  }

  private async validateSelectedModel(): Promise<void> {
    if (!this.selectedModelId) return
    if (this.findModel(this.selectedModelId)) return
    this.selectedModelId = null
    await this.writeSettings({ selectedModelId: null })
  }

  private async readSelectedModelId(): Promise<string | null> {
    try {
      const settings = JSON.parse(await readFile(this.settingsPath, 'utf8')) as AgentSettings
      return typeof settings.selectedModelId === 'string' ? settings.selectedModelId : null
    } catch {
      return null
    }
  }

  private async writeSettings(settings: AgentSettings): Promise<void> {
    await writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  }
}

function providerDefinition(providerId: string): (typeof PROVIDERS)[number] | undefined {
  return PROVIDERS.find((provider) => provider.id === providerId)
}

function modelKey(model: Pick<Model, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for Bytemap agent backend`)
  return value
}
