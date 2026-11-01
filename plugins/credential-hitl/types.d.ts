// Minimal ambient types for local typechecking only (`bun x tsc --noEmit`).
// The real types come from the `@opencode/plugin` package inside OpenCode at
// runtime; this shim mirrors only the surface this plugin uses. See
// https://opencode.ai/v2/docs/build/plugins/server for the authoritative API.
// The plugin runs inside the OpenCode server (Node/Bun); only process.env is used.
declare const process: { env: Record<string, string | undefined> }

declare module "@opencode/plugin" {
  export interface ToolExecutionContext {
    sessionID: string
    agent?: string
    messageID: string
    id: string
    signal: AbortSignal
    progress(update: { status?: string }): Promise<void>
  }

  export interface ToolDefinition {
    name: string
    description: string
    input: {
      type: "object"
      properties: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
    options?: { namespace?: string; codemode?: boolean }
    execute(input: unknown, context: ToolExecutionContext): Promise<{ content: string }> | { content: string }
  }

  export interface ToolEditor {
    add(tool: ToolDefinition): void
    update(id: string, update: (tool: ToolDefinition) => void): void
    remove(id: string): void
  }

  export interface PermissionSource {
    type: "tool"
    messageID: string
    id: string
  }

  export interface PermissionContext {
    assert(input: {
      sessionID: string
      agent?: string
      source?: PermissionSource
      action: string
      resources: string[]
      save?: string[]
      metadata?: Record<string, unknown>
    }): Promise<void>
    list(input: { sessionID: string }): Promise<unknown>
    reply(input: {
      sessionID: string
      requestID: string
      decision: "once" | "always" | "reject"
    }): Promise<void>
  }

  export interface PluginContext {
    options: Record<string, unknown>
    tool: {
      transform(callback: (editor: ToolEditor) => void): Promise<{ dispose(): Promise<void> }>
    }
    permission: PermissionContext
  }

  export interface PluginDefinition {
    id: string
    setup(ctx: PluginContext): Promise<void | (() => void)> | void | (() => void)
  }

  export const Plugin: {
    define(definition: PluginDefinition): PluginDefinition
  }
}
