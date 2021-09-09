import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  ElementTypes,
  CallExpression,
  ObjectExpression,
  ElementNode,
  DirectiveNode,
  ExpressionNode,
  ArrayExpression,
  createCallExpression,
  createArrayExpression,
  createObjectProperty,
  createSimpleExpression,
  createObjectExpression,
  Property,
  ComponentNode,
  VNodeCall,
  TemplateTextChildNode,
  DirectiveArguments,
  createVNodeCall,
  ConstantTypes
} from '../ast'
import {
  PatchFlags,
  PatchFlagNames,
  isSymbol,
  isOn,
  isObject,
  isReservedProp,
  capitalize,
  camelize
} from '@vue/shared'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  RESOLVE_DIRECTIVE,
  RESOLVE_COMPONENT,
  RESOLVE_DYNAMIC_COMPONENT,
  MERGE_PROPS,
  NORMALIZE_CLASS,
  NORMALIZE_STYLE,
  NORMALIZE_PROPS,
  TO_HANDLERS,
  TELEPORT,
  KEEP_ALIVE,
  SUSPENSE,
  UNREF,
  GUARD_REACTIVE_PROPS
} from '../runtimeHelpers'
import {
  getInnerRange,
  toValidAssetId,
  findProp,
  isCoreComponent,
  isBindKey,
  findDir,
  isStaticExp
} from '../utils'
import { buildSlots } from './vSlot'
import { getConstantType } from './hoistStatic'
import { BindingTypes } from '../options'
import {
  checkCompatEnabled,
  CompilerDeprecationTypes,
  isCompatEnabled
} from '../compat/compatConfig'

// some directive transforms (e.g. v-model) may return a symbol for runtime
// import, which should be used instead of a resolveDirective call.
const directiveImportMap = new WeakMap<DirectiveNode, symbol>()

// generate a JavaScript AST for this element's codegen
export const transformElement: NodeTransform = (node, context) => {
  // perform the work on exit, after all child expressions have been
  // processed and merged.
  // 在全部子节点表达式处理后调用
  // 处理插槽内容、属性等等，标记更新flags并
  // 生成codegenNode
  return function postTransformElement() {
    node = context.currentNode!

    // 非元素或组件节点退出
    if (
      !(
        node.type === NodeTypes.ELEMENT &&
        (node.tagType === ElementTypes.ELEMENT ||
          node.tagType === ElementTypes.COMPONENT)
      )
    ) {
      return
    }

    const { tag, props } = node
    const isComponent = node.tagType === ElementTypes.COMPONENT

    // The goal of the transform is to create a codegenNode implementing the
    // VNodeCall interface.
    // 转化的目的是创建一个可以代表VNode调用的codegenNode

    // 获取组件配置或当前元素标签
    let vnodeTag = isComponent
      ? resolveComponentType(node as ComponentNode, context)
      : `"${tag}"`

    const isDynamicComponent =
      isObject(vnodeTag) && vnodeTag.callee === RESOLVE_DYNAMIC_COMPONENT

    let vnodeProps: VNodeCall['props']
    let vnodeChildren: VNodeCall['children']
    let vnodePatchFlag: VNodeCall['patchFlag']
    let patchFlag: number = 0
    let vnodeDynamicProps: VNodeCall['dynamicProps']
    let dynamicPropNames: string[] | undefined
    let vnodeDirectives: VNodeCall['directives']

    // 是否应该为当前节点应用Block
    let shouldUseBlock =
      // dynamic component may resolve to plain elements
      // 动态组件也可以解析为普通元素
      isDynamicComponent ||
      vnodeTag === TELEPORT ||
      vnodeTag === SUSPENSE ||
      // 普通元素只有svg或foreignObject或有动态key值的元素使用
      (!isComponent &&
        // <svg> and <foreignObject> must be forced into blocks so that block
        // updates inside get proper isSVG flag at runtime. (#639, #643)
        // This is technically web-specific, but splitting the logic out of core
        // leads to too much unnecessary complexity.
        (tag === 'svg' ||
          tag === 'foreignObject' ||
          // #938: elements with dynamic keys should be forced into blocks
          findProp(node, 'key', true)))

    // props
    // 处理元素上的属性
    if (props.length > 0) {
      const propsBuildResult = buildProps(node, context)
      vnodeProps = propsBuildResult.props
      patchFlag = propsBuildResult.patchFlag
      dynamicPropNames = propsBuildResult.dynamicPropNames
      const directives = propsBuildResult.directives
      vnodeDirectives =
        directives && directives.length
          ? (createArrayExpression(
              directives.map(dir => buildDirectiveArgs(dir, context))
            ) as DirectiveArguments)
          : undefined
    }

    // children
    // 具有子节点
    if (node.children.length > 0) {
      // 当前组件为keepAlive
      if (vnodeTag === KEEP_ALIVE) {
        // Although a built-in component, we compile KeepAlive with raw children
        // instead of slot functions so that it can be used inside Transition
        // or other Transition-wrapping HOCs.
        // To ensure correct updates with block optimizations, we need to:
        // 1. Force keep-alive into a block. This avoids its children being
        //    collected by a parent block.
        shouldUseBlock = true

        // 2. Force keep-alive to always be updated, since it uses raw children.
        patchFlag |= PatchFlags.DYNAMIC_SLOTS

        // dev
        if (__DEV__ && node.children.length > 1) {
          context.onError(
            createCompilerError(ErrorCodes.X_KEEP_ALIVE_INVALID_CHILDREN, {
              start: node.children[0].loc.start,
              end: node.children[node.children.length - 1].loc.end,
              source: ''
            })
          )
        }
      }

      /* 是否已经处理当前组件的插槽内容，
       * 条件当前节点为组件且具有插槽内容。
       * TELEPORT/KEEPALIVE组件不进行处理，
       * 因为它们不是真实的组件，且它们有各自的独立处理
       */
      const shouldBuildAsSlots =
        isComponent &&
        // Teleport is not a real component and has dedicated runtime handling
        vnodeTag !== TELEPORT &&
        // explained above.
        vnodeTag !== KEEP_ALIVE

      // 处理插槽内容
      if (shouldBuildAsSlots) {
        // 提取插槽内容，将其节点转化为函数
        const { slots, hasDynamicSlots } = buildSlots(node, context)

        // 设置当前节点的子节点
        vnodeChildren = slots

        // 具有动态插槽时，将patchFlag上标记
        if (hasDynamicSlots) {
          patchFlag |= PatchFlags.DYNAMIC_SLOTS
        }

        // 单个子节点且不为TELEPORT组件时
      } else if (node.children.length === 1 && vnodeTag !== TELEPORT) {
        const child = node.children[0]
        const type = child.type

        // check for dynamic text children
        // 子节点为动态的文本节点
        const hasDynamicTextChild =
          type === NodeTypes.INTERPOLATION ||
          type === NodeTypes.COMPOUND_EXPRESSION

        // 如果为动态文本则记录在patchFlags上
        if (
          hasDynamicTextChild &&
          getConstantType(child, context) === ConstantTypes.NOT_CONSTANT
        ) {
          patchFlag |= PatchFlags.TEXT
        }

        // pass directly if the only child is a text node
        // (plain / interpolation / expression)
        if (hasDynamicTextChild || type === NodeTypes.TEXT) {
          vnodeChildren = child as TemplateTextChildNode
        } else {
          vnodeChildren = node.children
        }

        // 其余情况直接赋值
      } else {
        vnodeChildren = node.children
      }
    }

    // patchFlag & dynamicPropNames
    // 节点需要在patch时更新
    if (patchFlag !== 0) {
      if (__DEV__) {
        if (patchFlag < 0) {
          // special flags (negative and mutually exclusive)
          vnodePatchFlag = patchFlag + ` /* ${PatchFlagNames[patchFlag]} */`
        } else {
          // bitwise flags
          const flagNames = Object.keys(PatchFlagNames)
            .map(Number)
            .filter(n => n > 0 && patchFlag & n)
            .map(n => PatchFlagNames[n])
            .join(`, `)
          vnodePatchFlag = patchFlag + ` /* ${flagNames} */`
        }
      } else {
        // 将patchFlags 字符串化
        vnodePatchFlag = String(patchFlag)
      }

      // 将动态prop转化为数组形式
      if (dynamicPropNames && dynamicPropNames.length) {
        vnodeDynamicProps = stringifyDynamicPropNames(dynamicPropNames)
      }
    }

    // 为当前节点创建codegen节点
    node.codegenNode = createVNodeCall(
      context,
      vnodeTag,
      vnodeProps,
      vnodeChildren,
      vnodePatchFlag,
      vnodeDynamicProps,
      vnodeDirectives,
      !!shouldUseBlock,
      false /* disableTracking */,
      isComponent,
      node.loc
    )
  }
}

// 计算组件类型
export function resolveComponentType(
  node: ComponentNode,
  context: TransformContext,
  ssr = false
) {
  let { tag } = node

  // 1. dynamic component
  // 1. 动态组件
  const isExplicitDynamic = isComponentTag(tag)
  const isProp = findProp(node, 'is')

  // 特征，具有is属性
  if (isProp) {
    // 为动态组件
    if (
      isExplicitDynamic ||
      // 兼容v2
      (__COMPAT__ &&
        isCompatEnabled(
          CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
          context
        ))
    ) {
      const exp =
        isProp.type === NodeTypes.ATTRIBUTE
          ? isProp.value && createSimpleExpression(isProp.value.content, true)
          : isProp.exp
      if (exp) {
        return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
          exp
        ])
      }

      // 非动态组件，像以下例子一样也会作为组件
    } else if (
      isProp.type === NodeTypes.ATTRIBUTE &&
      isProp.value!.content.startsWith('vue:')
    ) {
      // <button is="vue:xxx">
      // if not <component>, only is value that starts with "vue:" will be
      // treated as component by the parse phase and reach here, unless it's
      // compat mode where all is values are considered components
      tag = isProp.value!.content.slice(4)
    }
  }

  // 1.5 v-is (TODO: Deprecate)
  const isDir = !isExplicitDynamic && findDir(node, 'is')
  if (isDir && isDir.exp) {
    return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
      isDir.exp
    ])
  }

  // 2. built-in components (Teleport, Transition, KeepAlive, Suspense...)
  // 2. 内置组件
  const builtIn = isCoreComponent(tag) || context.isBuiltInComponent(tag)
  if (builtIn) {
    // built-ins are simply fallthroughs / have special handling during ssr
    // so we don't need to import their runtime equivalents
    if (!ssr) context.helper(builtIn)
    return builtIn
  }

  // 3. user component (from setup bindings)
  // this is skipped in browser build since browser builds do not perform
  // binding analysis.
  if (!__BROWSER__) {
    const fromSetup = resolveSetupReference(tag, context)
    if (fromSetup) {
      return fromSetup
    }
    const dotIndex = tag.indexOf('.')
    if (dotIndex > 0) {
      const ns = resolveSetupReference(tag.slice(0, dotIndex), context)
      if (ns) {
        return ns + tag.slice(dotIndex)
      }
    }
  }

  // 4. Self referencing component (inferred from filename)
  if (
    !__BROWSER__ &&
    context.selfName &&
    capitalize(camelize(tag)) === context.selfName
  ) {
    context.helper(RESOLVE_COMPONENT)
    // codegen.ts has special check for __self postfix when generating
    // component imports, which will pass additional `maybeSelfReference` flag
    // to `resolveComponent`.
    context.components.add(tag + `__self`)
    return toValidAssetId(tag, `component`)
  }

  // 5. user component (resolve)
  context.helper(RESOLVE_COMPONENT)
  context.components.add(tag)
  return toValidAssetId(tag, `component`)
}

function resolveSetupReference(name: string, context: TransformContext) {
  const bindings = context.bindingMetadata
  if (!bindings || bindings.__isScriptSetup === false) {
    return
  }

  const camelName = camelize(name)
  const PascalName = capitalize(camelName)
  const checkType = (type: BindingTypes) => {
    if (bindings[name] === type) {
      return name
    }
    if (bindings[camelName] === type) {
      return camelName
    }
    if (bindings[PascalName] === type) {
      return PascalName
    }
  }

  const fromConst = checkType(BindingTypes.SETUP_CONST)
  if (fromConst) {
    return context.inline
      ? // in inline mode, const setup bindings (e.g. imports) can be used as-is
        fromConst
      : `$setup[${JSON.stringify(fromConst)}]`
  }

  const fromMaybeRef =
    checkType(BindingTypes.SETUP_LET) ||
    checkType(BindingTypes.SETUP_REF) ||
    checkType(BindingTypes.SETUP_MAYBE_REF)
  if (fromMaybeRef) {
    return context.inline
      ? // setup scope bindings that may be refs need to be unrefed
        `${context.helperString(UNREF)}(${fromMaybeRef})`
      : `$setup[${JSON.stringify(fromMaybeRef)}]`
  }
}

export type PropsExpression = ObjectExpression | CallExpression | ExpressionNode

export function buildProps(
  node: ElementNode,
  context: TransformContext,
  props: ElementNode['props'] = node.props,
  ssr = false
): {
  props: PropsExpression | undefined
  directives: DirectiveNode[]
  patchFlag: number
  dynamicPropNames: string[]
} {
  const { tag, loc: elementLoc } = node
  const isComponent = node.tagType === ElementTypes.COMPONENT
  let properties: ObjectExpression['properties'] = []
  const mergeArgs: PropsExpression[] = []
  const runtimeDirectives: DirectiveNode[] = []

  // patchFlag analysis
  let patchFlag = 0
  let hasRef = false
  let hasClassBinding = false
  let hasStyleBinding = false
  let hasHydrationEventBinding = false
  let hasDynamicKeys = false
  let hasVnodeHook = false
  const dynamicPropNames: string[] = []

  // 分析AST对象的patchFlag
  const analyzePatchFlag = ({ key, value }: Property) => {
    // 当前对象的key是否为静态
    if (isStaticExp(key)) {
      const name = key.content
      const isEventHandler = isOn(name)

      // 复合事件
      if (
        !isComponent &&
        isEventHandler &&
        // omit the flag for click handlers because hydration gives click
        // dedicated fast path.
        name.toLowerCase() !== 'onclick' &&
        // omit v-model handlers
        name !== 'onUpdate:modelValue' &&
        // omit onVnodeXXX hooks
        !isReservedProp(name)
      ) {
        hasHydrationEventBinding = true
      }

      // Vnode Hook
      if (isEventHandler && isReservedProp(name)) {
        hasVnodeHook = true
      }

      // 当属性为常量值时跳过
      if (
        value.type === NodeTypes.JS_CACHE_EXPRESSION ||
        ((value.type === NodeTypes.SIMPLE_EXPRESSION ||
          value.type === NodeTypes.COMPOUND_EXPRESSION) &&
          getConstantType(value, context) > 0)
      ) {
        // skip if the prop is a cached handler or has constant value
        return
      }

      if (name === 'ref') {
        hasRef = true
      } else if (name === 'class') {
        hasClassBinding = true
      } else if (name === 'style') {
        hasStyleBinding = true
      } else if (name !== 'key' && !dynamicPropNames.includes(name)) {
        dynamicPropNames.push(name)
      }

      // treat the dynamic class and style binding of the component as dynamic props
      if (
        isComponent &&
        (name === 'class' || name === 'style') &&
        !dynamicPropNames.includes(name)
      ) {
        dynamicPropNames.push(name)
      }
    } else {
      hasDynamicKeys = true
    }
  }

  // 遍历属性
  for (let i = 0; i < props.length; i++) {
    // static attribute
    const prop = props[i]

    // 静态属性
    if (prop.type === NodeTypes.ATTRIBUTE) {
      const { loc, name, value } = prop
      let isStatic = true

      // 当前属性为ref
      if (name === 'ref') {
        hasRef = true
        // in inline mode there is no setupState object, so we can't use string
        // keys to set the ref. Instead, we need to transform it to pass the
        // acrtual ref instead.
        // 非浏览器环境
        if (!__BROWSER__ && context.inline) {
          isStatic = false
        }
      }

      // skip is on <component>, or is="vue:xxx"
      // 跳过上述情况
      if (
        name === 'is' &&
        (isComponentTag(tag) ||
          (value && value.content.startsWith('vue:')) ||
          (__COMPAT__ &&
            isCompatEnabled(
              CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
              context
            )))
      ) {
        continue
      }

      // 添加静态属性
      properties.push(
        // 创建key ast
        createObjectProperty(
          createSimpleExpression(
            name,
            true,
            getInnerRange(loc, 0, name.length)
          ),

          // 创建value ast
          createSimpleExpression(
            value ? value.content : '',
            isStatic,
            value ? value.loc : loc
          )
        )
      )

      // 指令
    } else {
      // directives
      const { name, arg, exp, loc } = prop
      const isVBind = name === 'bind'
      const isVOn = name === 'on'

      // skip v-slot - it is handled by its dedicated transform.
      // 跳过 v-slot有专门的处理
      if (name === 'slot') {
        if (!isComponent) {
          context.onError(
            createCompilerError(ErrorCodes.X_V_SLOT_MISPLACED, loc)
          )
        }
        continue
      }
      // skip v-once/v-memo - they are handled by dedicated transforms.
      if (name === 'once' || name === 'memo') {
        continue
      }
      // skip v-is and :is on <component>
      if (
        name === 'is' ||
        (isVBind &&
          isBindKey(arg, 'is') &&
          (isComponentTag(tag) ||
            (__COMPAT__ &&
              isCompatEnabled(
                CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
                context
              ))))
      ) {
        continue
      }
      // skip v-on in SSR compilation
      if (isVOn && ssr) {
        continue
      }

      // special case for v-bind and v-on with no argument
      // 处理v-bind/v-on对象语法
      if (!arg && (isVBind || isVOn)) {
        hasDynamicKeys = true

        // 右值
        if (exp) {
          // 具有属性时
          if (properties.length) {
            // 将属性整合后加入到mergeArgs中
            mergeArgs.push(
              createObjectExpression(dedupeProperties(properties), elementLoc)
            )

            // 清空已处理属性
            properties = []
          }

          if (isVBind) {
            // 兼容，跳过
            if (__COMPAT__) {
              // 2.x v-bind object order compat
              if (__DEV__) {
                const hasOverridableKeys = mergeArgs.some(arg => {
                  if (arg.type === NodeTypes.JS_OBJECT_EXPRESSION) {
                    return arg.properties.some(({ key }) => {
                      if (
                        key.type !== NodeTypes.SIMPLE_EXPRESSION ||
                        !key.isStatic
                      ) {
                        return true
                      }
                      return (
                        key.content !== 'class' &&
                        key.content !== 'style' &&
                        !isOn(key.content)
                      )
                    })
                  } else {
                    // dynamic expression
                    return true
                  }
                })
                if (hasOverridableKeys) {
                  checkCompatEnabled(
                    CompilerDeprecationTypes.COMPILER_V_BIND_OBJECT_ORDER,
                    context,
                    loc
                  )
                }
              }

              if (
                isCompatEnabled(
                  CompilerDeprecationTypes.COMPILER_V_BIND_OBJECT_ORDER,
                  context
                )
              ) {
                mergeArgs.unshift(exp)
                continue
              }
            }

            mergeArgs.push(exp)
          } else {
            // v-on="obj" -> toHandlers(obj)
            mergeArgs.push({
              type: NodeTypes.JS_CALL_EXPRESSION,
              loc,
              callee: context.helper(TO_HANDLERS),
              arguments: [exp]
            })
          }

          // 不写表达式，报错
        } else {
          context.onError(
            createCompilerError(
              isVBind
                ? ErrorCodes.X_V_BIND_NO_EXPRESSION
                : ErrorCodes.X_V_ON_NO_EXPRESSION,
              loc
            )
          )
        }
        continue
      }

      // 指令转化，三个on/bind/model
      const directiveTransform = context.directiveTransforms[name]

      // 是对应指令时，进行转化
      if (directiveTransform) {
        // has built-in directive transform.
        // 直接调用转化
        const { props, needRuntime } = directiveTransform(prop, node, context)

        // 浏览器环境下，分析patchFlag
        !ssr && props.forEach(analyzePatchFlag)

        // 重新归纳props
        properties.push(...props)

        // 运行时指令
        if (needRuntime) {
          runtimeDirectives.push(prop)
          if (isSymbol(needRuntime)) {
            directiveImportMap.set(prop, needRuntime)
          }
        }

        // 其余指令加入运行时指令合集中
      } else {
        // no built-in transform, this is a user custom directive.
        runtimeDirectives.push(prop)
      }
    }

    // 兼容
    if (
      __COMPAT__ &&
      prop.type === NodeTypes.ATTRIBUTE &&
      prop.name === 'ref' &&
      context.scopes.vFor > 0 &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_V_FOR_REF,
        context,
        prop.loc
      )
    ) {
      properties.push(
        createObjectProperty(
          createSimpleExpression('refInFor', true),
          createSimpleExpression('true', false)
        )
      )
    }
  }

  let propsExpression: PropsExpression | undefined = undefined

  // has v-bind="object" or v-on="object", wrap with mergeProps
  // 处理v-bind/v-on对象形式写法
  if (mergeArgs.length) {
    if (properties.length) {
      mergeArgs.push(
        createObjectExpression(dedupeProperties(properties), elementLoc)
      )
    }

    // 具有属性时，创建调用表达式
    if (mergeArgs.length > 1) {
      propsExpression = createCallExpression(
        context.helper(MERGE_PROPS),
        mergeArgs,
        elementLoc
      )

      // 单独v-bind时，不需要处理
    } else {
      // single v-bind with nothing else - no need for a mergeProps call
      propsExpression = mergeArgs[0]
    }
  } else if (properties.length) {
    propsExpression = createObjectExpression(
      dedupeProperties(properties),
      elementLoc
    )
  }

  // patchFlag analysis
  // 分析当前元素的patchFlag
  // 打上patchFlag
  if (hasDynamicKeys) {
    patchFlag |= PatchFlags.FULL_PROPS
  } else {
    if (hasClassBinding && !isComponent) {
      patchFlag |= PatchFlags.CLASS
    }
    if (hasStyleBinding && !isComponent) {
      patchFlag |= PatchFlags.STYLE
    }
    if (dynamicPropNames.length) {
      patchFlag |= PatchFlags.PROPS
    }
    if (hasHydrationEventBinding) {
      patchFlag |= PatchFlags.HYDRATE_EVENTS
    }
  }

  // 无patchFlag或具有符合事件且具有其他特殊属性，强制patch
  if (
    (patchFlag === 0 || patchFlag === PatchFlags.HYDRATE_EVENTS) &&
    (hasRef || hasVnodeHook || runtimeDirectives.length > 0)
  ) {
    patchFlag |= PatchFlags.NEED_PATCH
  }

  // pre-normalize props, SSR is skipped for now
  if (!context.inSSR && propsExpression) {
    switch (propsExpression.type) {
      case NodeTypes.JS_OBJECT_EXPRESSION:
        // means that there is no v-bind,
        // but still need to deal with dynamic key binding
        let classKeyIndex = -1
        let styleKeyIndex = -1
        let hasDynamicKey = false

        for (let i = 0; i < propsExpression.properties.length; i++) {
          const key = propsExpression.properties[i].key
          if (isStaticExp(key)) {
            if (key.content === 'class') {
              classKeyIndex = i
            } else if (key.content === 'style') {
              styleKeyIndex = i
            }
          } else if (!key.isHandlerKey) {
            hasDynamicKey = true
          }
        }

        const classProp = propsExpression.properties[classKeyIndex]
        const styleProp = propsExpression.properties[styleKeyIndex]

        // no dynamic key
        if (!hasDynamicKey) {
          if (classProp && !isStaticExp(classProp.value)) {
            classProp.value = createCallExpression(
              context.helper(NORMALIZE_CLASS),
              [classProp.value]
            )
          }
          if (
            styleProp &&
            !isStaticExp(styleProp.value) &&
            // the static style is compiled into an object,
            // so use `hasStyleBinding` to ensure that it is a dynamic style binding
            (hasStyleBinding ||
              // v-bind:style and style both exist,
              // v-bind:style with static literal object
              styleProp.value.type === NodeTypes.JS_ARRAY_EXPRESSION)
          ) {
            styleProp.value = createCallExpression(
              context.helper(NORMALIZE_STYLE),
              [styleProp.value]
            )
          }
        } else {
          // dynamic key binding, wrap with `normalizeProps`
          propsExpression = createCallExpression(
            context.helper(NORMALIZE_PROPS),
            [propsExpression]
          )
        }
        break
      case NodeTypes.JS_CALL_EXPRESSION:
        // mergeProps call, do nothing
        break
      default:
        // single v-bind
        propsExpression = createCallExpression(
          context.helper(NORMALIZE_PROPS),
          [
            createCallExpression(context.helper(GUARD_REACTIVE_PROPS), [
              propsExpression
            ])
          ]
        )
        break
    }
  }

  return {
    props: propsExpression,
    directives: runtimeDirectives,
    patchFlag,
    dynamicPropNames
  }
}

// Dedupe props in an object literal.
// Literal duplicated attributes would have been warned during the parse phase,
// however, it's possible to encounter duplicated `onXXX` handlers with different
// modifiers. We also need to merge static and dynamic class / style attributes.
// - onXXX handlers / style: merge into array
// - class: merge into single expression with concatenation
function dedupeProperties(properties: Property[]): Property[] {
  const knownProps: Map<string, Property> = new Map()
  const deduped: Property[] = []

  // 遍历属性，找出重复属性
  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i]

    // dynamic keys are always allowed
    // 动态prop名，直接加入去重数组
    if (prop.key.type === NodeTypes.COMPOUND_EXPRESSION || !prop.key.isStatic) {
      deduped.push(prop)
      continue
    }

    // 非动态属性
    const name = prop.key.content
    const existing = knownProps.get(name)

    // 已存在的
    if (existing) {
      // 合并属性
      if (name === 'style' || name === 'class' || name.startsWith('on')) {
        // 合并到一个数组ast
        mergeAsArray(existing, prop)
      }

      // 其余重复属性在parse阶段报错
      // unexpected duplicate, should have emitted error during parse
    } else {
      knownProps.set(name, prop)
      deduped.push(prop)
    }
  }
  return deduped
}

function mergeAsArray(existing: Property, incoming: Property) {
  if (existing.value.type === NodeTypes.JS_ARRAY_EXPRESSION) {
    existing.value.elements.push(incoming.value)
  } else {
    existing.value = createArrayExpression(
      [existing.value, incoming.value],
      existing.loc
    )
  }
}

function buildDirectiveArgs(
  dir: DirectiveNode,
  context: TransformContext
): ArrayExpression {
  const dirArgs: ArrayExpression['elements'] = []
  const runtime = directiveImportMap.get(dir)
  if (runtime) {
    // built-in directive with runtime
    dirArgs.push(context.helperString(runtime))
  } else {
    // user directive.
    // see if we have directives exposed via <script setup>
    const fromSetup =
      !__BROWSER__ && resolveSetupReference('v-' + dir.name, context)
    if (fromSetup) {
      dirArgs.push(fromSetup)
    } else {
      // inject statement for resolving directive
      context.helper(RESOLVE_DIRECTIVE)
      context.directives.add(dir.name)
      dirArgs.push(toValidAssetId(dir.name, `directive`))
    }
  }
  const { loc } = dir
  if (dir.exp) dirArgs.push(dir.exp)
  if (dir.arg) {
    if (!dir.exp) {
      dirArgs.push(`void 0`)
    }
    dirArgs.push(dir.arg)
  }
  if (Object.keys(dir.modifiers).length) {
    if (!dir.arg) {
      if (!dir.exp) {
        dirArgs.push(`void 0`)
      }
      dirArgs.push(`void 0`)
    }
    const trueExpression = createSimpleExpression(`true`, false, loc)
    dirArgs.push(
      createObjectExpression(
        dir.modifiers.map(modifier =>
          createObjectProperty(modifier, trueExpression)
        ),
        loc
      )
    )
  }
  return createArrayExpression(dirArgs, dir.loc)
}

function stringifyDynamicPropNames(props: string[]): string {
  let propsNamesString = `[`
  for (let i = 0, l = props.length; i < l; i++) {
    propsNamesString += JSON.stringify(props[i])
    if (i < l - 1) propsNamesString += ', '
  }
  return propsNamesString + `]`
}

function isComponentTag(tag: string) {
  return tag[0].toLowerCase() + tag.slice(1) === 'component'
}
