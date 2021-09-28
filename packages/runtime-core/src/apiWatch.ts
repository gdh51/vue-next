import {
  isRef,
  Ref,
  ComputedRef,
  ReactiveEffect,
  isReactive,
  ReactiveFlags,
  EffectScheduler,
  DebuggerOptions
} from '@vue/reactivity'
import { SchedulerJob, queuePreFlushCb } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged,
  NOOP,
  remove,
  isMap,
  isSet,
  isPlainObject
} from '@vue/shared'
import {
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  setCurrentInstance,
  unsetCurrentInstance
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { queuePostRenderEffect } from './renderer'
import { warn } from './warning'
import { DeprecationTypes } from './compat/compatConfig'
import { checkCompatEnabled, isCompatEnabled } from './compat/compatConfig'
import { ObjectWatchOptionItem } from './componentOptions'

export type WatchEffect = (onInvalidate: InvalidateCbRegistrator) => void

export type WatchSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

export type WatchCallback<V = any, OV = any> = (
  value: V,
  oldValue: OV,
  onInvalidate: InvalidateCbRegistrator
) => any

type MapSources<T, Immediate> = {
  [K in keyof T]: T[K] extends WatchSource<infer V>
    ? Immediate extends true
      ? V | undefined
      : V
    : T[K] extends object
    ? Immediate extends true
      ? T[K] | undefined
      : T[K]
    : never
}

type InvalidateCbRegistrator = (cb: () => void) => void

export interface WatchOptionsBase extends DebuggerOptions {
  flush?: 'pre' | 'post' | 'sync'
}

export interface WatchOptions<Immediate = boolean> extends WatchOptionsBase {
  immediate?: Immediate
  deep?: boolean
}

export type WatchStopHandle = () => void

// Simple effect.
export function watchEffect(
  // 要执行的effect函数
  effect: WatchEffect,
  // 控制effect行为的对象参数
  options?: WatchOptionsBase
): WatchStopHandle {
  // 调用doWatch函数创建，无cb
  return doWatch(effect, null, options)
}

export function watchPostEffect(
  effect: WatchEffect,
  options?: DebuggerOptions
) {
  return doWatch(
    effect,
    null,
    (__DEV__
      ? Object.assign(options || {}, { flush: 'post' })
      : { flush: 'post' }) as WatchOptionsBase
  )
}

export function watchSyncEffect(
  effect: WatchEffect,
  options?: DebuggerOptions
) {
  return doWatch(
    effect,
    null,
    (__DEV__
      ? Object.assign(options || {}, { flush: 'sync' })
      : { flush: 'sync' }) as WatchOptionsBase
  )
}

// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}

type MultiWatchSources = (WatchSource<unknown> | object)[]

// overload: array of multiple sources + cb
export function watch<
  T extends MultiWatchSources,
  Immediate extends Readonly<boolean> = false
>(
  sources: [...T],
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: multiple sources w/ `as const`
// watch([foo, bar] as const, () => {})
// somehow [...T] breaks when the type is readonly
export function watch<
  T extends Readonly<MultiWatchSources>,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<MapSources<T, false>, MapSources<T, Immediate>>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: single source + cb
export function watch<T, Immediate extends Readonly<boolean> = false>(
  source: WatchSource<T>,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// overload: watching reactive object w/ cb
export function watch<
  T extends object,
  Immediate extends Readonly<boolean> = false
>(
  source: T,
  cb: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: WatchOptions<Immediate>
): WatchStopHandle

// implementation
export function watch<T = any, Immediate extends Readonly<boolean> = false>(
  // 要观察的响应式对象，可以是一个函数
  source: T | WatchSource<T>,
  // 依赖变更时触发的函数
  cb: any,
  options?: WatchOptions<Immediate>
): WatchStopHandle {
  if (__DEV__ && !isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source as any, cb, options)
}

function doWatch(
  // 要观察的响应式对象，可以是一个函数
  source: WatchSource | WatchSource[] | WatchEffect | object,
  // 依赖变更时触发的函数
  cb: WatchCallback | null,
  { immediate, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ
): WatchStopHandle {
  // 如果用户没有定义执行的回调(这里实际对应在watchEffect中使用该属性)
  if (__DEV__ && !cb) {
    // 使用immediate时，则报错
    if (immediate !== undefined) {
      warn(
        `watch() "immediate" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }

    // 使用deep时则报错
    if (deep !== undefined) {
      warn(
        `watch() "deep" option is only respected when using the ` +
          `watch(source, callback, options?) signature.`
      )
    }
  }

  // 观察非法类型的响应式对象时
  const warnInvalidSource = (s: unknown) => {
    warn(
      `Invalid watch source: `,
      s,
      `A watch source can only be a getter/effect function, a ref, ` +
        `a reactive object, or an array of these types.`
    )
  }

  // 获取当前组件实例
  const instance = currentInstance
  let getter: () => any

  // watch api是否在依赖项变更时无条件触发回调函数
  let forceTrigger = false
  let isMultiSource = false

  // 当前数据源为引用对象
  if (isRef(source)) {
    // 则副作用函数的getter为访问其value
    getter = () => source.value

    // 当其为浅引用时强制触发更新(这样可以直接通过triggerRef触发更新)
    forceTrigger = !!source._shallow

    // 如果为响应化对象时，默认做深度追踪
  } else if (isReactive(source)) {
    // 返回原对象
    getter = () => source

    // 默认深度观察
    deep = true

    // 如果为数组时，遍历进行观察
  } else if (isArray(source)) {
    isMultiSource = true

    // 其中任意一个具有响应式时，强制更新
    // (因为即使响应式对象发生变更，其变更的是内部值，所以判定变化时不会发生变化)
    forceTrigger = source.some(isReactive)

    // 数组的getter为遍历，并根据元素具体值返回
    getter = () =>
      source.map(s => {
        // 对数组中的ref取其value
        if (isRef(s)) {
          return s.value

          // 对响应式对象，递归深度收集
        } else if (isReactive(s)) {
          return traverse(s)

          // 若为数组式函数，则进行调用
        } else if (isFunction(s)) {
          return callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER)
        } else {
          __DEV__ && warnInvalidSource(s)
        }
      })
    // 如果为函数，则返回一个getter函数
  } else if (isFunction(source)) {
    // 具有回调函数，说明为watch api
    if (cb) {
      // getter with cb
      getter = () =>
        callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)

      // 如果没有依赖项更改时触发的回调函数，则认为一个effect
      // (watchEffect就是这种，当然你可以通过watch来模拟watchEffect)
    } else {
      // no cb -> simple effect
      getter = () => {
        // 实例未渲染时退出不执行
        if (instance && instance.isUnmounted) {
          return
        }

        // 在effect更新前执行用户自定义的清理函数
        if (cleanup) {
          cleanup()
        }

        // 调用用户设置的函数，传入一个设置清理函数的函数作为参数
        return callWithAsyncErrorHandling(
          source,
          instance,
          ErrorCodes.WATCH_CALLBACK,
          [onInvalidate]
        )
      }
    }
  } else {
    // 其他类型均为非法，报错
    getter = NOOP
    __DEV__ && warnInvalidSource(source)
  }

  // 2.x array mutation watch compat
  // 兼容Vue 2数组变更
  if (__COMPAT__ && cb && !deep) {
    const baseGetter = getter
    getter = () => {
      const val = baseGetter()
      if (
        isArray(val) &&
        checkCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance)
      ) {
        traverse(val)
      }
      return val
    }
  }

  // 如果是深度收集依赖项，则递归遍历对象，深度收集依赖项
  if (cb && deep) {
    const baseGetter = getter
    getter = () => traverse(baseGetter())
  }

  let cleanup: () => void

  let onInvalidate: InvalidateCbRegistrator = (fn: () => void) => {
    // 为effect重写一个onStop函数
    // 该函数会在effect销毁时调用
    cleanup = effect.onStop = () => {
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
    }
  }

  // in SSR there is no need to setup an actual effect, and it should be noop
  // unless it's eager
  if (__SSR__ && isInSSRComponentSetup) {
    // we will also not call the invalidate callback (+ runner is not set up)
    onInvalidate = NOOP
    if (!cb) {
      getter()
    } else if (immediate) {
      callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
        getter(),
        isMultiSource ? [] : undefined,
        onInvalidate
      ])
    }
    return NOOP
  }

  // 获取初始化旧值
  let oldValue = isMultiSource ? [] : INITIAL_WATCHER_VALUE

  // 调度中执行的任务，主要是根据情况执行回调函数或原effect(watchEffect)
  const job: SchedulerJob = () => {
    // 当前watch已失活
    if (!effect.active) {
      return
    }

    // watch api， 执行cb
    if (cb) {
      // watch(source, cb)
      // 调度getter()进行新值求值(并收集依赖项)
      const newValue = effect.run()
      if (
        // 深度观察
        deep ||
        // 强制更新
        forceTrigger ||
        // 数组时，查看是否存在数组元素值发生变化
        (isMultiSource
          ? (newValue as any[]).some((v, i) =>
              hasChanged(v, (oldValue as any[])[i])
            )
          : hasChanged(newValue, oldValue)) ||
        // 兼容V2
        (__COMPAT__ &&
          isArray(newValue) &&
          isCompatEnabled(DeprecationTypes.WATCH_ARRAY, instance))
      ) {
        // cleanup before running cb again
        // 执行用户的清除逻辑，在执行回调函数之前
        if (cleanup) {
          cleanup()
        }

        // 调用用户定义的watch回调，传入新旧值，并传入一个设置清理函数的函数(允许用户在下次函数调用时，提前执行清理逻辑)
        callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
          newValue,
          // pass undefined as the old value when it's changed for the first time
          oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
          onInvalidate
        ])
        oldValue = newValue
      }

      // 执行watchEffect api的effect
    } else {
      // watchEffect
      effect.run()
    }
  }

  // important: mark the job as a watcher callback so that scheduler knows
  // it is allowed to self-trigger (#1727)
  // watch api允许当前effect递归调用自己(这里不是在effect中，而是在刷新队列中)
  job.allowRecurse = !!cb

  // 调度程序，该函数只会决定何时调用job
  let scheduler: EffectScheduler

  // 根据调度类型，进行调度划分

  // 同步调度，依赖项更新后立即调度
  if (flush === 'sync') {
    // 调度程序直接使用job
    scheduler = job as any // the scheduler function gets called directly

    // 后置调度，调度程序使用函数，将job至于后置队列中
  } else if (flush === 'post') {
    // 将当前job加入延迟执行队列
    scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)

    // 默认为提前调度
  } else {
    // default: 'pre'
    scheduler = () => {
      // 组件实例未生成或挂载之后的实例加入到预执行队列中执行
      if (!instance || instance.isMounted) {
        queuePreFlushCb(job)

        // 对于未挂载的组件实例，在组件挂载前直接同步执行
      } else {
        // with 'pre' option, the first call must happen before
        // the component is mounted so it is called synchronously.
        job()
      }
    }
  }

  // 创建该watch的副作用函数，自定义调度程序
  const effect = new ReactiveEffect(getter, scheduler)

  if (__DEV__) {
    effect.onTrack = onTrack
    effect.onTrigger = onTrigger
  }

  // initial run
  // 初始化调用，主要是进行依赖项收集

  // 使用watch api时
  if (cb) {
    // 如果immediate，则立即执行一次job
    if (immediate) {
      job()

      // 无立即执行时，仅调用getter()函数进行依赖收集
    } else {
      oldValue = effect.run()
    }

    // 后置执行时，默认执行一次依赖收集
  } else if (flush === 'post') {
    queuePostRenderEffect(
      effect.run.bind(effect),
      instance && instance.suspense
    )

    // 默认情况立即进行依赖收集
  } else {
    effect.run()
  }

  // 返回一个注销该watch的函数
  return () => {
    // 失活副作用函数
    effect.stop()

    // 从当前实例的作用域中移除当前API的副作用函数
    if (instance && instance.scope) {
      remove(instance.scope.effects!, effect)
    }
  }
}

// this.$watch
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  value: WatchCallback | ObjectWatchOptionItem,
  options?: WatchOptions
): WatchStopHandle {
  const publicThis = this.proxy as any
  const getter = isString(source)
    ? source.includes('.')
      ? createPathGetter(publicThis, source)
      : () => publicThis[source]
    : source.bind(publicThis, publicThis)
  let cb
  if (isFunction(value)) {
    cb = value
  } else {
    cb = value.handler as Function
    options = value
  }
  const cur = currentInstance
  setCurrentInstance(this)
  const res = doWatch(getter, cb.bind(publicThis), options)
  if (cur) {
    setCurrentInstance(cur)
  } else {
    unsetCurrentInstance()
  }
  return res
}

export function createPathGetter(ctx: any, path: string) {
  const segments = path.split('.')
  return () => {
    let cur = ctx
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]]
    }
    return cur
  }
}

export function traverse(value: unknown, seen?: Set<unknown>) {
  if (!isObject(value) || (value as any)[ReactiveFlags.SKIP]) {
    return value
  }
  seen = seen || new Set()
  if (seen.has(value)) {
    return value
  }

  // 记录该对象
  seen.add(value)

  // 如果未ref，遍历其value
  if (isRef(value)) {
    traverse(value.value, seen)

    // 如果未数组遍历其所有index
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }

    // 如果未Set/Map，调用其forEach遍历
  } else if (isSet(value) || isMap(value)) {
    value.forEach((v: any) => {
      traverse(v, seen)
    })
  } else if (isPlainObject(value)) {
    for (const key in value) {
      traverse((value as any)[key], seen)
    }
  }

  //  返回当前对象
  return value
}
