const CANVAS_ENDPOINT = '/api/canvas'
const SELECTION_ENDPOINT = '/api/selection'
const VIEW_STATE_ENDPOINT = '/api/view-state'

const TOOL_GET_CANVAS_STATE = 'get_cowart_canvas_state'
const TOOL_SAVE_CANVAS_STATE = 'save_cowart_canvas_state'
const TOOL_SAVE_SELECTION_STATE = 'save_cowart_selection_state'
const TOOL_SAVE_VIEW_STATE = 'save_cowart_view_state'

globalThis.__COWART_WIDGET_FETCH_GUARD__ = true

export const IS_COWART_WIDGET_BUILD =
  typeof __COWART_WIDGET_BUILD__ !== 'undefined' && __COWART_WIDGET_BUILD__

export function hasCowartWidgetBridge() {
  return Boolean(window.cowartMcp && typeof window.cowartMcp.callServerTool === 'function')
}

function currentWidgetPayload() {
  return window.openai?.toolOutput && typeof window.openai.toolOutput === 'object'
    ? window.openai.toolOutput
    : {}
}

function serverToolArgs(extra = {}) {
  const payload = currentWidgetPayload()
  return removeUndefined({
    projectDir: payload.projectDir,
    canvasDir: payload.canvasDir,
    ...extra
  })
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([_key, item]) => item !== undefined))
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError')
}

async function waitForWidgetPayload(signal) {
  if (!hasCowartWidgetBridge()) return
  const payload = currentWidgetPayload()
  if (payload.projectDir || payload.canvasDir) return

  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    const timer = window.setTimeout(resolve, 1500)
    const cleanup = () => {
      window.clearTimeout(timer)
      window.removeEventListener('openai:set_globals', handleGlobals)
      signal?.removeEventListener('abort', handleAbort)
    }
    const finish = () => {
      cleanup()
      resolve()
    }
    const handleGlobals = () => finish()
    const handleAbort = () => {
      cleanup()
      reject(abortError())
    }

    window.addEventListener('openai:set_globals', handleGlobals, { once: true })
    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

async function callCowartServerTool(name, args = {}, options = {}) {
  await waitForWidgetPayload(options.signal)
  if (options.signal?.aborted) throw abortError()
  const result = await window.cowartMcp.callServerTool({
    name,
    arguments: serverToolArgs(args)
  })
  if (result?.isError) {
    const message = result.content?.find((item) => item.type === 'text')?.text
    throw new Error(message || `Cowart server tool failed: ${name}`)
  }
  return result.structuredContent ?? result
}

async function fetchJson(url, options = {}) {
  const response = await window.fetch(url, options)
  if (!response.ok) {
    throw new Error(`Cowart request failed: ${response.status} - ${response.statusText}`)
  }
  return response.json()
}

export async function loadCowartCanvasState(signal) {
  if (hasCowartWidgetBridge()) {
    const state = await callCowartServerTool(
      TOOL_GET_CANVAS_STATE,
      { hydrateAssets: true },
      { signal }
    )
    return {
      snapshot: state.snapshot,
      viewState: state.viewState ?? null,
      storage: state.storage,
      skippedRecords: []
    }
  }

  const [canvasData, viewStateData] = await Promise.all([
    fetchJson(CANVAS_ENDPOINT, { signal }),
    fetchJson(VIEW_STATE_ENDPOINT, { signal })
  ])
  return {
    snapshot: canvasData.snapshot,
    viewState: viewStateData.viewState ?? null,
    storage: canvasData.storage,
    skippedRecords: []
  }
}

export async function refreshCowartCanvasSnapshot(signal) {
  if (hasCowartWidgetBridge()) {
    const state = await callCowartServerTool(
      TOOL_GET_CANVAS_STATE,
      { hydrateAssets: true },
      { signal }
    )
    return state.snapshot
  }

  const canvasData = await fetchJson(CANVAS_ENDPOINT, { signal })
  return canvasData.snapshot
}

export async function saveCowartCanvasSnapshot(snapshot) {
  if (hasCowartWidgetBridge()) {
    return callCowartServerTool(TOOL_SAVE_CANVAS_STATE, { snapshot })
  }

  return fetchJson(CANVAS_ENDPOINT, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot)
  })
}

export async function saveCowartSelectionState(selection) {
  if (hasCowartWidgetBridge()) {
    return callCowartServerTool(TOOL_SAVE_SELECTION_STATE, { selection })
  }

  return fetchJson(SELECTION_ENDPOINT, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(selection)
  })
}

export async function saveCowartViewState(viewState) {
  if (hasCowartWidgetBridge()) {
    return callCowartServerTool(TOOL_SAVE_VIEW_STATE, { viewState })
  }

  return fetchJson(VIEW_STATE_ENDPOINT, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(viewState)
  })
}
