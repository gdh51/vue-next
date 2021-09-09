import {
  camelize,
  EMPTY_OBJ,
  toHandlerKey,
  extend,
  hasOwn,
  hyphenate,
  isArray,
  isFunction,
  isOn,
  toNumber
} from '@vue/shared'
import {
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent,
  formatComponentName
} from './component'
import { callWithAsyncErrorHandling, ErrorCodes } from './errorHandling'
import { warn } from './warning'
import { UnionToIntersection } from './helpers/typeUtils'
import { devtoolsComponentEmit } from './devtools'
import { AppContext } from './apiCreateApp'
import { emit as compatInstanceEmit } from './compat/instanceEventEmitter'
import {
  compatModelEventPrefix,
  compatModelEmit
} from './compat/componentVModel'

export type ObjectEmitsOptions = Record<
  string,
  ((...args: any[]) => any) | null
>

export type EmitsOptions = ObjectEmitsOptions | string[]

export type EmitsToProps<T extends EmitsOptions> = T extends string[]
  ? {
      [K in string & `on${Capitalize<T[number]>}`]?: (...args: any[]) => any
    }
  : T extends ObjectEmitsOptions
  ? {
      [K in string &
        `on${Capitalize<string & keyof T>}`]?: K extends `on${infer C}`
        ? T[Uncapitalize<C>] extends null
          ? (...args: any[]) => any
          : (
              ...args: T[Uncapitalize<C>] extends (...args: infer P) => any
                ? P
                : never
            ) => any
        : never
    }
  : {}

export type EmitFn<
  Options = ObjectEmitsOptions,
  Event extends keyof Options = keyof Options
> = Options extends Array<infer V>
  ? (event: V, ...args: any[]) => void
  : {} extends Options // if the emit is empty object (usually the default value for emit) should be converted to function
  ? (event: string, ...args: any[]) => void
  : UnionToIntersection<
      {
        [key in Event]: Options[key] extends (...args: infer Args) => any
          ? (event: key, ...args: Args) => void
          : (event: key, ...args: any[]) => void
      }[Event]
    >

export function emit(
  instance: ComponentInternalInstance, //当前上下文
  event: string, // 事件名称
  ...rawArgs: any[] // 事件参数
) {
  // 获取props
  const props = instance.vnode.props || EMPTY_OBJ

  // 本地开发模式下，检查
  if (__DEV__) {
    const {
      emitsOptions,
      propsOptions: [propsOptions]
    } = instance
    if (emitsOptions) {
      // 当前事件不在emits定义内时(排除两个兼容的特殊的事件)
      if (
        !(event in emitsOptions) &&
        !(
          __COMPAT__ &&
          (event.startsWith('hook:') ||
            event.startsWith(compatModelEventPrefix))
        )
      ) {
        // 且该事件处理函数未定义在props中(以onEvent的形式)
        if (!propsOptions || !(toHandlerKey(event) in propsOptions)) {
          warn(
            `Component emitted event "${event}" but it is neither declared in ` +
              `the emits option nor as an "${toHandlerKey(event)}" prop.`
          )
        }
      } else {
        // 事件存在时，验证其是否通过校验器
        const validator = emitsOptions[event]
        if (isFunction(validator)) {
          const isValid = validator(...rawArgs)
          if (!isValid) {
            warn(
              `Invalid event arguments: event validation failed for event "${event}".`
            )
          }
        }
      }
    }
  }

  let args = rawArgs

  // 是否为v-model事件
  const isModelListener = event.startsWith('update:')

  // for v-model update:xxx events, apply modifiers on args
  // 提取事件名称
  const modelArg = isModelListener && event.slice(7)

  // 确保用户有与事件对于的prop
  if (modelArg && modelArg in props) {
    // 获取对应修饰器
    const modifiersKey = `${
      modelArg === 'modelValue' ? 'model' : modelArg
    }Modifiers`

    // 修饰器处理
    const { number, trim } = props[modifiersKey] || EMPTY_OBJ
    if (trim) {
      args = rawArgs.map(a => a.trim())
    } else if (number) {
      args = rawArgs.map(toNumber)
    }
  }

  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    devtoolsComponentEmit(instance, event, args)
  }

  if (__DEV__) {
    const lowerCaseEvent = event.toLowerCase()
    if (lowerCaseEvent !== event && props[toHandlerKey(lowerCaseEvent)]) {
      warn(
        `Event "${lowerCaseEvent}" is emitted in component ` +
          `${formatComponentName(
            instance,
            instance.type
          )} but the handler is registered for "${event}". ` +
          `Note that HTML attributes are case-insensitive and you cannot use ` +
          `v-on to listen to camelCase events when using in-DOM templates. ` +
          `You should probably use "${hyphenate(event)}" instead of "${event}".`
      )
    }
  }

  let handlerName
  let handler =
    props[(handlerName = toHandlerKey(event))] ||
    // also try camelCase event handler (#2249)
    props[(handlerName = toHandlerKey(camelize(event)))]
  // for v-model update:xxx events, also trigger kebab-case equivalent
  // for props passed via kebab-case
  if (!handler && isModelListener) {
    handler = props[(handlerName = toHandlerKey(hyphenate(event)))]
  }

  if (handler) {
    callWithAsyncErrorHandling(
      handler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }

  const onceHandler = props[handlerName + `Once`]
  if (onceHandler) {
    if (!instance.emitted) {
      instance.emitted = {} as Record<any, boolean>
    } else if (instance.emitted[handlerName]) {
      return
    }
    instance.emitted[handlerName] = true
    callWithAsyncErrorHandling(
      onceHandler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }

  if (__COMPAT__) {
    compatModelEmit(instance, event, args)
    return compatInstanceEmit(instance, event, args)
  }
}

export function normalizeEmitsOptions(
  comp: ConcreteComponent, // 组件配置对象
  appContext: AppContext,
  asMixin = false
): ObjectEmitsOptions | null {
  const cache = appContext.emitsCache
  const cached = cache.get(comp)

  // 优先从当前应用缓存中获取emits(可以缓存null)
  if (cached !== undefined) {
    return cached
  }

  // 获取当前组件能发出的自定义事件
  const raw = comp.emits
  let normalized: ObjectEmitsOptions = {}

  // apply mixin/extends props
  let hasExtends = false

  // 支持options语法
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    const extendEmits = (raw: ComponentOptions) => {
      const normalizedFromExtend = normalizeEmitsOptions(raw, appContext, true)
      if (normalizedFromExtend) {
        hasExtends = true
        extend(normalized, normalizedFromExtend)
      }
    }

    // 继承应用下全局(非mixin)
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendEmits)
    }

    // 组件拓展式继承
    if (comp.extends) {
      extendEmits(comp.extends)
    }

    // 从当前组件的minxin中获取
    if (comp.mixins) {
      comp.mixins.forEach(extendEmits)
    }
  }

  // 未定义或继承时，设置当前组件缓存并退出
  if (!raw && !hasExtends) {
    cache.set(comp, null)
    return null
  }

  // 数组形式时，简单格式化
  if (isArray(raw)) {
    raw.forEach(key => (normalized[key] = null))

    // 对象形式时，简单合并
  } else {
    extend(normalized, raw)
  }

  // 设置缓存
  cache.set(comp, normalized)
  return normalized
}

// Check if an incoming prop key is a declared emit event listener.
// e.g. With `emits: { click: null }`, props named `onClick` and `onclick` are
// both considered matched listeners.
export function isEmitListener(
  options: ObjectEmitsOptions | null,
  key: string
): boolean {
  if (!options || !isOn(key)) {
    return false
  }

  if (__COMPAT__ && key.startsWith(compatModelEventPrefix)) {
    return true
  }

  key = key.slice(2).replace(/Once$/, '')
  return (
    hasOwn(options, key[0].toLowerCase() + key.slice(1)) ||
    hasOwn(options, hyphenate(key)) ||
    hasOwn(options, key)
  )
}
