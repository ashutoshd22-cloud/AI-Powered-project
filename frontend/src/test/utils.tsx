import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { SyncContext } from '../app/SyncContext'
import { ToastProvider } from '../components/Toast'
import type { SyncOp, SyncOpResult, Task } from '../lib/types'
import { SyncEngine, type Transport } from '../offline/syncEngine'

/** Transport that accepts every op and echoes a server copy (enough for UI tests). */
export class EchoTransport implements Transport {
  pushed: Omit<SyncOp, 'seq'>[] = []
  async push(ops: Omit<SyncOp, 'seq'>[]): Promise<SyncOpResult[]> {
    this.pushed.push(...ops)
    return ops.map((op) => ({ op_id: op.op_id, status: 'applied', task: null, error: null }))
  }
  async pull() {
    return { tasks: [] as Task[], has_more: false, next: null, cursor: new Date().toISOString(), reset_required: false }
  }
}

let counter = 0
export async function makeEngine(transport: Transport = new EchoTransport()) {
  const engine = new SyncEngine(`test-${Date.now()}-${++counter}`, transport)
  await engine.init()
  return engine
}

export function renderWithProviders(ui: ReactElement, engine: SyncEngine) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <SyncContext.Provider value={engine}>
          <MemoryRouter>{ui}</MemoryRouter>
        </SyncContext.Provider>
      </ToastProvider>
    </QueryClientProvider>,
  )
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
