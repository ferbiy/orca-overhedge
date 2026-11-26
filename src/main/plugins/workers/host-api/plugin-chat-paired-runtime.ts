/** overhedge: `chat.list` / `chat.send` on a paired Orca server, through the same transport the
 *  desktop window uses for that server's chats (`runtimeEnvironments:call`). Imported lazily, so the
 *  host-api bindings stay free of Electron for headless serve and the relay conformance suite. */

export type PairedRuntimeCall = (
  environmentId: string,
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; background?: boolean }
) => Promise<unknown>

export type PairedRuntimeHosts = {
  /** The paired Orca servers this desktop has saved, as `runtime:<id>` hosts; ones the person
   *  disconnected in Orca are left out. */
  hostIds(): Promise<string[]>
  call: PairedRuntimeCall
  /** The server's name as the person paired it; null when Orca no longer has it. */
  label(environmentId: string): Promise<string | null>
}

export class PairedRuntimeCallError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

async function transport() {
  const [routing, root, disconnect, store] = await Promise.all([
    import('../../../ipc/runtime-environments/requests/runtime-environment-transport-routing'),
    import('../../../ipc/runtime-environments/catalog/runtime-environment-registry-root'),
    import('../../../ipc/runtime-environments/connectivity/runtime-environment-manual-disconnect'),
    import('../../../../shared/remote-runtime/host-store/runtime-environment-store')
  ])
  return { ...routing, ...root, ...disconnect, ...store }
}

export const desktopPairedRuntimeHosts: PairedRuntimeHosts = {
  async hostIds() {
    const t = await transport()
    return (await t.listEnvironments(t.getRuntimeEnvironmentRegistryRoot()))
      .filter((environment) => !t.isRuntimeEnvironmentManuallyDisconnected(environment.id))
      .map((environment) => `runtime:${environment.id}`)
  },
  async call(environmentId, method, params, options = {}) {
    const t = await transport()
    // The person disconnected this server in Orca: a plugin must not reconnect it.
    if (t.isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
      throw new PairedRuntimeCallError('client_disconnected', 'disconnected in Orca')
    }
    const response = await t.callRuntimeEnvironment(
      t.getRuntimeEnvironmentRegistryRoot(),
      environmentId,
      method,
      params,
      options.timeoutMs,
      undefined,
      undefined,
      options.background ? { background: true } : undefined
    )
    if (response.ok === true) {
      return response.result
    }
    throw new PairedRuntimeCallError(response.error.code, response.error.message)
  },
  async label(environmentId) {
    const t = await transport()
    try {
      return (await t.resolveEnvironment(t.getRuntimeEnvironmentRegistryRoot(), environmentId)).name
    } catch {
      return null
    }
  }
}
