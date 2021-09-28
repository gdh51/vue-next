import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { isArray, NOOP } from '@vue/shared'
import { ComponentInternalInstance, getComponentName } from './component'
import { warn } from './warning'

export interface SchedulerJob extends Function {
  id?: number

  // 是否还处于活跃
  active?: boolean

  // 延迟计算属性的标识
  computed?: boolean
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   * 当一个副作用函数的调度由调度队列管理时，该属性决定其
   * 是否可以进行递归更新
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * 默认情况下，一个调度任务是不会递归调用的(内部方法限制)
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  allowRecurse?: boolean
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * dev only.
   * 开发模式下属性，用于获取组件信息防止超出限制的递归调用
   */
  ownerInstance?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

// 是否处于刷新更新中
let isFlushing = false

// 是否已经进入刷新更新等待阶段(下一个阶段就是更新中)
let isFlushPending = false

// 正常处理队列
const queue: SchedulerJob[] = []
let flushIndex = 0

// 处于等待中的预处理函数队列
const pendingPreFlushCbs: SchedulerJob[] = []

// 正在处理的预处理函数队列
let activePreFlushCbs: SchedulerJob[] | null = null

// 当前处理到的具体下标
let preFlushIndex = 0

const pendingPostFlushCbs: SchedulerJob[] = []
let activePostFlushCbs: SchedulerJob[] | null = null
let postFlushIndex = 0

const resolvedPromise: Promise<any> = Promise.resolve()

// 当前进行中的调度任务Promise
let currentFlushPromise: Promise<void> | null = null

// 当前执行的预处理函数的栈上层函数
let currentPreFlushParentJob: SchedulerJob | null = null

const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob, number>

export function nextTick<T = void>(
  this: T,
  fn?: (this: T) => void
): Promise<void> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
// 使用2分查找为当前job找到合适的位置，
// 这样可以维持调度队列的增序
// 同时避免当前job被跳过或重复执行
function findInsertionIndex(id: number) {
  // the start index should be `flushIndex + 1`
  // 从下一个(待更新的)effect开始查询
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    // 向下取整查找中间值
    const middle = (start + end) >>> 1

    // 获取中值调度任务的id(无则取无限大)
    const middleJobId = getId(queue[middle])

    // 中值是否比目标值小，小时缩减左边界
    middleJobId < id
      ? (start = middle + 1)
      : // 大时缩短右边界
        (end = middle)
  }

  // 返回目标位置
  return start
}

export function queueJob(job: SchedulerJob) {
  // the dedupe search uses the startIndex argument of Array.includes()
  // by default the search index includes the current job that is being run
  // so it cannot recursively trigger itself again.
  // 默认情况下查询当前任务是否存在时会从当前正常更新的下标开始，这样可以避免循环触发
  // if the job is a watch() callback, the search will start with a +1 index to
  // allow it recursively trigger itself - it is the user's responsibility to
  // ensure it doesn't end up in an infinite loop.
  // 如果一个任务是watch api的回调，那么会允许其循环调用，这时需要用户自己去控制避免无限循环
  if (
    // 当前队列为空
    (!queue.length ||
      // 或队列中不存在当前任务且当前任务不是前置任务
      !queue.includes(
        job,
        isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex
      )) &&
    // 防止更新props时，将当前渲染函数重复加入
    job !== currentPreFlushParentJob
  ) {
    // 无id的加入到最后
    if (job.id == null) {
      queue.push(job)

      // 有id的加入到合适的位置
    } else {
      queue.splice(findInsertionIndex(job.id), 0, job)
    }

    // 执行队列刷新
    queueFlush()
  }
}

function queueFlush() {
  // 当在进行队列刷新时或已在等待队列刷新时，不再次执行
  if (!isFlushing && !isFlushPending) {
    // 等待进行队列刷新
    isFlushPending = true

    // 时机在下一次task时
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

function queueCb(
  cb: SchedulerJobs,
  // 处理中队列
  activeQueue: SchedulerJob[] | null,
  // 等待处理队列
  pendingQueue: SchedulerJob[],
  // 当前处理中队列处理的任务下标
  index: number
) {
  // 单个调度任务
  if (!isArray(cb)) {
    // 为有激活队列时或激活队列不包含当前的effect时，将该effect添加到等待队列中
    if (
      !activeQueue ||

      // 如果当前effect允许重复调用，则从下一个effect处开始查找
      // (这里表示重复调用的effect作为新的effect调用)
      !activeQueue.includes(cb, cb.allowRecurse ? index + 1 : index)
    ) {
      pendingQueue.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    // 如果cb为数组，则说明其为数组的生命周期hook
    pendingQueue.push(...cb)
  }

  // 开始刷新队列
  queueFlush()
}

export function queuePreFlushCb(cb: SchedulerJob) {
  queueCb(cb, activePreFlushCbs, pendingPreFlushCbs, preFlushIndex)
}

export function queuePostFlushCb(cb: SchedulerJobs) {
  queueCb(cb, activePostFlushCbs, pendingPostFlushCbs, postFlushIndex)
}

// 处理预先队列，这些effect会再实例更新前执行
export function flushPreFlushCbs(
  // 已经执行过的effct
  seen?: CountMap,
  parentJob: SchedulerJob | null = null
) {
  // 如果有等待中的预执行函数
  if (pendingPreFlushCbs.length) {
    // 指定当前的父级调度函数(实际为组件的渲染函数)，防止重复加入
    currentPreFlushParentJob = parentJob

    // 过滤重复的effect，将effect载入预执行函数的激活队列
    // (同一时段执行的副作用函数不需要多次触发)
    activePreFlushCbs = [...new Set(pendingPreFlushCbs)]

    // 清空等待预执行函数队列的长度
    pendingPreFlushCbs.length = 0

    // 生成一个Map记录执行过的effect
    if (__DEV__) {
      seen = seen || new Map()
    }

    // 依次执行 激活队列中的函数
    // (这里执行的函数长度为无重复的，存在重复时某些effect会执行不到)
    for (
      preFlushIndex = 0;
      preFlushIndex < activePreFlushCbs.length;
      preFlushIndex++
    ) {
      // 记录当前effect的执行次数，超过100次报错
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePreFlushCbs[preFlushIndex])
      ) {
        continue
      }

      // 这期间加入预处理函数将在下一轮进行处理
      activePreFlushCbs[preFlushIndex]()
    }

    // 还原这些状态
    activePreFlushCbs = null
    preFlushIndex = 0

    // 重置父级任务
    currentPreFlushParentJob = null

    // recursively flush until it drains
    // 递归继续执行新生产的预执行函数
    flushPreFlushCbs(seen, parentJob)
  }
}

export function flushPostFlushCbs(seen?: CountMap) {
  if (pendingPostFlushCbs.length) {
    // 去重
    const deduped = [...new Set(pendingPostFlushCbs)]
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    // 如果已有post函数则说明正在执行了，则合并(可以单独调用api加入)，不用重复执行该函数了
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    // 执行
    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    // 同样的排序，父到子(Suspense组件)
    activePostFlushCbs.sort((a, b) => getId(a) - getId(b))

    // 执行后置执行函数
    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id

function flushJobs(seen?: CountMap) {
  // 进入task阶段，更改pending状态
  isFlushPending = false

  // 进入刷新队列阶段
  isFlushing = true

  // 开发模式下，进行循环任务报错
  if (__DEV__) {
    seen = seen || new Map()
  }

  // 执行预执行effect
  flushPreFlushCbs(seen)

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  // 1. 按父 ——》 子更新组件；如果父组件未挂载元素，则跳过该effect的执行
  queue.sort((a, b) => getId(a) - getId(b))

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    // 执行普通队列中的effect
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && job.active !== false) {
        if (__DEV__ && check(job)) {
          continue
        }
        // console.log(`running:`, job.id)
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    // 重置普通队列的参数
    flushIndex = 0
    queue.length = 0

    // 执行后置执行effect
    flushPostFlushCbs(seen)

    isFlushing = false
    currentFlushPromise = null
    // some postFlushCb queued jobs!
    // keep flushing until it drains.
    if (
      queue.length ||
      pendingPreFlushCbs.length ||
      pendingPostFlushCbs.length
    ) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  // 如果发现同一个函数执行就执行次数 + 1，最多执行100次
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.ownerInstance
      const componentName = instance && getComponentName(instance.type)
      warn(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
