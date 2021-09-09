import { ReactiveEffect, trackOpBit } from './effect'

export type Dep = Set<ReactiveEffect> & TrackedMarkers

/**
 * wasTracked and newTracked maintain the status for several levels of effect
 * tracking recursion. One bit per level is used to define wheter the dependency
 * was/is tracked.
 */
type TrackedMarkers = {
  /**
   * wasTracked
   */
  w: number
  /**
   * newTracked
   */
  n: number
}

// 创建一个Dep
export const createDep = (effects?: ReactiveEffect[]): Dep => {
  const dep = new Set<ReactiveEffect>(effects) as Dep

  // 已追踪的dep的bitmap
  dep.w = 0

  // 即将追踪的dep的bitmap
  dep.n = 0
  return dep
}

// 当前依赖项是否过去已追踪当前effect
export const wasTracked = (dep: Dep): boolean => (dep.w & trackOpBit) > 0

// 当前依赖项是否现在已经追踪过当前effect
export const newTracked = (dep: Dep): boolean => (dep.n & trackOpBit) > 0

export const initDepMarkers = ({ deps }: ReactiveEffect) => {
  // 初始化当前依赖项，将当前深度记录📝在已追踪依赖项中
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].w |= trackOpBit // set was tracked
    }
  }
}

// 正式进行依赖收集，并对新旧依赖项进行diff
export const finalizeDepMarkers = (effect: ReactiveEffect) => {
  const { deps } = effect
  if (deps.length) {
    // prev tract 之前追中的
    let ptr = 0
    for (let i = 0; i < deps.length; i++) {
      const dep = deps[i]

      // 如果当前依赖项之前存在，而现在不存在，则移除
      if (wasTracked(dep) && !newTracked(dep)) {
        dep.delete(effect)

        // 新增、替换或不变时，重新写入
      } else {
        deps[ptr++] = dep
      }

      // clear bits
      // 清理当前深度的bit位
      dep.w &= ~trackOpBit
      dep.n &= ~trackOpBit
    }

    // 清空多余依赖项
    deps.length = ptr

    // 一次依赖项收集完毕后，一个依赖项的w/n的bitmap为0
  }
}
