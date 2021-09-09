import { toRaw, reactive, readonly, ReactiveFlags } from './reactive'
import { track, trigger, ITERATE_KEY, MAP_KEY_ITERATE_KEY } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  isObject,
  capitalize,
  hasOwn,
  hasChanged,
  toRawType,
  isMap
} from '@vue/shared'

export type CollectionTypes = IterableCollections | WeakCollections

type IterableCollections = Map<any, any> | Set<any>
type WeakCollections = WeakMap<any, any> | WeakSet<any>
type MapTypes = Map<any, any> | WeakMap<any, any>
type SetTypes = Set<any> | WeakSet<any>

const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value

const toReadonly = <T extends unknown>(value: T): T =>
  isObject(value) ? readonly(value as Record<any, any>) : value

const toShallow = <T extends unknown>(value: T): T => value

const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

// 集合的访问器函数
function get(
  target: MapTypes,
  key: unknown,
  isReadonly = false,
  isShallow = false
) {
  // #1772: readonly(reactive(Map)) should return readonly + reactive version
  // of the value

  // 获取被代理的原对象
  target = (target as any)[ReactiveFlags.RAW]

  // 获取底层的源对象(即没有被响应化处理的)
  const rawTarget = toRaw(target)

  // 获取键值的原值(针对Map)
  const rawKey = toRaw(key)

  // 在非只读且用于访问的键值为被代理的对象时, 进行`effect()`追踪
  if (key !== rawKey) {
    !isReadonly && track(rawTarget, TrackOpTypes.GET, key)
  }

  // 在非只读时，对原键值进行effect()追踪
  !isReadonly && track(rawTarget, TrackOpTypes.GET, rawKey)

  // 获取原生的has函数(防止effect追踪)
  const { has } = getProto(rawTarget)

  // 根据当前拦截器，决定其内部元素使用哪一种拦截器继续进行递归处理
  const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive

  // 访问具体某个字段时，递归对其进行代理处理
  if (has.call(rawTarget, key)) {
    return wrap(target.get(key))
  } else if (has.call(rawTarget, rawKey)) {
    return wrap(target.get(rawKey))
  } else if (target !== rawTarget) {
    // #3602 readonly(reactive(Map))
    // ensure that the nested reactive `Map` can do tracking for itself
    target.get(key)
  }
}

function has(this: CollectionTypes, key: unknown, isReadonly = false): boolean {
  // 被代理的对象
  const target = (this as any)[ReactiveFlags.RAW]

  // 最底层的纯对象
  const rawTarget = toRaw(target)

  // 获取当前key值的纯对象(防止是响应化的对象作为key)
  const rawKey = toRaw(key)

  // 同时进行两次effect()追踪
  if (key !== rawKey) {
    !isReadonly && track(rawTarget, TrackOpTypes.HAS, key)
  }
  !isReadonly && track(rawTarget, TrackOpTypes.HAS, rawKey)

  // 调用原函数行为，返回结果
  return key === rawKey
    ? target.has(key)
    : target.has(key) || target.has(rawKey)
}

function size(target: IterableCollections, isReadonly = false) {
  //  获取被代理的对象
  target = (target as any)[ReactiveFlags.RAW]

  // 在非只读时，对effect进行追踪
  !isReadonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)

  // 返回原值
  return Reflect.get(target, 'size', target)
}

function add(this: SetTypes, value: unknown) {
  // 获取添加的值的底层的原始对象
  value = toRaw(value)

  // 获取当前对象的底层的原始对象
  const target = toRaw(this)
  const proto = getProto(target)

  // 将这个对象作为元素加入进去
  const hadKey = proto.has.call(target, value)

  // 新增时进行effect更新提醒
  if (!hadKey) {
    target.add(value)
    trigger(target, TriggerOpTypes.ADD, value, value)
  }
  return this
}

function set(this: MapTypes, key: unknown, value: unknown) {
  // 获取设置值的底层原始对象
  value = toRaw(value)

  // 获取当前调用对象的底层原始对象
  const target = toRaw(this)

  // 获取原生的has/get函数
  const { has, get } = getProto(target)

  // 是否具有该值
  let hadKey = has.call(target, key)

  // 无时，看看是不是由于key为响应化对象
  // 所以不存在，这里取出原对象在查询一次
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)

    // 本地开发时
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  // 获取旧值
  const oldValue = get.call(target, key)

  // 写入新值
  target.set(key, value)

  // 新增或变更时，进行effect更新提醒
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, key, value)
  } else if (hasChanged(value, oldValue)) {
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  return this
}

function deleteEntry(this: CollectionTypes, key: unknown) {
  const target = toRaw(this)
  const { has, get } = getProto(target)
  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    // 用户是否用代理版本的key和纯版本的key
    // 分别存储了东西，报错
    checkIdentityKeys(target, has, key)
  }

  // 获取旧值(对于Set来说没有获取值的函数)
  const oldValue = get ? get.call(target, key) : undefined
  // forward the operation before queueing reactions

  // 执行删除操作
  const result = target.delete(key)

  // 触发effect更新
  if (hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

// 集合对象的清除函数
function clear(this: IterableCollections) {
  const target = toRaw(this)

  // 确保有东西可以清除
  // (对于Weak系列来说直接认为存在)
  const hadItems = target.size !== 0

  // 存储原集合对象
  const oldTarget = __DEV__
    ? isMap(target)
      ? new Map(target)
      : new Set(target)
    : undefined
  // forward the operation before queueing reactions
  // 执行清除操作
  const result = target.clear()

  // 触发effect更新
  if (hadItems) {
    trigger(target, TriggerOpTypes.CLEAR, undefined, undefined, oldTarget)
  }
  return result
}

// 创建forEach函数的拦截器
function createForEach(isReadonly: boolean, isShallow: boolean) {
  return function forEach(
    this: IterableCollections,
    callback: Function,
    thisArg?: unknown
  ) {
    // 当前被代理的对象
    const observed = this as any

    // 被代理的原对象(这有可能是一个被响应化后的对象)
    const target = observed[ReactiveFlags.RAW]

    // 被代理对象的最底层
    const rawTarget = toRaw(target)

    // 获取递归处理响应化的函数
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive

    // 非只读时进行effect追踪
    !isReadonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)

    // 调用forEach函数
    return target.forEach((value: unknown, key: unknown) => {
      // important: make sure the callback is
      // 1. invoked with the reactive map as `this` and 3rd arg
      // 2. the value received should be a corresponding reactive/readonly.
      // 模拟原forEach调用，将value/key处理为对应响应化对象，并将当前对象作为this传入第三个参数
      return callback.call(thisArg, wrap(value), wrap(key), observed)
    })
  }
}

interface Iterable {
  [Symbol.iterator](): Iterator
}

interface Iterator {
  next(value?: any): IterationResult
}

interface IterationResult {
  value: any
  done: boolean
}

function createIterableMethod(
  method: string | symbol, // 方法名
  isReadonly: boolean, // 是否只读
  isShallow: boolean // 是否浅式处理
) {
  return function (
    this: IterableCollections,
    ...args: unknown[]
  ): Iterable & Iterator {
    // 获取源对象(这有可能是一个响应化对象)
    // 你可以通过reactive(readonly(xxx))来实现
    const target = (this as any)[ReactiveFlags.RAW]

    // 获取源对象(完全没有响应化的)
    const rawTarget = toRaw(target)

    // 源对象是否为Map
    const targetIsMap = isMap(rawTarget)

    // 是否调用的迭代方法
    const isPair =
      method === 'entries' || (method === Symbol.iterator && targetIsMap)

    // 是否调用的keys方法(该方法仅Map有)
    const isKeyOnly = method === 'keys' && targetIsMap

    // 调用原方法
    const innerIterator = target[method](...args)
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive

    // 不是只读对象时，进行`effect()`追踪
    !isReadonly &&
      track(
        rawTarget,
        TrackOpTypes.ITERATE,
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
      )
    // return a wrapped iterator which returns observed versions of the
    // values emitted from the real iterator
    // 返回一个被处理后的迭代器对象，每个迭代器对象运行后都返回对应的处理后版本
    return {
      // iterator protocol
      next() {
        const { value, done } = innerIterator.next()
        return done
          ? { value, done }
          : {
              // 对值进行对应的递归处理
              value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
              done
            }
      },
      // iterable protocol
      [Symbol.iterator]() {
        return this
      }
    }
  }
}

function createReadonlyMethod(type: TriggerOpTypes): Function {
  return function (this: CollectionTypes, ...args: unknown[]) {
    if (__DEV__) {
      const key = args[0] ? `on key "${args[0]}" ` : ``
      console.warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        toRaw(this)
      )
    }
    return type === TriggerOpTypes.DELETE ? false : this
  }
}

function createInstrumentations() {
  const mutableInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key)
    },
    get size() {
      return size(this as unknown as IterableCollections)
    },
    has,
    add,
    set,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, false)
  }

  const shallowInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, false, true)
    },
    get size() {
      return size(this as unknown as IterableCollections)
    },
    has,
    add,
    set,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, true)
  }

  const readonlyInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, true)
    },
    get size() {
      return size(this as unknown as IterableCollections, true)
    },
    has(this: MapTypes, key: unknown) {
      return has.call(this, key, true)
    },
    add: createReadonlyMethod(TriggerOpTypes.ADD),
    set: createReadonlyMethod(TriggerOpTypes.SET),
    delete: createReadonlyMethod(TriggerOpTypes.DELETE),
    clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
    forEach: createForEach(true, false)
  }

  const shallowReadonlyInstrumentations: Record<string, Function> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, true, true)
    },
    get size() {
      return size(this as unknown as IterableCollections, true)
    },
    has(this: MapTypes, key: unknown) {
      return has.call(this, key, true)
    },
    add: createReadonlyMethod(TriggerOpTypes.ADD),
    set: createReadonlyMethod(TriggerOpTypes.SET),
    delete: createReadonlyMethod(TriggerOpTypes.DELETE),
    clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
    forEach: createForEach(true, true)
  }

  const iteratorMethods = ['keys', 'values', 'entries', Symbol.iterator]
  iteratorMethods.forEach(method => {
    mutableInstrumentations[method as string] = createIterableMethod(
      method,
      false,
      false
    )
    readonlyInstrumentations[method as string] = createIterableMethod(
      method,
      true,
      false
    )
    shallowInstrumentations[method as string] = createIterableMethod(
      method,
      false,
      true
    )
    shallowReadonlyInstrumentations[method as string] = createIterableMethod(
      method,
      true,
      true
    )
  })

  return [
    mutableInstrumentations,
    readonlyInstrumentations,
    shallowInstrumentations,
    shallowReadonlyInstrumentations
  ]
}

const [
  mutableInstrumentations,
  readonlyInstrumentations,
  shallowInstrumentations,
  shallowReadonlyInstrumentations
] = /* #__PURE__*/ createInstrumentations()

function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  // 根据当前传入的参数，决定使用哪种行为的高阶函数
  const instrumentations = shallow
    ? isReadonly
      ? shallowReadonlyInstrumentations
      : shallowInstrumentations
    : isReadonly
    ? readonlyInstrumentations
    : mutableInstrumentations

  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes
  ) => {
    // 是否为响应化
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly

      // 是否为只读
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly

      // 返回原对象
    } else if (key === ReactiveFlags.RAW) {
      return target
    }

    return Reflect.get(
      // 访问的方法是对象自身拥有的
      hasOwn(instrumentations, key) && key in target
        ? // 调用被处理后的该方法
          instrumentations
        : // 访问其他属性则直接访问原对象
          target,
      key,
      receiver
    )
  }
}

export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(false, false)
}

export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(false, true)
}

export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(true, false)
}

export const shallowReadonlyCollectionHandlers: ProxyHandler<CollectionTypes> =
  {
    get: /*#__PURE__*/ createInstrumentationGetter(true, true)
  }

function checkIdentityKeys(
  target: CollectionTypes,
  has: (key: unknown) => boolean,
  key: unknown
) {
  // 获取最底层原始值
  const rawKey = toRaw(key)

  // 如果用户的该key值存储存在代理化和未代理的两种情况，报错
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target)
    console.warn(
      `Reactive ${type} contains both the raw and reactive ` +
        `versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
        `which can lead to inconsistencies. ` +
        `Avoid differentiating between the raw and reactive versions ` +
        `of an object and only use the reactive version if possible.`
    )
  }
}
