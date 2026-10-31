/** 测试用最小假上下文：只实现插件实际用到的服务面。 */

export function makeFakeGoals() {
  const calls = []
  const api = {
    calls,
    activation: 'disarmed',
    goal: undefined,
    revision: 0,
  }

  function view() {
    if (api.goal === undefined) return undefined
    return { ...api.goal, revision: api.revision, activation: api.activation }
  }

  api.get = () => {
    calls.push(['get'])
    return view()
  }
  api.create = (_agent, request) => {
    calls.push(['create', request])
    api.revision += 1
    api.goal = {
      id: 'goal-1',
      objective: request.objective,
      phase: 'active',
      maxGoalRounds: request.maxGoalRounds ?? 256,
      roundsStarted: 0,
    }
    api.activation = 'armed'
    return view()
  }
  api.edit = (_agent, ref, request) => {
    calls.push(['edit', request])
    if (api.goal !== undefined) {
      if (request.objective !== undefined) api.goal.objective = request.objective
      if (request.maxGoalRounds !== undefined) api.goal.maxGoalRounds = request.maxGoalRounds
    }
    api.revision += 1
    return view()
  }
  api.pause = () => {
    calls.push(['pause'])
    if (api.goal !== undefined) api.goal.phase = 'paused'
    api.activation = 'disarmed'
    api.revision += 1
    return view()
  }
  api.resume = () => {
    calls.push(['resume'])
    if (api.goal !== undefined) api.goal.phase = 'active'
    api.activation = 'armed'
    api.revision += 1
    return view()
  }
  api.block = (_agent, _ref, reason) => {
    calls.push(['block', reason])
    if (api.goal !== undefined) {
      api.goal.phase = 'blocked'
      api.goal.blockedReason = reason
    }
    api.activation = 'disarmed'
    api.revision += 1
    return view()
  }
  api.clear = () => {
    calls.push(['clear'])
    api.goal = undefined
    api.revision += 1
    return { id: 'goal-1', revision: api.revision }
  }
  api.disarm = () => {
    calls.push(['disarm'])
    api.activation = 'disarmed'
    return view()
  }
  api.complete = () => {
    calls.push(['complete'])
    if (api.goal !== undefined) api.goal.phase = 'complete'
    api.activation = 'disarmed'
    api.revision += 1
    return view()
  }

  return api
}

/** 测试用最小会话投影注册表：记录登记、按 key 返回预先放好的状态。 */
export function makeFakeProjections() {
  const registrations = []
  const states = new Map()
  return {
    registrations,
    states,
    register(definition) {
      registrations.push(definition)
      return () => {
        const index = registrations.indexOf(definition)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
    stateOf(_session, key) {
      return states.get(key)
    },
  }
}

export function makeFakeAgent(id = 'session-1') {
  const events = new Map()
  const calls = { steer: [], followup: [], inject: [], cancel: [] }

  const scope = {
    on(name, listener) {
      const list = events.get(name) ?? []
      list.push(listener)
      events.set(name, list)
      return () => {
        const current = events.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    get() {
      return undefined
    },
  }

  const agent = {
    id,
    status: 'idle',
    ctx: scope,
    session: { id },
    calls,
    events,
    steer(input) {
      calls.steer.push(input)
    },
    followup(input) {
      calls.followup.push(input)
    },
    inject(input) {
      calls.inject.push(input)
    },
    cancel(cause, options) {
      calls.cancel.push({ cause, options })
    },
    emit(name, payload) {
      for (const listener of [...(events.get(name) ?? [])]) listener(payload)
    },
  }
  return agent
}

export function makeFakeSubagents(children = []) {
  const interrupted = []
  return {
    interrupted,
    async listChildren() {
      return children.map((id) => ({ id, mode: 'continuable', label: id }))
    },
    interrupt(targetSessionId, authority) {
      interrupted.push({ targetSessionId, authority })
    },
  }
}

export function makeFakeJobs() {
  const kills = []
  const listeners = []
  return {
    kills,
    listeners,
    list(caller) {
      return [
        { id: 'job-1', status: 'running', owner: caller },
        { id: 'job-2', status: 'completed', owner: caller },
        // 宿主会把不属于任何会话的后台任务一起列出来：到点不该被顺带杀掉。
        { id: 'job-unowned', status: 'running', owner: 'unowned' },
      ]
    },
    kill(id, caller, reason) {
      kills.push({ id, caller, reason })
      return 'requested'
    },
    events: {
      subscribe(filter, listener) {
        listeners.push({ filter, listener })
        return () => {
          const index = listeners.findIndex((entry) => entry.listener === listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    },
    settle(id) {
      for (const entry of [...listeners]) entry.listener({ type: 'settled', job: { id } })
    },
  }
}

export function makeFakeContext({ agents = [], roots, goals, subagents, jobs, projections } = {}) {
  const listeners = new Map()
  const registeredCommands = []
  const registeredTools = []
  const routes = []
  const disposers = []
  const logs = []

  const goalsService = goals ?? makeFakeGoals()
  const projectionsService = projections ?? makeFakeProjections()
  const rootAgents = roots ?? agents

  const toolsService = {
    register(definition) {
      registeredTools.push(definition)
      return () => {
        const index = registeredTools.indexOf(definition)
        if (index >= 0) registeredTools.splice(index, 1)
      }
    },
  }

  const webServer = {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }

  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      debug: () => {},
    },
    agents: {
      get: (id) => agents.find((agent) => agent.id === id),
      list: () => [...agents],
      roots: () => [...rootAgents],
    },
    goals: goalsService,
    projections: projectionsService,
    commands: {
      register(definition) {
        registeredCommands.push(definition)
        return () => {
          const index = registeredCommands.indexOf(definition)
          if (index >= 0) registeredCommands.splice(index, 1)
        }
      },
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    get(name) {
      if (name === 'agents') return ctx.agents
      if (name === 'goals') return goalsService
      if (name === 'subagents') return subagents
      if (name === 'jobs') return jobs
      if (name === 'tools') return toolsService
      if (name === 'sessionProjections') return projectionsService
      if (name === 'webServer') return webServer
      return undefined
    },
    /** 只实现可选服务那条路：依赖齐了就同步跑回调，服务属性直接挂在作用域上。 */
    inject(deps, callback) {
      if (!deps.every((name) => ctx.get(name) !== undefined)) return () => {}
      const scope = {
        ...ctx,
        effect(inner) {
          const dispose = inner()
          disposers.push(dispose)
          return dispose
        },
      }
      for (const name of deps) scope[name] = ctx.get(name)
      const dispose = callback(scope)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return dispose
    },
    emit(name, ...args) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    },
    registeredCommands,
    registeredTools,
    routes,
    webServer,
    listeners,
    logs,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        if (typeof dispose === 'function') dispose()
      }
    },
  }

  return ctx
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
