export type PiExtensionSourceKind = 'package' | 'local'

export interface PiExtensionSourceView {
  kind: PiExtensionSourceKind
  source: string
  enabled: boolean
}

export interface PiExtensionConfigurationView {
  agentDir: string
  settingsPath: string
  sources: PiExtensionSourceView[]
  error?: string
}

export interface AddPiExtensionSourceInput {
  kind: PiExtensionSourceKind
  source: string
}

export interface PiExtensionSourceMutationInput extends AddPiExtensionSourceInput {}

export interface SetPiExtensionSourceEnabledInput extends PiExtensionSourceMutationInput {
  enabled: boolean
}

export interface PiExtensionConfigurationApi {
  getConfiguration(): Promise<PiExtensionConfigurationView>
  addSource(input: AddPiExtensionSourceInput): Promise<PiExtensionConfigurationView>
  setSourceEnabled(input: SetPiExtensionSourceEnabledInput): Promise<PiExtensionConfigurationView>
  removeSource(input: PiExtensionSourceMutationInput): Promise<PiExtensionConfigurationView>
}
