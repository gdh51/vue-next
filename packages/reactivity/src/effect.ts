import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>

// 存放着 源对象 -> 依赖项集合 的Map，
// 该响应化对象所有的依赖项key都会以Set的形式存入到Map中
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
// 当前递归更新的effects数量
let effectTrackDepth = 0

export let trackOpBit = 1

/**
 * The bitwise track markers support at most 30 levels op recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 * 最大进行30层的递归操作，超过时回退到直接清空依赖项重新收集。
 * 不超过30次的原因是，31以下时，浏览器对整数会使用SMI进行优化处理
 */
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

// effect执行栈，防止重复同一effect在同一时间同时执行
const effectStack: ReactiveEffect[] = []

// 当前effect执行栈栈顶正在执行的effect
let activeEffect: ReactiveEffect | undefined

// 表示是迭代，比如for ... of
export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')

// 表示为Map.prototype.entries()
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

// effect Class化
export class ReactiveEffect<T = any> {
  // 活跃状态
  active = true

  // 依赖项
  deps: Dep[] = []

  // can be attached after creation
  // 标记是否为deferredComputed
  computed?: boolean

  // 是否允许递归调用
  allowRecurse?: boolean

  // 在失活时调用
  onStop?: () => void

  // dev only
  // 在当前effect被依赖项追踪时调用
  onTrack?: (event: DebuggerEvent) => void

  // dev only
  // 在effect触发更新时触发
  onTrigger?: (event: DebuggerEvent) => void

  // 构造函数，接受一个原函数、一个调度函数、一个作用域作为参数
  constructor(
    // 收集依赖项的getter，也是默认调度函数
    public fn: () => T,
    // 自定义调度函数
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope | null
  ) {
    // 将当前effect加入scope中
    recordEffectScope(this, scope)
  }

  run() {
    // 已失活，无副作用调度原函数
    if (!this.active) {
      return this.fn()
    }

    // 确认当前effect未在进行调度
    if (!effectStack.includes(this)) {
      try {
        // 加入调度栈中
        effectStack.push((activeEffect = this))

        // 允许effect追踪
        enableTracking()

        // 增加递归深度，并记录当前的track bit
        trackOpBit = 1 << ++effectTrackDepth

        // 当前effect递归追踪次数不超过30次时
        if (effectTrackDepth <= maxMarkerBits) {
          // 初始化当前依赖项
          initDepMarkers(this)

          // 超过30次递归时，直接清空依赖项重新收集
        } else {
          cleanupEffect(this)
        }

        // 调用原函数
        return this.fn()
      } finally {
        // 30层以下时，对新旧依赖项进行diff更新
        if (effectTrackDepth <= maxMarkerBits) {
          finalizeDepMarkers(this)
        }

        trackOpBit = 1 << --effectTrackDepth

        // 停止当前的effect追踪
        resetTracking()

        // 退出effect调度栈
        effectStack.pop()

        // 重置activeEffect
        const n = effectStack.length
        activeEffect = n > 0 ? effectStack[n - 1] : undefined

        // 在finally中才进行依赖项更新和收集，这意味着，在第一次依赖项收集时
        // 如果发生mutation，不会重复触发收集和更新
      }
    }
  }

  stop() {
    // 当前effect还处于活跃状态时
    if (this.active) {
      // 依赖项与effect之间互相解绑
      cleanupEffect(this)

      // 调用onStop hook
      if (this.onStop) {
        this.onStop()
      }

      // 将当前组件失活
      this.active = false
    }
  }
}

function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    // 删除单个依赖项中的该effect
    for (let i = 0; i < deps.length; i++) {
      // 一个依赖项为一个Set
      deps[i].delete(effect)
    }

    // 置空依赖项数组
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  // 进行effect化的函数已effect化时，获取其原函数
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  // 创建新的effect函数(会自动收集到当前活跃的scope)
  const _effect = new ReactiveEffect(fn)

  // 如果具有配置
  if (options) {
    // 将配置覆盖到effect实例上
    extend(_effect, options)

    // 如果具有effect作用域，将其加入对应作用域
    if (options.scope) recordEffectScope(_effect, options.scope)
  }

  // 默认情况下或未指定lazy时，自动执行一次调度函数
  if (!options || !options.lazy) {
    _effect.run()
  }

  // 将其调度函数绑定至当前effect
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect

  // 返回调度函数
  return runner
}

// 失活当前effect
export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  // 存储上一次是否应该追踪的许可
  trackStack.push(shouldTrack)

  // 当前允许进行effect追踪
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

// effect追踪函数
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 当前不允许追踪时，退出
  if (!isTracking()) {
    return
  }

  // 获取当前对象对应的依赖项Map(包含了所有已被激活的依赖项)
  let depsMap = targetMap.get(target)

  // 如果当前对象不存在依赖项Map，则创建一个
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }

  // 获取当前key对应的依赖项
  let dep = depsMap.get(key)

  // 没有则新建，并加入desMap
  if (!dep) {
    depsMap.set(key, (dep = createDep()))
  }

  const eventInfo = __DEV__
    ? { effect: activeEffect, target, type, key }
    : undefined

  // 让当前依赖项追踪当前effect
  trackEffects(dep, eventInfo)
}

export function isTracking() {
  return shouldTrack && activeEffect !== undefined
}

export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // 是否需要追踪
  let shouldTrack = false

  // 不超过30次递归追踪时使用
  if (effectTrackDepth <= maxMarkerBits) {
    // 当前依赖项还未将当前effect标记为即将追踪
    if (!newTracked(dep)) {
      // 将当前effect的bit位写入当前依赖项即将追踪依赖项bit位中
      dep.n |= trackOpBit // set newly tracked

      // 当前依赖项未追踪当前effect(新)
      shouldTrack = !wasTracked(dep)
    }

    // 超过时，当前追踪的effect为新effect
  } else {
    // Full cleanup mode.
    shouldTrack = !dep.has(activeEffect!)
  }

  // 应该追踪当前effect时
  if (shouldTrack) {
    // 依赖项与effect互相收集对方
    dep.add(activeEffect!)
    activeEffect!.deps.push(dep)

    // 触发当前effect的onTrack
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        Object.assign(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo
        )
      )
    }
  }

  // 在这个函数中，无论当前依赖项是否已被追踪，
  // 它此时都会被收集到effect的依赖项数组中
}

// 触发effect重新调度进行更新
export function trigger(
  // 由哪个对象触发的effect更新
  target: object,
  // 当前触发更新的类型
  type: TriggerOpTypes,
  // 该对象触发更新的key值
  key?: unknown,
  // 更新的值
  newValue?: unknown,
  // 未更新前的值
  oldValue?: unknown,
  // 变更前的原target的copy
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 获取该响应式对象的依赖项Map
  const depsMap = targetMap.get(target)

  // 没有，说明该对象没有进行响应化
  if (!depsMap) {
    // never been tracked
    return
  }

  // 将当前要进行触发effect更新的dep收集起来
  let deps: (Dep | undefined)[] = []

  // clear模式收集全部依赖项
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]

    // 触发数组的length更新
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      // 将length的依赖项中追踪的effect添加到待更新队列中
      // 同时将超过长度的依赖项中追踪的effect也添加到待更新队列中
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 对于SET/ADD/DELETE操作，将它们对应操作的key的依赖项所追踪的effect加入队列
    // (这里指广泛意义的增删改)
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    // 处理由于迭代造成的effect追踪的effect，提醒它们也进行更新
    switch (type) {
      // 新增类型的操作时
      case TriggerOpTypes.ADD:
        // 非数组时
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }

          // 数组时，当前key为合法的整数key值时，触发length的更新提醒
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break

      // 对象或数组删除属性(Map/Set/WeakSet/WeakMap删除属性)
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break

      // 修改类型的操作时，仅提醒Map更新
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  // 触发单个依赖项更新
  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }

    // 有多个依赖项需要更新时
  } else {
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }

    // 整合为一个依赖项进行更新
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  for (const effect of isArray(dep) ? dep : [...dep]) {
    // 如果当前effect不为正在更新的effect或为允许递归调用时，
    // 才进行更新
    if (effect !== activeEffect || effect.allowRecurse) {
      // 触发依赖项更新的onTrigger
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }

      // 优先调用用户自定义的调度函数
      if (effect.scheduler) {
        effect.scheduler()

        // fallback调用原来的调度函数
      } else {
        effect.run()
      }
    }
  }
}
