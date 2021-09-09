import { Dep } from './dep'
import { ReactiveEffect } from './effect'
import { ComputedGetter, ComputedRef } from './computed'
import { ReactiveFlags, toRaw } from './reactive'
import { trackRefValue, triggerRefValue } from './ref'

const tick = Promise.resolve()

// 调度队列
const queue: any[] = []

// 是否正在执行调度队列
let queued = false

// 简易的调度队列
const scheduler = (fn: any) => {
  queue.push(fn)

  // 未执行时，立即在下个mac阶段执行
  if (!queued) {
    queued = true
    tick.then(flush)
  }
}

// 执行调度队列
const flush = () => {
  // 动态计算队列长度
  for (let i = 0; i < queue.length; i++) {
    queue[i]()
  }

  // 调度完毕还原状态
  queue.length = 0
  queued = false
}

class DeferredComputedRefImpl<T> {
  public dep?: Dep = undefined

  private _value!: T

  // 首次允许计算
  private _dirty = true
  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true
  public readonly [ReactiveFlags.IS_READONLY] = true

  constructor(getter: ComputedGetter<T>) {
    let compareTarget: any
    let hasCompareTarget = false

    // 当前计算属性是否已调度
    let scheduled = false

    // 创建effect，自定义调度函数
    this.effect = new ReactiveEffect(getter, (computedTrigger?: boolean) => {
      // 存在依赖项时
      if (this.dep) {
        // 本次调度是否由effect自身调用(最后行)
        if (computedTrigger) {
          // 记录当前缓存值
          compareTarget = this._value
          hasCompareTarget = true

          // 依赖项变更引起的调度且未开始调度时
        } else if (!scheduled) {
          const valueToCompare = hasCompareTarget ? compareTarget : this._value

          // 将调度置为已开始
          scheduled = true
          hasCompareTarget = false

          // 加入调度队列，在下个微任务阶段进行
          // 调度有通知依赖项更新的作用
          scheduler(() => {
            // 在下个微任务阶段值发生变化时，提醒收集当前computed的effect更新
            if (this.effect.active && this._get() !== valueToCompare) {
              triggerRefValue(this)
            }

            // 允许重新调度
            scheduled = false
          })
        }

        // chained upstream computeds are notified synchronously to ensure
        // value invalidation in case of sync access; normal effects are
        // deferred to be triggered in scheduler.
        // 同步触发上游延迟计算属性更新来保证在同步访问时值无误(正常情况下，是异步更新的)
        for (const e of this.dep) {
          // 同为def函数直接同步调度，本次相当于强制允许重新计算求值
          if (e.computed) {
            e.scheduler!(true /* computedTrigger */)
          }
        }
      }

      // 允许重新计算
      this._dirty = true
    })

    // 标记为deferredComputed
    this.effect.computed = true
  }

  private _get() {
    // 允许计算时
    if (this._dirty) {
      this._dirty = false

      // 调用getter进行求值并收集依赖项
      return (this._value = this.effect.run()!)
    }
    return this._value
  }

  get value() {
    // 追踪当前正在收集依赖项的effect
    trackRefValue(this)

    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    // 取值并进行getter依赖收集
    return toRaw(this)._get()
  }
}

// 延迟计算属性
export function deferredComputed<T>(getter: () => T): ComputedRef<T> {
  return new DeferredComputedRefImpl(getter) as any
}
