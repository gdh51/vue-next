import { DebuggerOptions, ReactiveEffect } from './effect'
import { Ref, trackRefValue, triggerRefValue } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'
import { Dep } from './dep'

declare const ComoutedRefSymbol: unique symbol

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
  [ComoutedRefSymbol]: true
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (...args: any[]) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

class ComputedRefImpl<T> {
  // 下属依赖项
  public dep?: Dep = undefined

  // 计算属性值的引用
  private _value!: T

  // 是否允许重新计算
  private _dirty = true
  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true
  public readonly [ReactiveFlags.IS_READONLY]: boolean

  constructor(
    // getter函数
    getter: ComputedGetter<T>,
    // setter函数
    private readonly _setter: ComputedSetter<T>,
    // 是否只读
    isReadonly: boolean
  ) {
    // 创建effect，自定义调度函数
    this.effect = new ReactiveEffect(getter, () => {
      // 未有依赖项更新时，不允许重新计算
      if (!this._dirty) {
        this._dirty = true

        // 通知当前收集当前computed属性的effect调度更新
        triggerRefValue(this)
      }
    })

    // 是否为只读属性
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  // 计算属性的取值属性
  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    const self = toRaw(this)

    // computed追踪当前正在收集依赖项的effect
    trackRefValue(self)

    // 是否允许计算新值
    if (self._dirty) {
      // 允许计算新值时，计算一次后关闭
      self._dirty = false

      // 调度原computed函数进行依赖收集和取值
      // (即，依赖项更新，通知computed重新计算)
      self._value = self.effect.run()!
    }

    // 返回最新值
    return self._value
  }

  // 调用setter设置新的值
  set value(newValue: T) {
    this._setter(newValue)
  }
}

export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions
): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
): WritableComputedRef<T>

// computed函数
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  const onlyGetter = isFunction(getterOrOptions)
  if (onlyGetter) {
    getter = getterOrOptions

    // setter定义为不能修改的函数
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    // 用户传入一个具有getter/setter函数的配置对象
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  const cRef = new ComputedRefImpl(getter, setter, onlyGetter || !setter)

  if (__DEV__ && debugOptions) {
    cRef.effect.onTrack = debugOptions.onTrack
    cRef.effect.onTrigger = debugOptions.onTrigger
  }

  return cRef as any
}
