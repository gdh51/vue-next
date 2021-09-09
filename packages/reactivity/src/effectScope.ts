import { ReactiveEffect } from './effect'
import { warn } from './warning'

// 当前正在活跃的副作用函数作用域
let activeEffectScope: EffectScope | undefined

// 当前正在活跃的副作用函数作用域们
const effectScopeStack: EffectScope[] = []

export class EffectScope {
  // 活跃
  active = true

  // 当前作用域的副作用函数们
  effects: ReactiveEffect[] = []

  // 作用域注销时调用的清理函数
  cleanups: (() => void)[] = []

  // 父级作用域
  parent: EffectScope | undefined

  // 当前作用域管理的子作用域
  scopes: EffectScope[] | undefined
  /**
   * track a child scope's index in its parent's scopes array for optimized
   * removal
   * 记录📝在父作用域中的下标，方便移除时效率
   */
  private index: number | undefined

  // 是否执行单独的作用域
  constructor(detached = false) {
    // 非单独作用域时，记录父级作用域信息
    if (!detached && activeEffectScope) {
      this.parent = activeEffectScope
      this.index =
        (activeEffectScope.scopes || (activeEffectScope.scopes = [])).push(
          this
        ) - 1
    }
  }

  // 在当前作用域中调度原函数
  run<T>(fn: () => T): T | undefined {
    // 当前作用域为活跃状态
    if (this.active) {
      try {
        // 将当前作用域置为正在操作作用域
        this.on()

        // 调度当前传入的函数
        return fn()

        // 调度完毕时，还原当前正在操作的作用域
      } finally {
        this.off()
      }
    } else if (__DEV__) {
      warn(`cannot run an inactive effect scope.`)
    }
  }

  // 设置当前作用域为活跃作用域
  on() {
    if (this.active) {
      effectScopeStack.push(this)
      activeEffectScope = this
    }
  }

  // 取消当其作用域作为活跃作用域
  off() {
    if (this.active) {
      effectScopeStack.pop()
      activeEffectScope = effectScopeStack[effectScopeStack.length - 1]
    }
  }

  // 失活当前作用域
  stop(fromParent?: boolean) {
    if (this.active) {
      // 递归失活当前作用域中的副作用函数
      this.effects.forEach(e => e.stop())

      // 调用注册的清理函数
      this.cleanups.forEach(cleanup => cleanup())

      // 递归失活子作用域
      if (this.scopes) {
        this.scopes.forEach(e => e.stop(true))
      }
      // nested scope, dereference from parent to avoid memory leaks
      // 嵌套作用域从父作用域中分离(这里用于处理单独失活时)
      if (this.parent && !fromParent) {
        // optimized O(1) removal
        const last = this.parent.scopes!.pop()

        // 非目标移除时，替换当前移除位置-+
        if (last && last !== this) {
          this.parent.scopes![this.index!] = last
          last.index = this.index!
        }
      }
      this.active = false
    }
  }
}

export function effectScope(detached?: boolean) {
  return new EffectScope(detached)
}

// https://github.com/vuejs/rfcs/blob/master/active-rfcs/0041-reactivity-effect-scope.md RFC
// 将副作用函数加入当前活跃或指定的作用域
export function recordEffectScope(
  effect: ReactiveEffect,
  scope?: EffectScope | null
) {
  scope = scope || activeEffectScope
  if (scope && scope.active) {
    scope.effects.push(effect)
  }
}

export function getCurrentScope() {
  return activeEffectScope
}

export function onScopeDispose(fn: () => void) {
  if (activeEffectScope) {
    activeEffectScope.cleanups.push(fn)
  } else if (__DEV__) {
    warn(
      `onScopeDispose() is called when there is no active effect scope` +
        ` to be associated with.`
    )
  }
}
